/**
 * Repeat guard: the same tool error twice in one session gets said out loud.
 *
 * Measured live 05/10/2026: 19 of 26 tool failures in one hour were the same error
 * ("This agent is isolated in the worktree …"), up to 7 times in a row in one session,
 * and memory said nothing — distilled lessons take hours to appear, and the error text
 * carried a different worktree path each time. Lorenzo: Code repeats the same mistakes
 * over and over, even inside a single session; this is where memory must make the
 * difference.
 *
 * Deterministic, in-memory, no LLM: an error key = tool + normalized error phrase
 * (paths and long numbers masked) + the command head when the phrase alone is weak
 * (application exit codes, bare exception names). It speaks on the 2nd, 4th, 8th…
 * occurrence in a session, so it reminds without nagging. A matched lesson (which carries the fix) wins over it.
 */

import { commandHeadOfRaw } from "./pretool-match.js";
import { errorPhrase, isUserDenial, isWeakPhrase } from "./tool-lessons.js";

const MAX_SESSIONS = 200;
const MAX_KEYS_PER_SESSION = 100;
const MAX_INPUT_CHARS = 100;

interface Seen {
  count: number;
  lastInput: string;
}

export interface FailedCall {
  sessionKey: string;
  toolName: string;
  toolInput: unknown;
  errorText?: string;
}

function inputLabel(toolName: string, toolInput: unknown): string {
  if (toolInput && typeof toolInput === "object") {
    const o = toolInput as Record<string, unknown>;
    const v = typeof o.command === "string" ? o.command : typeof o.file_path === "string" ? o.file_path : undefined;
    if (v) return v.replace(/\s+/g, " ").trim().slice(0, MAX_INPUT_CHARS);
  }
  try {
    return (JSON.stringify(toolInput) ?? "").slice(0, MAX_INPUT_CHARS);
  } catch {
    return toolName;
  }
}

/** The key two failures share when they are "the same mistake", or null when there is none. */
export function errorKey(call: FailedCall): { key: string; phrase: string } | null {
  const err = call.errorText ?? "";
  if (err.trim() === "" || isUserDenial(err)) return null;
  const phrase = errorPhrase(err);
  if (phrase === "") return null;
  let head = "";
  // A bare exception name ("assertionerror", "raise valueerror(") is as vague as an exit code.
  if (isWeakPhrase(phrase) || phrase.split(" ").length <= 2) {
    const command = (call.toolInput as { command?: unknown } | null)?.command;
    head = call.toolName === "Bash" && typeof command === "string" ? commandHeadOfRaw(command) ?? "" : "";
    if (head === "") return null; // "exit code 1" from two different commands is not a repeat
  }
  return { key: `${call.toolName}|${phrase}|${head}`, phrase };
}

const ordinal = (n: number): string => (n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

export class RepeatGuard {
  /** Insertion-ordered: the oldest session is evicted first. */
  private readonly sessions = new Map<string, Map<string, Seen>>();

  /** Record a failure; the reminder text when this repeat is worth saying, else null. */
  note(call: FailedCall): string | null {
    const k = errorKey(call);
    if (!k) return null;
    let seen = this.sessions.get(call.sessionKey);
    if (!seen) {
      if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
      seen = new Map();
      this.sessions.set(call.sessionKey, seen);
    }
    const prev = seen.get(k.key);
    const input = inputLabel(call.toolName, call.toolInput);
    if (!prev) {
      if (seen.size < MAX_KEYS_PER_SESSION) seen.set(k.key, { count: 1, lastInput: input });
      return null;
    }
    const count = prev.count + 1;
    seen.set(k.key, { count, lastInput: input });
    if ((count & (count - 1)) !== 0) return null; // speak on 2, 4, 8, …
    return (
      `Memory (repeat guard): this is the ${ordinal(count)} time in this session that ${call.toolName} fails with ` +
      `"${k.phrase}". Previous attempt: \`${prev.lastInput}\`. Retrying the same way will fail again — ` +
      `read the whole error message and change approach.`
    );
  }
}
