/**
 * Slow-recall breadcrumb — the shutter release of the "camera".
 *
 * When a `/recall` takes longer than {@link SLOW_RECALL_MS}, the gateway logs
 * ONE line that names the likely culprit: how badly the event loop stalled
 * (event-loop-monitor) + which heavy tasks were active or had just finished
 * (inflight-registry). This turns "the banner didn't show" from a guess into a
 * deterministic attribution on the next natural occurrence — no log
 * archaeology, no restart-and-lose-the-evidence.
 *
 * Pure composition over the current diagnostic state. Never throws.
 */

import { readEventLoopLag, formatEventLoopLag } from "./event-loop-monitor.js";
import { snapshotHeavyTasks, formatHeavyTaskSnapshot } from "./inflight-registry.js";

/** A recall at or above this wall-clock time is considered slow, ms. */
export const SLOW_RECALL_MS = 1500;

/** Pure predicate: is this recall slow enough to warrant a breadcrumb? */
export function isSlowRecall(elapsedMs: number, thresholdMs = SLOW_RECALL_MS): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= thresholdMs;
}

/**
 * Compose the one-line breadcrumb naming what starved the loop. Reads the
 * current diagnostic state (lag histogram + in-flight registry) — call it at the
 * moment a slow recall is detected. Never throws.
 */
export function composeSlowRecallBreadcrumb(elapsedMs: number): string {
  try {
    const lag = formatEventLoopLag(readEventLoopLag());
    const tasks = formatHeavyTaskSnapshot(snapshotHeavyTasks());
    return `⏱️ SLOW RECALL ${elapsedMs.toFixed(0)}ms — ${lag} — ${tasks}`;
  } catch {
    return `⏱️ SLOW RECALL ${elapsedMs.toFixed(0)}ms — diag-unavailable`;
  }
}
