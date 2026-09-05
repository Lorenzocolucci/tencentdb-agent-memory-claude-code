/**
 * Pure replay loop for ONE transcript: call the (injected) hook invocation,
 * then re-check the (injected) cursor, repeating until either
 *  - the cursor reaches the known turn count (done), or
 *  - the hook invocation itself fails (stop — do not spin on a broken hook), or
 *  - `maxIterations` is reached (cap, default 20 per the task spec).
 *
 * WHY POLL THE CURSOR INSTEAD OF PARSING `hook.log`
 * ---------------------------------------------------
 * The task describes the stop condition as "the hook log line says no new
 * turns or the cursor reaches the turn count". Both signals exist because the
 * REAL hook.mjs writes a `hook.log` line either way (`hook.ts:317-320,
 * :382-386`) — but that line's wording is Italian prose meant for a human
 * ("stop: nessun turno nuovo (...)" / "stop: salvati N messaggi..."),
 * not a stable machine contract, and it is shared across ALL Stop hook
 * invocations on the box (every real Claude Code session writes to the same
 * file), so grepping it for OUR invocation is a race. The cursor file is
 * per-session, authoritative (it is literally what `handleStop` writes right
 * before logging), and already how this same repo's `recover-sessions.mts`
 * decides completion. Reading it after each call is equivalent and simpler.
 *
 * This module knows nothing about `child_process` or the filesystem — both
 * come in as injected async functions so it is fully unit-testable.
 */

export type HookInvocationResult = { ok: true } | { ok: false; error: string };

export interface ReplayLoopParams {
  /** Turn count computed during classification (the target the cursor must reach). */
  turns: number;
  /** Cursor value BEFORE this loop starts (from the classification pass), or null. */
  cursorBefore: number | null;
  /** Spawns `node <hook> stop` once with the transcript's stdin payload. */
  invokeHook: () => Promise<HookInvocationResult>;
  /** Re-reads the cursor file after an invocation. */
  getCursorTurns: () => Promise<number | null>;
  /** Cap on hook invocations for this transcript (default 20, per spec). */
  maxIterations?: number;
  /** Called between iterations (real impl: `setTimeout`, tests: no-op/instant). */
  pace: () => Promise<void>;
}

export type ReplayLoopStatus = "replayed" | "partial" | "failed";

export interface ReplayLoopResult {
  status: ReplayLoopStatus;
  iterations: number;
  turnsSentBefore: number;
  turnsSentAfter: number;
  lastError: string | null;
}

const DEFAULT_MAX_ITERATIONS = 20;

export async function replayTranscript(params: ReplayLoopParams): Promise<ReplayLoopResult> {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const turnsSentBefore = params.cursorBefore ?? 0;

  // A transcript with 0 readable turns has nothing to send; do not spawn the
  // hook at all (it would itself no-op, but this saves a process + keeps the
  // ledger honest about why nothing happened).
  if (params.turns === 0) {
    return { status: "replayed", iterations: 0, turnsSentBefore, turnsSentAfter: turnsSentBefore, lastError: null };
  }
  if (turnsSentBefore >= params.turns) {
    return { status: "replayed", iterations: 0, turnsSentBefore, turnsSentAfter: turnsSentBefore, lastError: null };
  }

  let lastCursor = turnsSentBefore;
  let lastError: string | null = null;

  for (let i = 1; i <= maxIterations; i++) {
    const result = await params.invokeHook();
    if (!result.ok) {
      lastError = result.error;
      return { status: "failed", iterations: i, turnsSentBefore, turnsSentAfter: lastCursor, lastError };
    }

    const cursor = await params.getCursorTurns();
    lastCursor = cursor ?? lastCursor;

    if (lastCursor >= params.turns) {
      return { status: "replayed", iterations: i, turnsSentBefore, turnsSentAfter: lastCursor, lastError: null };
    }

    if (i < maxIterations) await params.pace();
  }

  return {
    status: "partial",
    iterations: maxIterations,
    turnsSentBefore,
    turnsSentAfter: lastCursor,
    lastError: `cursor stuck at ${lastCursor}/${params.turns} after ${maxIterations} iterations`,
  };
}
