/**
 * Event-loop lag monitor — proof of HOW starved the single event loop got.
 *
 * Wraps `perf_hooks.monitorEventLoopDelay`: a libuv timer sampled in native
 * code, so it records a stall even while JS is frozen by a synchronous loop.
 * Near-zero overhead, passive. Paired with the in-flight registry — the
 * histogram says the loop stalled for X ms, the registry says WHO stalled it.
 *
 * Rolling window (2026-10-03): the histogram is snapshotted and reset every
 * second into a ring of timestamped samples; a read aggregates the last
 * {@link WINDOW_MS} (10 s) plus the live histogram. Before, the histogram was
 * reset only after a slow recall, so a lag number could be minutes old and had
 * no timestamp - it could not be matched to the job running at that moment.
 *
 * Singleton (one gateway process). Every function is defensive and NEVER throws.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

export interface EventLoopLag {
  /** Worst single stall observed in the window, ms. */
  readonly maxMs: number;
  /** Mean loop delay in the window, ms (weighted by sample count). */
  readonly meanMs: number;
  /** Worst per-second 99th-percentile loop delay in the window, ms. */
  readonly p99Ms: number;
  /** ISO time of the one-second bucket that holds the worst stall. */
  readonly worstAt?: string;
  /** ISO bounds of the aggregated window. */
  readonly windowStart?: string;
  readonly windowEnd?: string;
}

interface LagSample {
  readonly atMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly p99Ms: number;
  readonly count: number;
}

const NS_PER_MS = 1e6;
/** Rolling window length, ms. */
export const WINDOW_MS = 10_000;
const SAMPLE_INTERVAL_MS = 1_000;

let histogram: IntervalHistogram | undefined;
let samples: LagSample[] = [];
let sampler: ReturnType<typeof setInterval> | undefined;

function readHistogram(atMs: number): LagSample | null {
  if (!histogram || histogram.count === 0) return null;
  return {
    atMs,
    maxMs: histogram.max / NS_PER_MS,
    meanMs: histogram.mean / NS_PER_MS,
    p99Ms: histogram.percentile(99) / NS_PER_MS,
    count: histogram.count,
  };
}

/** Move the live histogram into the ring and drop samples older than the window. */
export function sampleEventLoopLag(nowMs: number = Date.now()): void {
  try {
    const sample = readHistogram(nowMs);
    if (sample) samples = [...samples, sample];
    histogram?.reset();
    samples = samples.filter((s) => nowMs - s.atMs <= WINDOW_MS);
  } catch {
    /* never throw */
  }
}

/** Start the monitor once at gateway boot. Idempotent; never throws. */
export function startEventLoopMonitor(resolutionMs = 20): void {
  try {
    if (histogram) return;
    histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    histogram.enable();
    sampler = setInterval(() => sampleEventLoopLag(), SAMPLE_INTERVAL_MS);
    sampler.unref();
  } catch {
    histogram = undefined;
  }
}

/** Aggregate the rolling window (null if the monitor isn't running). */
export function readEventLoopLag(nowMs: number = Date.now()): EventLoopLag | null {
  try {
    if (!histogram) return null;
    const live = readHistogram(nowMs);
    const window = [...samples.filter((s) => nowMs - s.atMs <= WINDOW_MS), ...(live ? [live] : [])];
    const windowStart = new Date(nowMs - WINDOW_MS).toISOString();
    const windowEnd = new Date(nowMs).toISOString();
    if (window.length === 0) {
      return { maxMs: 0, meanMs: 0, p99Ms: 0, windowStart, windowEnd };
    }
    const worst = window.reduce((a, b) => (b.maxMs > a.maxMs ? b : a));
    const total = window.reduce((n, s) => n + s.count, 0);
    return {
      maxMs: worst.maxMs,
      meanMs: window.reduce((n, s) => n + s.meanMs * s.count, 0) / total,
      p99Ms: Math.max(...window.map((s) => s.p99Ms)),
      worstAt: new Date(worst.atMs).toISOString(),
      windowStart,
      windowEnd,
    };
  } catch {
    return null;
  }
}

/** Clear the window (and the live histogram) so the next read starts fresh. */
export function resetEventLoopLag(): void {
  try {
    samples = [];
    histogram?.reset();
  } catch {
    /* never throw */
  }
}

/** Compose a compact one-line description of the lag (pure, log-friendly). */
export function formatEventLoopLag(lag: EventLoopLag | null): string {
  if (!lag) return "lag=unavailable";
  const n = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : "?");
  const base = `lag_max=${n(lag.maxMs)}ms lag_p99=${n(lag.p99Ms)}ms lag_mean=${n(lag.meanMs)}ms`;
  if (!lag.windowStart || !lag.windowEnd) return base;
  const worst = lag.worstAt ? ` worst_at=${lag.worstAt}` : "";
  return `${base}${worst} window=${lag.windowStart}..${lag.windowEnd}`;
}

/** Test-only: stop + clear the monitor. */
export function _resetEventLoopMonitorForTest(): void {
  try {
    histogram?.disable();
  } catch {
    /* ignore */
  }
  if (sampler) clearInterval(sampler);
  sampler = undefined;
  histogram = undefined;
  samples = [];
}
