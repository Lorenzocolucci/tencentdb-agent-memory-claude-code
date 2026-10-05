/**
 * Tool-behaviour lessons: the Mistake Notebook speaking at the moment Claude Code
 * repeats a mistake.
 *
 * Measured live 05/10/2026: 62 lessons, exposure_count 0 for every one. Most are
 * rules about HOW the agent uses its tools ("read before Edit", "select a Render
 * workspace first", "do not sleep past the Bash timeout"), distilled from failures
 * recorded as "<Tool> failed on `<input>`: <error>". Their trigger_pattern is empty,
 * so the PreToolUse matcher could never fire them — and the same session hit the
 * very error a 32-evidence lesson describes (Bash `sleep 600` → Exit code 143).
 *
 * Each lesson learns its trigger from its own evidence: which tools failed, with
 * which error, after which Bash command head. Tool behaviour is the same in every
 * project, so these lessons are not project-scoped.
 *
 * Pure; the matcher (pretool-match.ts) owns indexing, dedup and counters.
 */

import { commandHeadOfRaw } from "./pretool-match.js";

/** A phrase / command head / tool must recur this often in the evidence to count. */
export const MIN_RECURRENCE = 2;
/** Without any error phrase, a tool that failed this often still triggers on failure. */
export const TOOL_ONLY_MIN = 5;
/** An external (MCP) tool that failed this often warns BEFORE its first use in a session. */
export const PRE_MCP_MIN = 3;
const PHRASE_CHARS = 60;

export interface ToolLesson {
  id: string;
  domain: string;
  text: string;
  evidenceCount: number;
  /** Tool names seen failing in the evidence (≥ MIN_RECURRENCE). */
  tools: string[];
  /** Normalized error phrases (≥ MIN_RECURRENCE). */
  errorPhrases: string[];
  /** Bash command heads (≥ MIN_RECURRENCE). */
  commandHeads: string[];
  /** Tools that trigger on ANY failure (no phrase learned, failed ≥ TOOL_ONLY_MIN). */
  toolOnly: string[];
  /** MCP tools worth a warning before use (failed ≥ PRE_MCP_MIN). */
  preTools: string[];
  /** One real past failure behind the lesson — concrete beats the distilled rule. */
  example: string;
}

export interface FrictionParts {
  tool: string;
  input: string;
  error: string;
}

/** "<Tool> failed on `<input>`: <error>" (optionally "[backfill] "-prefixed), else null. */
export function parseFriction(text: string): FrictionParts | null {
  const m = text.match(/^(?:\[backfill\]\s*)?([\w.:-]+) failed on `([\s\S]*?)`(?::\s*([\s\S]*))?$/);
  if (!m) return null;
  return { tool: m[1]!, input: m[2] ?? "", error: (m[3] ?? "").trim() };
}

/**
 * Comparable form of an error message: tags stripped, lowercase, long numbers (ids,
 * timestamps) masked — short codes like 143 vs 127 stay distinct — first sentence,
 * bounded. "" when too short to mean anything.
 */
export function errorPhrase(error: string): string {
  const t = maskPaths(error.replace(/<\/?[\w_-]+>/g, " ").toLowerCase())
    .replace(/\d{4,}/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = (t.split(/(?<=[.!?])\s/)[0] ?? t).slice(0, PHRASE_CHARS).trim();
  return sentence.length >= 8 ? sentence : "";
}

/**
 * Paths vary per worktree/temp dir while the error is the same: live 05/10/2026
 * "This agent is isolated in the worktree C:\…\agent-ab99…" never recurred as a phrase.
 */
export function maskPaths(t: string): string {
  return t
    .replace(/[a-z]:[\\/][^\s,;'"`)]*/gi, "<path>")
    .replace(/(?<![\w.])\/(?:[\w.-]+\/)+[\w.-]*/g, "<path>");
}

/**
 * A phrase that says nothing on its own: an application exit code (< 124 — each
 * program picks its own meaning; ≥ 124 are shell/system defined: timeout, not
 * executable, not found, killed by signal) or the shared prefix of every hook
 * block. Measured live: "exit code 1" and "exit code 143" are each ~10% of Bash
 * failures, but only 143 (killed: the Bash timeout) means one thing.
 * A weak phrase triggers only together with the same command head.
 */
export function isWeakPhrase(p: string): boolean {
  const code = p.match(/^exit code (\d+)$/);
  // 128 is git's generic "fatal" (not a signal: those are 129+), as vague as an application code.
  if (code) return Number(code[1]) < 124 || Number(code[1]) === 128;
  return /^pre ?tool ?use:\S* hook error/.test(p);
}

/** `p` occurs in `text` as a whole phrase ("exit code 1" is not in "exit code 128"). */
export function containsPhrase(text: string, p: string): boolean {
  for (let i = text.indexOf(p); i >= 0; i = text.indexOf(p, i + 1)) {
    const next = text[i + p.length];
    if (next === undefined || !/[a-z0-9]/.test(next)) return true;
  }
  return false;
}

/**
 * The user saying no is not a tool mistake: live 05/10/2026 a lesson learned the phrase
 * "the user doesn't want to proceed with this tool use." and would have lectured the
 * agent after every denied command.
 */
export function isUserDenial(error: string): boolean {
  return /the user doesn't want to proceed|user rejected|user denied|permission denied by user/i.test(error);
}

const recurring = (counts: Map<string, number>, min: number): string[] =>
  [...counts].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).map(([k]) => k);

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** The trigger a lesson learns from its evidence texts, or null when none is tool-shaped. */
export function learnToolLesson(
  lesson: { id: string; domain: string; text: string; evidenceCount: number },
  evidenceTexts: readonly string[],
): ToolLesson | null {
  const tools = new Map<string, number>();
  const phrases = new Map<string, number>();
  const heads = new Map<string, number>();
  const parsed: FrictionParts[] = [];
  for (const t of evidenceTexts) {
    const f = parseFriction(t);
    if (!f || isUserDenial(f.error)) continue;
    parsed.push(f);
    bump(tools, f.tool);
    const p = errorPhrase(f.error);
    if (p) bump(phrases, p);
    if (f.tool === "Bash") {
      const h = commandHeadOfRaw(f.input);
      if (h) bump(heads, h);
    }
  }
  const recurringTools = recurring(tools, MIN_RECURRENCE);
  if (recurringTools.length === 0) return null;
  const errorPhrases = recurring(phrases, MIN_RECURRENCE);
  const top = errorPhrases[0];
  const ex = parsed.find((f) => (top ? errorPhrase(f.error) === top : f.tool === recurringTools[0])) ?? parsed[0]!;
  const example = `${ex.tool} \`${ex.input.replace(/\s+/g, " ").slice(0, 80)}\` → ${ex.error.replace(/<\/?[\w_-]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 80)}`;
  return {
    ...lesson,
    tools: recurringTools,
    errorPhrases,
    commandHeads: recurring(heads, MIN_RECURRENCE),
    toolOnly: errorPhrases.length === 0 ? recurring(tools, TOOL_ONLY_MIN) : [],
    preTools: recurring(tools, PRE_MCP_MIN).filter((t) => t.startsWith("mcp__")),
    example,
  };
}

export interface ToolCall {
  phase: "pre" | "failure";
  toolName: string;
  /** Raw Bash command, when the tool is Bash. */
  command?: string;
  errorText?: string;
}

/** Why this lesson speaks for this call, or null. */
function reason(l: ToolLesson, call: ToolCall): string | null {
  if (!l.tools.includes(call.toolName)) return null;
  const head = call.toolName === "Bash" && call.command ? commandHeadOfRaw(call.command) : null;
  const sameCommand = !!head && l.commandHeads.includes(head);
  if (call.phase === "failure") {
    if (isUserDenial(call.errorText ?? "")) return null;
    const err = errorPhrase(call.errorText ?? "");
    const raw = (call.errorText ?? "").toLowerCase().replace(/\d{4,}/g, "#").replace(/\s+/g, " ");
    const hit = l.errorPhrases.find((p) => containsPhrase(err, p) || containsPhrase(raw, p));
    if (hit && (!isWeakPhrase(hit) || sameCommand)) return "same error";
    if (l.toolOnly.includes(call.toolName)) return "same tool failing";
    return null;
  }
  if (call.toolName === "Bash") return sameCommand ? "same command" : null;
  return l.preTools.includes(call.toolName) ? "tool that keeps failing" : null;
}

/** The text the agent sees. */
export function renderToolLesson(l: ToolLesson, why: string): string {
  return (
    `Memory lesson (${why}; this has happened ${l.evidenceCount}× before, ${l.domain}): ${l.text.replace(/\s+/g, " ").trim()} ` +
    `Past example: ${l.example}. (lesson id ${l.id})`
  );
}

/** The strongest lesson for this tool call (most evidence first), or null. */
export function matchToolLesson(lessons: readonly ToolLesson[], call: ToolCall): { lesson: ToolLesson; why: string } | null {
  let best: { lesson: ToolLesson; why: string } | null = null;
  for (const l of lessons) {
    const why = reason(l, call);
    if (why && (!best || l.evidenceCount > best.lesson.evidenceCount)) best = { lesson: l, why };
  }
  return best;
}
