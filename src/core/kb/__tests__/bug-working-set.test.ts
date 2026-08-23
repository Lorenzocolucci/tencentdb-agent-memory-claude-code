/**
 * The working set must BOUND the pairwise cost without stranding the backlog.
 *
 * Context (measured 2026-08-23 on the live corpus): 1.706 bug events, of which
 * 1.094 are cited by no lesson. A plain "keep the 300 most recent" cap — the
 * rule usage-clusters uses — would have hidden those 1.094 forever.
 */

import { describe, it, expect } from "vitest";
import {
  selectBugWorkingSet,
  MAX_PAIRWISE_BUG_EVENTS,
  COVERED_CONTEXT_SHARE,
} from "../bug-working-set.js";

/** Ascending, zero-padded so string order == chronological order (like a ULID). */
function events(n: number, prefix = "e"): Array<{ id: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(5, "0")}` }));
}

describe("selectBugWorkingSet", () => {
  it("returns everything untouched when the corpus fits the budget", () => {
    const all = events(50);
    const r = selectBugWorkingSet(all, new Set(), 400);
    expect(r.selected).toHaveLength(50);
    expect(r.dropped).toBe(0);
  });

  it("never exceeds the budget", () => {
    const all = events(1706);
    const r = selectBugWorkingSet(all, new Set(), 400);
    expect(r.selected).toHaveLength(400);
    expect(r.dropped).toBe(1306);
  });

  it("prefers UNCOVERED events — the backlog a recency cap would strand", () => {
    // 1000 events; the 900 most recent all have lessons, the 100 oldest do not.
    const all = events(1000);
    const covered = new Set(all.slice(100).map((e) => e.id));

    const r = selectBugWorkingSet(all, covered, 400);
    const selectedIds = new Set(r.selected.map((e) => e.id));

    // A pure recency cap would have selected only ids from the covered tail.
    for (const e of all.slice(0, 100)) {
      expect(selectedIds.has(e.id), `mancante l'arretrato ${e.id}`).toBe(true);
    }
    expect(r.uncoveredSelected).toBe(100);
  });

  it("takes the MOST RECENT uncovered ones when the backlog exceeds the budget", () => {
    const all = events(1000);
    const r = selectBugWorkingSet(all, new Set(), 400);
    const ids = r.selected.map((e) => e.id);
    // Nothing covered → the whole budget goes to uncovered, newest first.
    expect(ids[ids.length - 1]).toBe("e00999");
    expect(r.uncoveredSelected).toBe(400);
  });

  it("keeps a slice of covered events so a new failure can join an old cluster", () => {
    const all = events(1000);
    // Half covered, half not — both groups are larger than their quota.
    const covered = new Set(all.filter((_, i) => i % 2 === 0).map((e) => e.id));

    const r = selectBugWorkingSet(all, covered, 400);
    const coveredSelected = r.selected.filter((e) => covered.has(e.id)).length;

    expect(coveredSelected).toBe(Math.floor(400 * COVERED_CONTEXT_SHARE));
    expect(r.selected).toHaveLength(400);
  });

  it("spends the whole budget when one group cannot fill its quota", () => {
    const all = events(1000);
    // Only 10 covered: the reserved slice cannot be filled, uncovered takes the rest.
    const covered = new Set(all.slice(0, 10).map((e) => e.id));
    const r = selectBugWorkingSet(all, covered, 400);
    expect(r.selected).toHaveLength(400);
    expect(r.uncoveredSelected).toBe(390);
  });

  it("returns ascending id order — the graph builder's representative depends on it", () => {
    const all = events(1000);
    const covered = new Set(all.filter((_, i) => i % 2 === 0).map((e) => e.id));
    const ids = selectBugWorkingSet(all, covered, 400).selected.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("DRAINS: as the backlog gets covered, the window slides to older events", () => {
    // 1.000 uncovered, budget 100. Each round's selection becomes covered.
    // Progress per round is the UNCOVERED quota — 100 on the first round, then
    // 100 − floor(100 × 0.25) = 75 — so the oldest event is reached in about
    // 1 + 900/75 = 13 rounds. The bound below leaves headroom while still
    // failing loudly if the window ever stopped sliding: with a plain recency
    // cap it would never terminate.
    const all = events(1000);
    const covered = new Set<string>();
    let rounds = 0;
    while (!covered.has("e00000") && rounds < 40) {
      const r = selectBugWorkingSet(all, covered, 100);
      for (const e of r.selected) covered.add(e.id);
      rounds++;
    }
    expect(covered.has("e00000"), `non drenato in ${rounds} giri`).toBe(true);
    expect(rounds).toBeLessThanOrEqual(15);
  });

  it("degrades safely on a zero/negative budget", () => {
    const all = events(50);
    expect(selectBugWorkingSet(all, new Set(), 0).selected).toHaveLength(0);
    expect(selectBugWorkingSet(all, new Set(), -5).selected).toHaveLength(0);
  });

  it("exposes a budget that keeps one pass well under a second", () => {
    // Guards the constant against a careless bump: 400 ≈ 240 ms measured,
    // 800 ≈ 1.205 ms, 1706 ≈ 4.726 ms.
    expect(MAX_PAIRWISE_BUG_EVENTS).toBeLessThanOrEqual(500);
  });
});
