import { describe, it, expect } from "vitest";
import {
  computePrimingBoosts,
  applyPriming,
  PRIMING_LAMBDA,
  type PrimingCandidate,
} from "../implicit-priming.js";
import type { NeighborsOf } from "../spreading-activation.js";

function graph(adj: Record<string, Array<[string, number]>>): NeighborsOf {
  return (id: string) => (adj[id] ?? []).map(([n, w]) => ({ id: n, weight: w }));
}

describe("implicit priming — sub-threshold memories amplify connected ones", () => {
  it("a weak candidate connected to a strong one gets a boost; an isolated weak one does not", () => {
    // strong S; weak W (linked to S by co-occurrence); weak ISO (isolated).
    const candidates: PrimingCandidate[] = [
      { id: "S", ranking: 1.0 },
      { id: "W", ranking: 0.1 },
      { id: "ISO", ranking: 0.1 },
    ];
    const g = graph({ S: [["W", 1]], W: [["S", 1]] }); // ISO has no edges
    const boosts = computePrimingBoosts(candidates, g, {});
    expect(boosts.get("W")! > 0).toBe(true);
    expect(boosts.get("ISO") ?? 0).toBe(0);
  });

  it("priming lifts the connected weak candidate ABOVE the isolated weak one", () => {
    const candidates: PrimingCandidate[] = [
      { id: "S", ranking: 1.0 },
      { id: "W", ranking: 0.1 },
      { id: "ISO", ranking: 0.1 },
    ];
    const g = graph({ S: [["W", 1]], W: [["S", 1]] });
    const boosts = computePrimingBoosts(candidates, g, {});
    const primed = applyPriming(candidates, boosts);
    const rank = new Map(primed.map((c) => [c.id, c.ranking]));
    expect(rank.get("W")! > rank.get("ISO")!).toBe(true); // W was primed, ISO was not
  });

  it("priming only NUDGES — a strong match stays on top of a primed weak one", () => {
    const candidates: PrimingCandidate[] = [
      { id: "S", ranking: 1.0 },
      { id: "W", ranking: 0.1 },
    ];
    const g = graph({ S: [["W", 1]], W: [["S", 1]] });
    const primed = applyPriming(candidates, computePrimingBoosts(candidates, g, {}));
    expect(primed[0]!.id).toBe("S"); // relevance stays primary
  });

  it("applyPriming returns candidates ordered by boosted ranking, never throws on empty", () => {
    expect(applyPriming([], new Map())).toEqual([]);
  });

  it("PRIMING_LAMBDA is small (priming nudges, not dominates)", () => {
    expect(PRIMING_LAMBDA).toBeGreaterThan(0);
    expect(PRIMING_LAMBDA).toBeLessThan(0.5);
  });
});
