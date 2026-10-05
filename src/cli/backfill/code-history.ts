/**
 * Claude Code history → ExportConversation, for the same ingestor the claude.ai
 * chat backfill uses (real timestamps, idempotent by message uuid).
 *
 * Two sources on this machine (surveyed 05/10/2026):
 *  - `~/.claude/history.jsonl`: every prompt Lorenzo typed, 27/09/2025 → 29/06/2026
 *    (4,899 lines), prompts only — Claude Code never stored the answers there.
 *    One conversation per (project, UTC day).
 *  - `~/.claude/projects/<dir>/<session>.jsonl`: full transcripts, kept only 30
 *    days by Claude Code. Turns the live Stop hook never captured are imported;
 *    turn boundaries match the plugin's `readAllTurns`, so the plugin's cursor
 *    (turns already captured) tells exactly which ones to skip.
 */

import crypto from "node:crypto";
import type { ExportConversation, ExportMessage } from "./chat-export-streamer.js";

/** Pasted blobs (logs, docs) are kept but bounded: memory needs the gist, not the dump. */
export const MAX_PASTED_CHARS = 4000;
/** One turn's text is bounded the same way the live capture bounds a message. */
export const MAX_MESSAGE_CHARS = 12000;

const sha = (s: string, n = 16): string => crypto.createHash("sha1").update(s).digest("hex").slice(0, n);

export interface HistoryLine {
  display?: unknown;
  pastedContents?: unknown;
  timestamp?: unknown;
  project?: unknown;
}

export interface CodeConversation extends ExportConversation {
  /** Working directory the messages were typed in (resolves the project). */
  cwd: string;
}

/** The text of a history entry: the prompt plus its pasted contents, bounded. */
export function historyText(h: HistoryLine): string {
  const parts: string[] = [];
  if (typeof h.display === "string" && h.display.trim() !== "") parts.push(h.display.trim());
  if (h.pastedContents && typeof h.pastedContents === "object") {
    for (const v of Object.values(h.pastedContents as Record<string, unknown>)) {
      const c = (v as { content?: unknown } | null)?.content;
      if (typeof c === "string" && c.trim() !== "") parts.push(c.trim().slice(0, MAX_PASTED_CHARS));
    }
  }
  return parts.join("\n\n").slice(0, MAX_MESSAGE_CHARS);
}

/** Group history lines into one conversation per (project, UTC day), oldest first. */
export function historyToConversations(lines: readonly string[]): CodeConversation[] {
  const groups = new Map<string, CodeConversation>();
  for (const line of lines) {
    let h: HistoryLine;
    try {
      h = JSON.parse(line) as HistoryLine;
    } catch {
      continue;
    }
    const ts = typeof h.timestamp === "number" ? h.timestamp : NaN;
    const cwd = typeof h.project === "string" ? h.project : "";
    const text = historyText(h);
    if (!Number.isFinite(ts) || ts <= 0 || cwd === "" || text === "") continue;
    const iso = new Date(ts).toISOString();
    const key = `${cwd.toLowerCase()}|${iso.slice(0, 10)}`;
    let conv = groups.get(key);
    if (!conv) {
      conv = { uuid: `h${sha(key)}`, name: `${cwd} ${iso.slice(0, 10)}`, created_at: iso, cwd, chat_messages: [] };
      groups.set(key, conv);
    }
    const msg: ExportMessage = { uuid: `hist:${sha(`${ts}|${cwd}|${text}`, 24)}`, sender: "human", text, created_at: iso };
    conv.chat_messages.push(msg);
  }
  const out = [...groups.values()];
  for (const c of out) c.chat_messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export interface TimedTurn {
  user: string;
  assistant: string;
  userAt: string;
  assistantAt: string;
}

/**
 * All complete turns of a transcript with their timestamps. Same boundaries as the
 * plugin's `readAllTurns`: a turn starts at a user entry whose content is a STRING
 * (array content is a tool result or attachment) and collects the assistant text
 * until the next one.
 */
export function transcriptTurns(lines: readonly string[]): TimedTurn[] {
  const turns: TimedTurn[] = [];
  let user: { text: string; at: string } | null = null;
  let parts: string[] = [];
  let lastAt = "";
  const flush = () => {
    if (user && parts.length > 0) {
      turns.push({ user: user.text, assistant: parts.join("\n\n"), userAt: user.at, assistantAt: lastAt || user.at });
    }
  };
  for (const line of lines) {
    let o: { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o?.message;
    if (!m || typeof m !== "object" || typeof o.type !== "string") continue;
    const role = typeof m.role === "string" ? m.role : o.type;
    const at = typeof o.timestamp === "string" ? o.timestamp : "";
    if (role === "user" && typeof m.content === "string") {
      flush();
      user = { text: m.content, at };
      parts = [];
      lastAt = at;
    } else if (role === "assistant") {
      const text = assistantText(m.content);
      if (text) {
        parts.push(text);
        if (at) lastAt = at;
      }
    }
  }
  flush();
  return turns;
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((it) => (it && typeof it === "object" && typeof (it as { text?: unknown }).text === "string" ? (it as { text: string }).text : ""))
    .filter((t) => t !== "")
    .join("\n");
}

/** The turns at index >= skipTurns of one session, as a conversation (null when none). */
export function transcriptToConversation(
  sessionId: string,
  cwd: string,
  lines: readonly string[],
  skipTurns: number,
): CodeConversation | null {
  const turns = transcriptTurns(lines).slice(Math.max(0, skipTurns));
  const messages: ExportMessage[] = [];
  turns.forEach((t, i) => {
    const n = skipTurns + i;
    if (!t.userAt) return; // no timestamp → cannot be dated honestly
    messages.push({ uuid: `cc:${sessionId}:${n}:u`, sender: "human", text: t.user.slice(0, MAX_MESSAGE_CHARS), created_at: t.userAt });
    messages.push({ uuid: `cc:${sessionId}:${n}:a`, sender: "assistant", text: t.assistant.slice(0, MAX_MESSAGE_CHARS), created_at: t.assistantAt });
  });
  if (messages.length === 0) return null;
  return { uuid: sessionId, name: `${cwd} ${sessionId}`, created_at: messages[0]!.created_at, cwd, chat_messages: messages };
}
