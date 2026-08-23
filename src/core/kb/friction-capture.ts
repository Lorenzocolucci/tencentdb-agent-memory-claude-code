/**
 * Friction capture — let Sinapsys SEE the workshop, not just hear the meeting.
 *
 * WHY THIS EXISTS
 * Until now memory only ever recorded the *chat text* between Lorenzo and the
 * agent: `readAllTurns` deliberately drops `tool_use` / `tool_result`. Measured
 * on 5 real days: 12.005 tool operations (builds, tests, commands) → 0 captured.
 * So when the agent repeated the SAME technical error, nothing in memory had
 * ever witnessed it, and the Mistake Notebook (Idea 3) had no food.
 *
 * TWO DISTINCT PHENOMENA (this is the key design point)
 *
 *  1. CROSS-SESSION RECURRENCE — "you keep making this mistake over weeks".
 *     Handled by the existing clustering (EVIDENCE_MIN=2 bugs across
 *     SESSION_MIN=2 distinct sessions) → distilled into a lesson. Slow, durable,
 *     "patterns never anecdotes".
 *
 *  2. INTRA-SESSION LOOP — "you are stuck RIGHT NOW, same failure 5 times in a
 *     row". Lorenzo's correction (2026-08-07), and he was right: the clustering
 *     REQUIRES ≥2 distinct sessions (bug-cluster-graph.ts:106), so a loop inside
 *     ONE session produced no lesson at all — and worse, a naive dedupe silently
 *     swallowed the repeats. Measured on the real transcripts: 38 sessions
 *     contained such a loop, one repeating the SAME failure 29 times.
 *
 *     A loop must not wait weeks for a lesson: it must interrupt the agent while
 *     it is happening. So repeats are COUNTED (not dropped), and at the loop
 *     threshold we emit both a memory event carrying the repeat count AND a
 *     warning the caller injects straight back into the turn.
 *
 * SAFETY (memory must never break the conversation)
 *  - only failures are considered; everything else returns null;
 *  - the error text is secret-redacted BEFORE it is stored;
 *  - text is bounded (no giant stack traces in the graph);
 *  - a per-session cap bounds the worst case;
 *  - pure + synchronous; the caller keeps it off the critical path.
 */

import { redactSecrets } from "../../utils/redact-secrets.js";

/** Max characters of failure text kept in the event. */
const MAX_TEXT = 400;
/** Two identical failures within this window count as the same episode. */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/** Hard cap of friction events recorded per session (flood guard). */
export const MAX_PER_SESSION = 40;
/**
 * Repeats of the SAME failure inside one session that constitute a loop.
 * 3 = "twice could be bad luck, three times is a pattern you are not seeing".
 */
export const LOOP_THRESHOLD = 3;
/**
 * After the loop fires, re-fire every N further repeats (so a 29× thrash keeps
 * nagging without emitting 29 events).
 */
export const LOOP_REFIRE_EVERY = 3;

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
  /** Stable signature used for repeat detection and cross-session clustering. */
  signature: string;
  /** File path involved, when the failure carries one. */
  filePath?: string;
  /** How many times this exact failure has occurred in this session so far. */
  repeatCount: number;
  /** True when this event is an intra-session LOOP (repeatCount ≥ threshold). */
  isLoop: boolean;
  /** Warning to inject back into the turn — set only for loops. */
  warning?: string;
}

/** Per-session repeat counters + flood budget (owned by the caller). */
export interface FrictionState {
  /** signature → { count, lastMs } for this session. */
  seen: Map<string, { count: number; lastMs: number }>;
  /** how many friction events this session already recorded. */
  count: number;
}

export function createFrictionState(): FrictionState {
  return { seen: new Map(), count: 0 };
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
 * Decide what to do with a failed tool call.
 *
 * Returns null when the failure must be ignored (not a failure, no usable text,
 * a plain repeat that is not yet a loop, or the session cap is hit). Returns an
 * event when it is either the FIRST occurrence of a failure or an intra-session
 * LOOP milestone.
 *
 * MUTATES `state` (repeat counters always; the budget only when it emits) — so a
 * swallowed repeat still advances the counter that eventually detects the loop.
 */
export function buildFrictionEvent(
  failure: ToolFailure,
  state: FrictionState,
): FrictionEvent | null {
  if (!failure?.sessionKey || !failure.toolName) return null;

  const raw = (failure.errorText ?? "").trim();
  if (!raw) return null;

  const { label, filePath } = describeInput(failure.toolInput);
  const errLine = firstErrorLine(raw);
  if (!errLine) return null;

  const signature = `${failure.toolName}|${normalizeForSignature(label)}|${normalizeForSignature(errLine)}`;

  const prev = state.seen.get(signature);
  const withinWindow = prev !== undefined && failure.atMs - prev.lastMs < DEDUPE_WINDOW_MS;
  // Repeats INSIDE the window build the loop counter; a failure returning after
  // a long gap starts a fresh episode (it is a recurrence, not a thrash).
  const repeatCount = prev === undefined ? 1 : withinWindow ? prev.count + 1 : 1;
  state.seen.set(signature, { count: repeatCount, lastMs: failure.atMs });

  const isFirst = repeatCount === 1;
  const isLoopMilestone =
    repeatCount === LOOP_THRESHOLD ||
    (repeatCount > LOOP_THRESHOLD && (repeatCount - LOOP_THRESHOLD) % LOOP_REFIRE_EVERY === 0);

  if (!isFirst && !isLoopMilestone) return null;
  if (state.count >= MAX_PER_SESSION) return null;

  // Redact BEFORE storing: tool output can echo tokens, keys, connection strings.
  const safeLabel = redactSecrets(label);
  const safeErr = redactSecrets(errLine);

  const base = `${failure.toolName} failed${safeLabel ? ` on \`${safeLabel}\`` : ""}: ${safeErr}`;
  const text = (
    isLoopMilestone
      ? `LOOP (${repeatCount}x in one session) — ${base}`
      : base
  ).slice(0, MAX_TEXT);

  state.count += 1;

  return {
    type: "bug",
    text,
    signature,
    filePath,
    repeatCount,
    isLoop: isLoopMilestone,
    warning: isLoopMilestone
      ? `⚠️ Stesso fallimento ${repeatCount} volte in questa sessione: ${safeErr.slice(0, 160)}\n` +
        `Fermati: rileggere lo stato reale prima di ritentare, oppure cambia approccio. ` +
        `Ritentare uguale una ${repeatCount + 1}ª volta non funzionerà.`
      : undefined,
  };
}
