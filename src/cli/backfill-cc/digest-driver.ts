/**
 * Per-key `/digest` orchestration: which keys to run (resumable, `--force`
 * override), and a stall watchdog that aborts + retries a key ONCE.
 *
 * Modeled on `b3-backfill-copy/_digest_all_chat.mjs` (July driver): one key
 * at a time, log a progress line per key, never let one key's failure stop
 * the run. That driver's "stall" problem was solved by an EXTERNAL
 * PowerShell supervisor polling a log file's mtime across whole-process
 * restarts (`_digest_supervisor.ps1`) — appropriate for a 1071-minute job
 * that has to survive reboots. Here the watchdog lives IN-PROCESS instead:
 * `--stall-minutes` bounds a single `/digest` HTTP call via `AbortSignal`,
 * because per-key digest jobs here are expected to be much shorter and a
 * whole separate scheduled-task supervisor would be over-engineering for a
 * one-shot backfill run the orchestrator drives directly.
 */

export interface DigestAttemptOutcome {
  processedCount: number;
}

export interface DigestAttemptDeps {
  /** Real impl: `gateway-http.ts` `postDigest`, wired to listen on `signal`. */
  postDigestForKey: (key: string, signal: AbortSignal) => Promise<DigestAttemptOutcome>;
  /** Abort the in-flight call if no result arrives within this many ms. */
  stallMs: number;
  onProgress?: (line: string) => void;
}

interface AttemptResult {
  ok: boolean;
  processedCount: number;
  error: string | null;
}

async function attemptOnce(key: string, deps: DigestAttemptDeps): Promise<AttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.stallMs);
  // Node's setTimeout keeps the event loop alive by default; unref so a CLI
  // process can still exit promptly once the real work finishes.
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const result = await deps.postDigestForKey(key, controller.signal);
    return { ok: true, processedCount: result.processedCount, error: null };
  } catch (err) {
    return { ok: false, processedCount: 0, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export type DigestKeyStatus = "done" | "failed";

export interface DigestKeyResult {
  status: DigestKeyStatus;
  processedCount: number;
  error: string | null;
  retried: boolean;
}

/** Digest ONE key: try once, and on stall/error retry exactly once. */
export async function digestKey(key: string, deps: DigestAttemptDeps): Promise<DigestKeyResult> {
  const first = await attemptOnce(key, deps);
  if (first.ok) {
    return { status: "done", processedCount: first.processedCount, error: null, retried: false };
  }
  deps.onProgress?.(`${key}: ${first.error} — retrying once`);

  const second = await attemptOnce(key, deps);
  if (second.ok) {
    return { status: "done", processedCount: second.processedCount, error: null, retried: true };
  }
  return { status: "failed", processedCount: 0, error: second.error, retried: true };
}

/** Which keys `--digest` should attempt, honouring the resumable state file. */
export function planDigestKeys(
  allKeys: string[],
  digestState: Record<string, { status: string }>,
  force: boolean,
): string[] {
  if (force) return allKeys;
  return allKeys.filter((key) => digestState[key]?.status !== "done");
}
