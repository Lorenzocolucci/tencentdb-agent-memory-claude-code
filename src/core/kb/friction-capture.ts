/**
 * Friction capture — let Sinapsys SEE the workshop, not just hear the meeting.
 *
 * WHY THIS EXISTS
 * Until now memory only ever recorded the *chat text* between Lorenzo and the
 * agent: `readAllTurns` deliberately drops `tool_use` / `tool_result`. Measured
 * on 5 real days: 12.005 tool operations (builds, tests, commands) → 0 captured.
 * So when the agent repeated the SAME technical error across sessions, nothing
 * in memory had ever witnessed it, and the Mistake Notebook (Idea 3) — whose
 * whole job is "don't repeat that class of failure" — had no food.
 *
 * WHAT IT DOES
 * Turns a FAILED tool call into a `bug` event, which is exactly what
 * bug-clusters.ts already reads to build recurring-failure clusters. Nothing
 * else changes: successes are ignored, and a single one-off failure never
 * becomes a lesson — the existing clustering only distils a lesson when the
 * same failure recurs across ≥2 sessions (EVIDENCE_MIN / SESSION_MIN). That is
 * the north-star rule "MAI aneddoti": patterns, never anecdotes.
 *
 * SAFETY (memory must never break the conversation)
 *  - only failures are considered; everything else returns null;
 *  - the error text is secret-redacted BEFORE it is stored;
 *  - text is bounded (no giant stack traces in the graph);
 *  - identical failures are de-duplicated within a session window, so a retry
 *    loop cannot flood memory with 50 copies of the same error;
 *  - a per-session cap bounds the worst case;
 *  - the module is pure + synchronous; the caller keeps it off the critical path.
 */

import { redactSecrets } from "../../utils/redact-secrets.js";

/** Max characters of failure text kept in the event. */
const MAX_TEXT = 400;
/** Two identical failures within this window in the same session = one event. */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/** Hard cap of friction events recorded per session (flood guard). */
export const MAX_PER_SESSION = 40;

export interface ToolFailure {
  sessionKey: string;
  sessionId?: string;
  project?: string;
  toolName: string;
  /** Raw tool input (command, file path, …) — used for the signature. */
  toolInput?: unknown;
  /** Raw tool output/error text. */
  errorText?: string;
  /** Epoch ms of the failure. */
  atMs: number;
}

export interface FrictionEvent {
  type: "bug";
  text: string;
  /** Stable signature used for de-duplication and for spotting recurrence. */
  signature: string;
  /** File path involved, when the failure carries one. */
  filePath?: string;
}

/** Per-session de-dup state (owned by the caller, injected for testability). */
export interface FrictionState {
  /** signature → last recorded epoch ms. */
  lastSeen: Map<string, number>;
  /** how many friction events this session already recorded. */
  count: number;
}

export function createFrictionState(): FrictionState {
  return { lastSeen: new Map(), count: 0 };
}

/** Collapse volatile bits so the SAME failure gets the SAME signature. */
function normalizeForSignature(s: string): string {
  return s
    .toLowerCase()
    .replace(/\d+/g, "#")                        // line numbers, ports, pids, timings
    .replace(/[a-f0-9]{8,}/g, "#")               // hashes / ids
    .replace(/[\\/][^\s'"]+[\\/]/g, "/")         // path prefixes
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** First non-empty line that looks like the actual error. */
function firstErrorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /error|failed|exception|cannot|not found|refus|denied|timeout/i.test(l));
  return hit ?? lines[0] ?? "";
}

/** Extract a command/file hint from the tool input for a readable event text. */
function describeInput(toolInput: unknown): { label: string; filePath?: string } {
  if (toolInput == null) return { label: "" };
  if (typeof toolInput === "string") return { label: toolInput.slice(0, 120) };
  if (typeof toolInput === "object") {
    const o = toolInput as Record<string, unknown>;
    const cmd = typeof o.command === "string" ? o.command : undefined;
    const file = typeof o.file_path === "string" ? o.file_path : undefined;
    if (cmd) return { label: cmd.slice(0, 120), filePath: file };
    if (file) return { label: file, filePath: file };
    try { return { label: JSON.stringify(o).slice(0, 120) }; } catch { return { label: "" }; }
  }
  return { label: "" };
}

/**
 * Build the friction event for a failed tool call, or null when it must be
 * ignored (not a failure, no usable text, duplicate in window, session cap hit).
 *
 * MUTATES `state` only when it returns an event — so a rejected failure never
 * consumes the budget.
 */
export function buildFrictionEvent(
  failure: ToolFailure,
  state: FrictionState,
): FrictionEvent | null {
  if (!failure?.sessionKey || !failure.toolName) return null;
  if (state.count >= MAX_PER_SESSION) return null;

  const raw = (failure.errorText ?? "").trim();
  if (!raw) return null;

  const { label, filePath } = describeInput(failure.toolInput);
  const errLine = firstErrorLine(raw);
  if (!errLine) return null;

  const signature = `${failure.toolName}|${normalizeForSignature(label)}|${normalizeForSignature(errLine)}`;

  const prev = state.lastSeen.get(signature);
  if (prev !== undefined && failure.atMs - prev < DEDUPE_WINDOW_MS) return null;

  // Redact BEFORE storing: tool output can echo tokens, keys, connection strings.
  const safeLabel = redactSecrets(label);
  const safeErr = redactSecrets(errLine);
  const text = `${failure.toolName} failed${safeLabel ? ` on \`${safeLabel}\`` : ""}: ${safeErr}`
    .slice(0, MAX_TEXT);

  state.lastSeen.set(signature, failure.atMs);
  state.count += 1;

  return { type: "bug", text, signature, filePath };
}
