/**
 * Streaming brace-depth scanner for claude.ai chat export.
 *
 * The export file is a JSON array of conversation objects (~391 MB).
 * Loading the whole file with JSON.parse would consume ~1-2 GB of RAM;
 * instead we stream it in 64 KB chunks and track brace depth to emit
 * one complete JSON object at a time.
 *
 * Design constraints:
 * - No full-file JSON.parse
 * - One conversation object held in memory at a time
 * - Correctly handles nested braces inside string literals
 * - Yields ParsedConversation objects in file order
 */

import fs from "node:fs";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * A single element inside the `content` array of an ExportMessage.
 * The real text lives here when type === "text".
 * Other types (tool_use, tool_result, thinking, token_budget) are ignored
 * for message-body extraction.
 *
 * Verified shape from real export data (2026-06-25 probe):
 *   { type: string, text: string, start_timestamp, stop_timestamp, flags, citations }
 */
export interface ContentElement {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ExportMessage {
  uuid: string;
  sender: "human" | "assistant" | string;
  text: string;
  created_at: string;
  /** Present on some messages; real body when text is empty. */
  content?: ContentElement[] | null;
}

export interface ExportConversation {
  uuid: string;
  name: string;
  created_at: string;
  chat_messages: ExportMessage[];
}

// ── Message-text extraction ───────────────────────────────────────────────────

/**
 * Extract the body text from a message, with content-array fallback.
 *
 * Priority:
 *  1. msg.text — use if non-empty after trim
 *  2. msg.content — concatenate `.text` of all type="text" elements (in order)
 *  3. Empty string — when both sources yield nothing
 *
 * Content element shape (verified from real export 2026-06-25):
 *   { type: "text", text: string, ... }   → contributes to body
 *   { type: "tool_use" | "thinking" | ... } → ignored
 *
 * Defensive: handles missing/null content, missing el.text, non-string values.
 */
export function extractMessageText(
  msg: Pick<ExportMessage, "text" | "content">,
): string {
  const direct = typeof msg.text === "string" ? msg.text.trim() : "";
  if (direct.length > 0) return direct;

  if (!Array.isArray(msg.content)) return "";

  const parts: string[] = [];
  for (const el of msg.content) {
    if (
      el !== null &&
      typeof el === "object" &&
      el.type === "text" &&
      typeof el.text === "string" &&
      el.text.length > 0
    ) {
      parts.push(el.text);
    }
  }
  return parts.join("");
}

/**
 * Returns true when a conversation has no ingestable messages.
 * A conversation is fully-empty when every message yields empty text after
 * applying the content-array fallback.
 */
export function isConversationEmpty(conv: ExportConversation): boolean {
  if (!Array.isArray(conv.chat_messages) || conv.chat_messages.length === 0) {
    return true;
  }
  return conv.chat_messages.every(
    (msg) => extractMessageText(msg).length === 0,
  );
}

// ── Timestamp helper ─────────────────────────────────────────────────────────

/**
 * Convert a created_at string from the export to epoch milliseconds.
 * Falls back to Date.now() for unparseable values so the CLI never crashes.
 */
export function mapTimestamp(createdAt: string): number {
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) && ms > 0 ? ms : Date.now();
}

// ── Brace-depth streamer ─────────────────────────────────────────────────────

const CHUNK_SIZE = 65_536; // 64 KB read chunks

/**
 * Async generator that streams conversations one at a time from the export file.
 * Uses a brace-depth scan to find object boundaries without loading the full JSON.
 *
 * Algorithm:
 *  - Read file in CHUNK_SIZE buffers
 *  - Track brace depth, aware of JSON string literals (skip braces inside strings)
 *  - When depth hits 0 after being > 0, we have a complete top-level object
 *  - Parse that object with JSON.parse and yield it
 *
 * @throws if the file cannot be opened (caller decides how to handle)
 */
export async function* streamConversations(
  filePath: string,
): AsyncGenerator<ExportConversation> {
  const fd = fs.openSync(filePath, "r");
  try {
    yield* _streamFromFd(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function* _streamFromFd(
  fd: number,
): AsyncGenerator<ExportConversation> {
  const buffer = Buffer.alloc(CHUNK_SIZE);

  let accumulated = "";   // current object being assembled
  let depth = 0;          // brace depth
  let inString = false;   // inside a JSON string
  let escaped = false;    // previous char was backslash
  let started = false;    // encountered the first `{` of a top-level object

  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, null);
    if (bytesRead === 0) break;

    const chunk = buffer.subarray(0, bytesRead).toString("utf-8");

    for (const ch of chunk) {
      if (escaped) {
        escaped = false;
        if (started) accumulated += ch;
        continue;
      }

      if (ch === "\\" && inString) {
        escaped = true;
        if (started) accumulated += ch;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        if (started) accumulated += ch;
        continue;
      }

      // Outside a string: only braces affect depth
      if (!inString) {
        if (ch === "{") {
          depth++;
          started = true;
          accumulated += ch;
        } else if (ch === "}") {
          if (started) {
            accumulated += ch;
            depth--;
            if (depth === 0) {
              // Complete top-level object
              const parsed = tryParseConversation(accumulated);
              accumulated = "";
              started = false;
              if (parsed !== null) {
                yield parsed;
              }
            }
          }
        } else if (started) {
          accumulated += ch;
        }
        // Characters outside any object (commas, whitespace, `[`, `]`) are ignored
      } else {
        // Inside string: accumulate verbatim
        if (started) accumulated += ch;
      }
    }
  }
}

/**
 * Parse a raw JSON string as ExportConversation.
 * Returns null (never throws) if the string is malformed or missing required fields.
 */
function tryParseConversation(raw: string): ExportConversation | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof obj.uuid !== "string" ||
      typeof obj.created_at !== "string" ||
      !Array.isArray(obj.chat_messages)
    ) {
      return null;
    }
    return obj as unknown as ExportConversation;
  } catch {
    return null;
  }
}
