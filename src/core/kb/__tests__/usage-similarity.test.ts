/**
 * Slice B1 — usage edge weight. Locks the SEMANTIC-DOMINANT contract: cosine
 * drives the weight, entity Jaccard is only a small nudge (behaviors are often
 * entity-less, so a per-entity-weighted metric would never link them).
 */

import { describe, it, expect } from "vitest";
import { usageEdgeWeight, USAGE_ALPHA, USAGE_BETA, USAGE_TAU } from "../usage-similarity.js";

const v = (...xs: number[]) => new Float32Array(xs);

describe("usageEdgeWeight", () => {
  it("is driven by cosine when there are no shared entities", () => {
    const w = usageEdgeWeight({ embedding: v(1, 0), contextIds: [] }, { embedding: v(1, 0), contextIds: [] });
    expect(w).toBeCloseTo(USAGE_ALPHA, 5); // pure semantic: α·1 + β·0
  });

  it("links two near-identical entity-less behaviors (≥ TAU)", () => {
    const w = usageEdgeWeight(
      { embedding: v(1, 0), contextIds: [] },
      { embedding: v(0.99, 0.14), contextIds: [] },
    );
    expect(w).toBeGreaterThanOrEqual(USAGE_TAU);
  });

  it("does not link orthogonal behaviors", () => {
    const w = usageEdgeWeight({ embedding: v(1, 0), contextIds: [] }, { embedding: v(0, 1), contextIds: [] });
    expect(w).toBeLessThan(USAGE_TAU);
  });

  it("gives a small structural nudge when behaviors share an entity", () => {
    const semanticOnly = usageEdgeWeight(
      { embedding: v(0.8, 0.6), contextIds: [] },
      { embedding: v(1, 0), contextIds: [] },
    );
    const withShared = usageEdgeWeight(
      { embedding: v(0.8, 0.6), contextIds: ["ent_x"] },
      { embedding: v(1, 0), contextIds: ["ent_x"] },
    );
    expect(withShared - semanticOnly).toBeCloseTo(USAGE_BETA, 5); // jaccard 1 → +β
  });
});
