/**
 * Event-loop lag monitor — proof of HOW starved the single event loop got.
 *
 * Wraps `perf_hooks.monitorEventLoopDelay`: a libuv timer sampled in native
 * code, so it records a stall even while JS is frozen by a synchronous loop.
 * Near-zero overhead, passive. Paired with the in-flight registry — the
 * histogram says the loop stalled for X ms, the registry says WHO stalled it.
 *
 * Singleton (one gateway process). Every function is defensive and NEVER throws.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

export interface EventLoopLag {
  /** Worst single stall observed in the current window, ms. */
  readonly maxMs: number;
  /** Mean loop delay in the current window, ms. */
  readonly meanMs: number;
  /** 99th-percentile loop delay in the current window, ms. */
  readonly p99Ms: number;
}

const NS_PER_MS = 1e6;

let histogram: IntervalHistogram | undefined;

/** Start the monitor once at gateway boot. Idempotent; never throws. */
export function startEventLoopMonitor(resolutionMs = 20): void {
  try {
    if (histogram) return;
    histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    histogram.enable();
  } catch {
    histogram = undefined;
  }
}

/** Read the current lag window (null if the monitor isn't running). */
export function readEventLoopLag(): EventLoopLag | null {
  try {
    if (!histogram) return null;
    return {
      maxMs: histogram.max / NS_PER_MS,
      meanMs: histogram.mean / NS_PER_MS,
      p99Ms: histogram.percentile(99) / NS_PER_MS,
    };
  } catch {
    return null;
  }
}

/** Reset the lag window so the next incident measures fresh stalls. */
export function resetEventLoopLag(): void {
  try {
    histogram?.reset();
  } catch {
    /* never throw */
  }
}

/** Compose a compact one-line description of the lag (pure, log-friendly). */
export function formatEventLoopLag(lag: EventLoopLag | null): string {
  if (!lag) return "lag=unavailable";
  const n = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : "?");
  return `lag_max=${n(lag.maxMs)}ms lag_p99=${n(lag.p99Ms)}ms lag_mean=${n(lag.meanMs)}ms`;
}

/** Test-only: stop + clear the monitor. */
export function _resetEventLoopMonitorForTest(): void {
  try {
    histogram?.disable();
  } catch {
    /* ignore */
  }
  histogram = undefined;
}
