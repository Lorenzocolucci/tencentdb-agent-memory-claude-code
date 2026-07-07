/**
 * Fire-and-forget scheduler for the deterministic consolidation pass.
 *
 * This is the policy seam between {@link runConsolidation} (pure, sync, fully
 * unit-tested) and the session-end hook. Consolidation must never sit on the
 * critical path, so the (synchronous) pass is deferred to a macrotask via
 * ``setImmediate``: the caller's HTTP response is flushed BEFORE the sweep runs.
 *
 * The in-flight task is registered with the caller (TdaiCore's ``bgTasks`` set)
 * so a shutdown drain can await it before closing the DB, and removed again
 * when the pass completes.
 *
 * Memory must never break the conversation: a failing pass is logged and
 * swallowed — it never rejects, never throws.
 */

import type { ConsolidationStats } from "./consolidation-runner.js";
import { beginHeavyTask, endHeavyTask } from "../diagnostics/inflight-registry.js";

/** Parameters one consolidation pass needs (mirrors RunConsolidationParams). */
export interface ConsolidateSessionParams {
  sessionKey: string;
  now: string;
  staleAfterMs?: number;
  namespace?: string;
}

/**
 * The slice of the memory store the scheduler depends on. Backends that cannot
 * consolidate (e.g. the TCVDB backend) simply omit ``consolidateSession`` and
 * the scheduler no-ops.
 */
export interface ConsolidatableStore {
  consolidateSession?(params: ConsolidateSessionParams): ConsolidationStats;
  isDegraded?(): boolean;
}

/** Minimal logger surface (a subset of the core Logger). */
export interface ConsolidationSchedulerLogger {
  debug?: (message: string) => void;
  warn: (message: string) => void;
}

const TAG = "[memory-tdai] [consolidation]";

export interface ScheduleConsolidationOptions {
  store: ConsolidatableStore | undefined;
  sessionKey: string;
  now: string;
  staleAfterMs?: number;
  /** Register the in-flight task so a shutdown drain can await it. */
  register?: (task: Promise<void>) => void;
  /** Remove the task once it completes. */
  unregister?: (task: Promise<void>) => void;
  logger?: ConsolidationSchedulerLogger;
}

/**
 * Schedule one deterministic consolidation pass for a finished session,
 * fire-and-forget. Returns the tracked promise (resolves when the pass
 * completes, success or handled failure) so callers can await it on shutdown,
 * or ``null`` when there is nothing to do (no session key, no consolidatable
 * store, or a degraded store).
 */
export function scheduleConsolidation(opts: ScheduleConsolidationOptions): Promise<void> | null {
  const { store, sessionKey, now, staleAfterMs } = opts;

  if (!sessionKey) return null;
  if (!store || typeof store.consolidateSession !== "function") return null;
  if (store.isDegraded?.()) return null;

  const task = new Promise<void>((resolve) => {
    // Macrotask: let the caller's response flush before the synchronous sweep.
    // NB: setImmediate defers WHEN the sweep runs, not the fact that its
    // synchronous SQLite loop blocks the single event loop while it runs — a
    // concurrent /recall is starved for its whole duration. The heavy-task
    // marker lets a slow recall attribute the stall to "consolidation".
    setImmediate(() => {
      const diagToken = beginHeavyTask("consolidation");
      try {
        const stats = store.consolidateSession!({ sessionKey, now, staleAfterMs });
        opts.logger?.debug?.(
          `${TAG} session=${sessionKey} reinforced events=${stats.eventsReinforced} ` +
            `facts=${stats.factsReinforced} staled=${stats.staled}`,
        );
      } catch (err) {
        opts.logger?.warn(
          `${TAG} pass failed for session=${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        endHeavyTask(diagToken);
        resolve();
      }
    });
  });

  opts.register?.(task);
  void task.then(() => opts.unregister?.(task));

  return task;
}
