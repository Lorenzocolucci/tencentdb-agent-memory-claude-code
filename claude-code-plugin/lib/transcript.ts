/**
 * Parse cc transcript jsonl files defensively. cc's transcript format is
 * NOT a documented stable API — fields may rename across versions. This
 * module returns null on any unexpected shape rather than throwing.
 */

import { readFile } from "node:fs/promises";

export interface TranscriptEntry {
  type: "user" | "assistant" | string;
  role: string;
  content: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
}

export interface Turn {
  user: string;
  assistant: string;
}

/**
 * Parse a single JSONL line. Returns null on malformed or unrecognized shape.
 */
export function parseTranscriptLine(line: string): TranscriptEntry | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const type = typeof o.type === "string" ? o.type : null;
  if (!type) return null;

  const message = o.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return null;

  const role = typeof message.role === "string" ? message.role : type;

  const content = extractContent(message.content);
  if (content === null) return null;

  return {
    type,
    role,
    content,
    uuid: typeof o.uuid === "string" ? o.uuid : undefined,
    parentUuid: typeof o.parentUuid === "string" ? o.parentUuid : undefined,
    timestamp: typeof o.timestamp === "string" ? o.timestamp : undefined,
  };
}

function extractContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (typeof it.text === "string") parts.push(it.text);
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

/**
 * Read the latest complete user+assistant turn from a transcript jsonl file.
 * Returns null if the file is missing, empty, or contains no complete turn.
 */
export async function readLatestTurn(path: string): Promise<Turn | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  // Walk from the end backwards looking for assistant then user.
  let assistant: string | null = null;
  let user: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseTranscriptLine(lines[i]);
    if (!entry) continue;
    if (assistant === null && entry.role === "assistant") {
      assistant = entry.content;
      continue;
    }
    if (assistant !== null && user === null && entry.role === "user") {
      user = entry.content;
      break;
    }
  }
  if (user === null || assistant === null) return null;
  return { user, assistant };
}
