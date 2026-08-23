/**
 * Choose WHICH bug events enter the pairwise clustering pass.
 *
 * WHY THIS EXISTS
 * ---------------
 * Failure clustering compares every bug event with every other one: O(N²) over
 * 1024-dim cosine. Measured on the live corpus (2026-08-23, 1.706 bug events):
 *
 *     N= 200 →   83 ms      N= 500 →  420 ms
 *     N= 300 →  136 ms      N= 800 → 1205 ms
 *     N= 400 →  237 ms      N=1706 → 4726 ms
 *
 * The pass is synchronous, so at full corpus it pegs the single Node event loop
 * for ~5 s and starves live recall. It also grows without bound as memory grows.
 *
 * WHY NOT JUST "KEEP THE 300 MOST RECENT"
 * ---------------------------------------
 * That is what usage-clusters does (USAGE_MAX_PAIRWISE_EVENTS), and there it is
 * right: usage tendencies are consolidated incrementally, so dropped older
 * events were already processed. Failures are NOT in that state. Measured the
 * same day: 68 lessons cover 612 bug events — **1.094 are covered by nothing**.
 * A pure recency cap would strand that backlog permanently, and the Mistake
 * Notebook is the pillar this whole subsystem exists for.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * A window that DRAINS: priority goes to bug events no lesson has ever cited,
 * newest first. As lessons get written those events become covered and leave
 * the queue, so the window slides backwards through the backlog until it is
 * empty — instead of re-chewing the same recent tail forever.
 *
 * HONEST LIMIT (do not overclaim)
 * -------------------------------
 * The window only slides when events actually become covered, and an event
 * becomes covered only if it ends up in a cluster that produces a lesson. Bug
 * events that never form a qualifying cluster (EVIDENCE_MIN / SESSION_MIN) stay
 * uncovered forever and keep the window pinned to the recent tail. Measured
 * 2026-08-23: 67 clusters on the full corpus, 15 within the window, and **zero**
 * fresh in either — the notebook is at its steady state, so nothing is being
 * lost today. If a genuinely new cluster ever forms out of OLD uncovered events,
 * a rotating offset (state, one window per run) would be needed to reach it.
 * That is the next step if the backlog ever starts mattering.
 *
 * A slice of the budget is nevertheless reserved for already-covered events.
 * Without it, a NEW failure belonging to an OLD cluster would find none of its
 * siblings in the window, form a fresh cluster, and produce a duplicate lesson.
 * With them present the cluster contains a covered id and the runner's
 * `clusterAlreadyCovered` guard recognises it.
 *
 * Pure and dependency-free so it can be tested without a database.
 */

/** Pairwise budget. 400 keeps one pass at ~240 ms — see the table above. */
export const MAX_PAIRWISE_BUG_EVENTS = 400;

/** Share of the budget reserved for already-covered events (anti-duplicate). */
export const COVERED_CONTEXT_SHARE = 0.25;

export interface WorkingSetItem {
  id: string;
}

export interface WorkingSetResult<T extends WorkingSetItem> {
  /** The events to cluster, restored to ascending id order. */
  selected: T[];
  /** How many were left out of this pass (0 when the corpus fits). */
  dropped: number;
  /** How many of the selected have no lesson citing them. */
  uncoveredSelected: number;
}

/**
 * Pick the working set.
 *
 * @param events   All processable bug events, ASCENDING by id. `id` is a
 *                 time-sortable ULID, so the tail is the most recent.
 * @param covered  Ids of bug events already cited as evidence by some lesson.
 * @param maxPairwise Budget (defaults to {@link MAX_PAIRWISE_BUG_EVENTS}).
 */
export function selectBugWorkingSet<T extends WorkingSetItem>(
  events: readonly T[],
  covered: ReadonlySet<string>,
  maxPairwise: number = MAX_PAIRWISE_BUG_EVENTS,
): WorkingSetResult<T> {
  const budget = Math.max(0, Math.floor(maxPairwise));
  if (events.length <= budget) {
    return {
      selected: [...events],
      dropped: 0,
      uncoveredSelected: events.filter((e) => !covered.has(e.id)).length,
    };
  }

  const uncovered: T[] = [];
  const coveredEvents: T[] = [];
  for (const e of events) (covered.has(e.id) ? coveredEvents : uncovered).push(e);

  // Reserve a slice for context, but never waste it: whatever one group cannot
  // fill flows to the other, so the budget is always spent in full.
  const coveredQuota = Math.min(
    coveredEvents.length,
    Math.floor(budget * COVERED_CONTEXT_SHARE),
  );
  const uncoveredTake = Math.min(uncovered.length, budget - coveredQuota);
  const coveredTake = Math.min(coveredEvents.length, budget - uncoveredTake);

  // `slice(-n)` = the n most recent of each group.
  const picked = [
    ...(uncoveredTake > 0 ? uncovered.slice(-uncoveredTake) : []),
    ...(coveredTake > 0 ? coveredEvents.slice(-coveredTake) : []),
  ];
  // Restore ascending id order: the graph builder treats the first event of a
  // component as its representative, and callers rely on that being stable.
  picked.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    selected: picked,
    dropped: events.length - picked.length,
    uncoveredSelected: uncoveredTake,
  };
}
