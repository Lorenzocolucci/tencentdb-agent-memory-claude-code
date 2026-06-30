import { describe, it, expect } from "vitest";
import {
  spreadActivation,
  type NeighborsOf,
} from "../spreading-activation.js";

/** Build a NeighborsOf from a plain adjacency map. */
function graph(adj: Record<string, Array<[string, number]>>): NeighborsOf {
  return (id: string) => (adj[id] ?? []).map(([n, w]) => ({ id: n, weight: w }));
}

describe("spreadActivation — weighted, decaying, converging", () => {
  it("a chain A→B→C decays with distance (B > C) and excludes the seed A", () => {
    const g = graph({ A: [["B", 1]], B: [["C", 1]], C: [] });
    const out = spreadActivation([{ id: "A", activation: 1 }], g, { hops: 2, decay: 0.5 });
    expect(out.has("A")).toBe(false); // seed excluded
    expect(out.get("B")! > out.get("C")!).toBe(true);
    expect(out.get("C")!).toBeGreaterThan(0);
  });

  it("CONVERGENCE: a node reached from TWO seeds outranks one reached from one", () => {
    // S1 → X, S1 → Y ; S2 → X.  X gets activation from both seeds; Y from one.
    const g = graph({ S1: [["X", 1], ["Y", 1]], S2: [["X", 1]], X: [], Y: [] });
    const out = spreadActivation(
      [{ id: "S1", activation: 1 }, { id: "S2", activation: 1 }],
      g,
      { hops: 1, decay: 0.5 },
    );
    expect(out.get("X")! > out.get("Y")!).toBe(true);
  });

  it("stronger edge (higher support) carries more activation", () => {
    const g = graph({ A: [["B", 9], ["C", 1]], B: [], C: [] });
    const out = spreadActivation([{ id: "A", activation: 1 }], g, { hops: 1, decay: 1 });
    expect(out.get("B")! > out.get("C")!).toBe(true);
  });

  it("terminates on a cycle A↔B and still returns B", () => {
    const g = graph({ A: [["B", 1]], B: [["A", 1]] });
    const out = spreadActivation([{ id: "A", activation: 1 }], g, { hops: 3, decay: 0.5 });
    expect(out.get("B")!).toBeGreaterThan(0);
    expect(out.has("A")).toBe(false);
  });

  it("threshold drops negligible activations", () => {
    const g = graph({ A: [["B", 1]], B: [["C", 1]], C: [] });
    const out = spreadActivation([{ id: "A", activation: 1 }], g, {
      hops: 2, decay: 0.1, threshold: 0.05,
    });
    // C activation = 1 * 1 * 0.1 (hop1 to B) ... B=0.1, C=0.1*0.1=0.01 < 0.05 → dropped
    expect(out.has("B")).toBe(true);
    expect(out.has("C")).toBe(false);
  });

  it("maxNodes caps the result to the strongest", () => {
    const g = graph({ A: [["B", 5], ["C", 3], ["D", 1]], B: [], C: [], D: [] });
    const out = spreadActivation([{ id: "A", activation: 1 }], g, { hops: 1, decay: 1, maxNodes: 2 });
    expect(out.size).toBe(2);
    expect(out.has("B")).toBe(true); // strongest kept
    expect(out.has("D")).toBe(false); // weakest dropped
  });

  it("topKPerNode limits hub fan-out", () => {
    const g = graph({ A: [["B", 5], ["C", 4], ["D", 3], ["E", 2]], B: [], C: [], D: [], E: [] });
    const out = spreadActivation([{ id: "A", activation: 1 }], g, {
      hops: 1, decay: 1, topKPerNode: 2,
    });
    expect(out.has("B")).toBe(true);
    expect(out.has("C")).toBe(true);
    expect(out.has("E")).toBe(false); // beyond top-2 strongest, not expanded
  });

  it("empty graph or no seeds → empty result (total, never throws)", () => {
    expect(spreadActivation([], graph({}), {}).size).toBe(0);
    expect(spreadActivation([{ id: "A", activation: 1 }], graph({}), {}).size).toBe(0);
  });
});
