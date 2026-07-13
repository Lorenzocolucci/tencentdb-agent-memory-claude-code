/**
 * In-flight heavy-task registry — the "camera" that names WHAT was hogging the
 * single event loop when a recall ran slow.
 *
 * The gateway is one process on one event loop, and `node:sqlite` is
 * SYNCHRONOUS: a long non-yielding loop (consolidation reinforce, L0 indexing,
 * cornerstone neighbor scan) freezes the loop for its entire duration and
 * starves a concurrent `/recall` — the session-open banner then misses the
 * client timeout and is dropped. Deferring such a loop with `setImmediate`
 * ("fire-and-forget") does NOT help: it moves WHEN the loop runs, not the fact
 * that it blocks (root cause 6bb70c8).
 *
 * This registry lets those heavy operations mark themselves (begin/end). When a
 * recall crosses the slow threshold, {@link snapshotHeavyTasks} reports what is
 * ACTIVE and what RECENTLY finished — the culprit that just unblocked the loop
 * lands in `recent`, because by the time the starved recall resumes to log, the
 * blocker has usually already ended.
 *
 * Pure bookkeeping. Every function is defensive and NEVER throws: a diagnostic
 * must never break a turn.
 */

/** How many finished tasks to keep for "what just unblocked the loop". */
const RECENT_RING_SIZE = 24;

/** Default window for "recently finished" in a snapshot, ms. */
const DEFAULT_RECENT_WINDOW_MS = 5000;

export interface HeavyTaskToken {
  readonly id: number;
  readonly name: string;
}

export interface ActiveHeavyTask {
  readonly name: string;
  /** How long the task has been running at snapshot time, ms. */
  readonly runningMs: number;
}

export interface RecentHeavyTask {
  readonly name: string;
  /** Total wall-clock duration of the (now finished) task, ms. */
  readonly durationMs: number;
  /** How long ago the task finished at snapshot time, ms. */
  readonly endedAgoMs: number;
}

export interface HeavyTaskSnapshot {
  readonly active: readonly ActiveHeavyTask[];
  readonly recent: readonly RecentHeavyTask[];
}

interface ActiveEntry {
  readonly id: number;
  readonly name: string;
  readonly startedAt: number;
}
interface RecentEntry {
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

// Module-level singleton state — one gateway process = one event loop.
const active = new Map<number, ActiveEntry>();
const recent: RecentEntry[] = [];
let nextId = 1;

function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return 0;
  }
}

/** Mark the start of a heavy (potentially loop-blocking) operation. */
export function beginHeavyTask(name: string): HeavyTaskToken {
  const id = nextId++;
  try {
    active.set(id, { id, name, startedAt: nowMs() });
  } catch {
    /* diagnostics must never throw */
  }
  return { id, name };
}

/** Mark the end of a heavy operation started with {@link beginHeavyTask}. */
export function endHeavyTask(token: HeavyTaskToken | undefined): void {
  if (!token) return;
  try {
    const entry = active.get(token.id);
    if (!entry) return;
    active.delete(token.id);
    recent.push({ name: entry.name, startedAt: entry.startedAt, endedAt: nowMs() });
    while (recent.length > RECENT_RING_SIZE) recent.shift();
  } catch {
    /* never throw */
  }
}

/** Immutable snapshot of the active + recently-finished heavy tasks. */
export function snapshotHeavyTasks(recentWithinMs = DEFAULT_RECENT_WINDOW_MS): HeavyTaskSnapshot {
  try {
    const t = nowMs();
    const activeSnap: ActiveHeavyTask[] = [...active.values()]
      .map((e) => ({ name: e.name, runningMs: Math.max(0, t - e.startedAt) }))
      .sort((a, b) => b.runningMs - a.runningMs);
    const recentSnap: RecentHeavyTask[] = recent
      .filter((e) => t - e.endedAt <= recentWithinMs)
      .map((e) => ({
        name: e.name,
        durationMs: Math.max(0, e.endedAt - e.startedAt),
        endedAgoMs: Math.max(0, t - e.endedAt),
      }))
      .sort((a, b) => a.endedAgoMs - b.endedAgoMs);
    return { active: activeSnap, recent: recentSnap };
  } catch {
    return { active: [], recent: [] };
  }
}

/** Compose a compact one-line description of a snapshot (pure, log-friendly). */
export function formatHeavyTaskSnapshot(snap: HeavyTaskSnapshot): string {
  const act = snap.active.length
    ? snap.active.map((a) => `${a.name}(running ${a.runningMs.toFixed(0)}ms)`).join(", ")
    : "none";
  const rec = snap.recent.length
    ? snap.recent.map((r) => `${r.name}(${r.durationMs.toFixed(0)}ms, ${r.endedAgoMs.toFixed(0)}ms ago)`).join(", ")
    : "none";
  return `active=[${act}] recent=[${rec}]`;
}

/** Test-only: clear all state. */
export function _resetHeavyTasksForTest(): void {
  active.clear();
  recent.length = 0;
  nextId = 1;
}
