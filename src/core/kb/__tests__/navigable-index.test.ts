/**
 * NavigableIndex — unit tests (Incremento C-1, isolated module).
 *
 * The index is the STRUCTURAL form of associative recall: a navigable
 * small-world graph where search is a greedy neighbor-to-neighbor traversal
 * (spreading activation made navigable), giving sub-linear KNN so a single
 * cornerstone scan no longer starves the event loop (see HANDOFF.md, Incremento C).
 *
 * Correctness contract (mirrors sqlite.ts searchKbVector):
 *   - score = cosine similarity in [-1, 1] (higher = closer); identical dir → 1.
 *   - zero / empty vectors are NEVER indexed (placeholders must not pollute KNN).
 *   - approximate KNN must match brute-force top-k with high recall (anti no-op guard).
 *
 * Wave 1 = core correctness. Wave 2 (mutation/persistence/quality) added after GREEN.
 */

import { describe, it, expect } from "vitest";
import { NavigableIndex } from "../navigable-index.js";

/** Brute-force cosine top-k over raw vectors — the ground truth the index approximates. */
function bruteForceTopK(
  vectors: Array<{ id: string; vec: number[] }>,
  query: number[],
  k: number,
): string[] {
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  const norm = (a: number[]) => Math.sqrt(dot(a, a)) || 1;
  const qn = norm(query);
  return vectors
    .map((v) => ({ id: v.id, score: dot(v.vec, query) / (norm(v.vec) * qn) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => r.id);
}

const f32 = (nums: number[]) => Float32Array.from(nums);

describe("NavigableIndex — construction & empty state", () => {
  it("starts empty and returns no hits", () => {
    const idx = new NavigableIndex(3);
    expect(idx.size).toBe(0);
    expect(idx.search(f32([1, 0, 0]), 5)).toEqual([]);
  });

  it("exposes its dimension", () => {
    const idx = new NavigableIndex(768);
    expect(idx.dim).toBe(768);
  });
});

describe("NavigableIndex — single vector & cosine scoring", () => {
  it("indexes one vector and returns it for an identical query with score ~1", () => {
    const idx = new NavigableIndex(3);
    expect(idx.add("a", f32([1, 0, 0]))).toBe(true);
    expect(idx.size).toBe(1);
    expect(idx.has("a")).toBe(true);

    const hits = idx.search(f32([1, 0, 0]), 5);
    expect(hits.map((h) => h.id)).toEqual(["a"]);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it("scores orthogonal ~0 and opposite ~-1 (cosine)", () => {
    const idx = new NavigableIndex(2);
    idx.add("right", f32([1, 0]));
    idx.add("up", f32([0, 1]));
    idx.add("left", f32([-1, 0]));

    const hits = idx.search(f32([1, 0]), 3);
    const byId = Object.fromEntries(hits.map((h) => [h.id, h.score]));
    expect(byId["right"]).toBeCloseTo(1, 5);
    expect(byId["up"]).toBeCloseTo(0, 5);
    expect(byId["left"]).toBeCloseTo(-1, 5);
  });

  it("is scale-invariant (cosine ignores magnitude)", () => {
    const idx = new NavigableIndex(2);
    idx.add("a", f32([2, 0]));
    const hits = idx.search(f32([10, 0]), 1);
    expect(hits[0].id).toBe("a");
    expect(hits[0].score).toBeCloseTo(1, 5);
  });
});

describe("NavigableIndex — boundary validation", () => {
  it("throws on a dimension-mismatched add", () => {
    const idx = new NavigableIndex(3);
    expect(() => idx.add("bad", f32([1, 0]))).toThrow();
  });

  it("throws on a dimension-mismatched search", () => {
    const idx = new NavigableIndex(3);
    idx.add("a", f32([1, 0, 0]));
    expect(() => idx.search(f32([1, 0]), 1)).toThrow();
  });

  it("rejects a zero vector (never pollutes KNN) without throwing", () => {
    const idx = new NavigableIndex(3);
    expect(idx.add("zero", f32([0, 0, 0]))).toBe(false);
    expect(idx.size).toBe(0);
    expect(idx.has("zero")).toBe(false);
  });

  it("returns [] for a zero query rather than NaN scores", () => {
    const idx = new NavigableIndex(3);
    idx.add("a", f32([1, 2, 3]));
    expect(idx.search(f32([0, 0, 0]), 3)).toEqual([]);
  });
});

describe("NavigableIndex — exact KNN on a small deterministic set", () => {
  it("matches brute-force top-k ordering", () => {
    const vectors = [
      { id: "v1", vec: [1, 0, 0, 0] },
      { id: "v2", vec: [0.9, 0.1, 0, 0] },
      { id: "v3", vec: [0, 1, 0, 0] },
      { id: "v4", vec: [0, 0, 1, 0] },
      { id: "v5", vec: [0.8, 0.2, 0.1, 0] },
      { id: "v6", vec: [0, 0, 0, 1] },
    ];
    const idx = new NavigableIndex(4, { seed: 42 });
    for (const v of vectors) idx.add(v.id, f32(v.vec));

    const query = [1, 0.05, 0, 0];
    const expected = bruteForceTopK(vectors, query, 3);
    const got = idx.search(f32(query), 3).map((h) => h.id);
    expect(got).toEqual(expected);
  });

  it("returns all live nodes when k exceeds size", () => {
    const idx = new NavigableIndex(2, { seed: 7 });
    idx.add("a", f32([1, 0]));
    idx.add("b", f32([0, 1]));
    const hits = idx.search(f32([1, 1]), 10);
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
  });
});

// ── Wave 2: mutation, persistence, and recall quality ──────────────────────

/** Deterministic random vectors for reproducible recall benchmarks. */
function seededVectors(count: number, dim: number, seed: number): Array<{ id: string; vec: number[] }> {
  let a = seed >>> 0;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Array<{ id: string; vec: number[] }> = [];
  for (let i = 0; i < count; i++) {
    const vec: number[] = [];
    for (let d = 0; d < dim; d++) vec.push(rand() * 2 - 1);
    out.push({ id: `n${i}`, vec });
  }
  return out;
}

describe("NavigableIndex — removal (tombstone)", () => {
  it("removes an id: gone from results, others intact, size decremented", () => {
    const idx = new NavigableIndex(2, { seed: 1 });
    idx.add("a", f32([1, 0]));
    idx.add("b", f32([0, 1]));
    idx.add("c", f32([1, 1]));

    expect(idx.remove("b")).toBe(true);
    expect(idx.size).toBe(2);
    expect(idx.has("b")).toBe(false);

    const ids = idx.search(f32([0, 1]), 5).map((h) => h.id);
    expect(ids).not.toContain("b");
    expect(ids.sort()).toEqual(["a", "c"]);
  });

  it("returns false for removing a non-existent id (no throw)", () => {
    const idx = new NavigableIndex(2, { seed: 1 });
    idx.add("a", f32([1, 0]));
    expect(idx.remove("ghost")).toBe(false);
    expect(idx.size).toBe(1);
  });

  it("still recalls correctly after removing several nodes", () => {
    const idx = new NavigableIndex(3, { seed: 5 });
    idx.add("a", f32([1, 0, 0]));
    idx.add("b", f32([0, 1, 0]));
    idx.add("c", f32([0, 0, 1]));
    idx.add("d", f32([1, 1, 0]));
    idx.remove("a");
    idx.remove("c");
    const hits = idx.search(f32([1, 0, 0]), 5);
    expect(hits.map((h) => h.id).sort()).toEqual(["b", "d"]);
  });
});

describe("NavigableIndex — upsert (re-add same id)", () => {
  it("replaces the vector when the same id is added again", () => {
    const idx = new NavigableIndex(3, { seed: 2 });
    idx.add("x", f32([1, 0, 0]));
    idx.add("x", f32([0, 1, 0])); // upsert
    expect(idx.size).toBe(1);

    const forNew = idx.search(f32([0, 1, 0]), 1);
    expect(forNew[0].id).toBe("x");
    expect(forNew[0].score).toBeCloseTo(1, 5);

    const forOld = idx.search(f32([1, 0, 0]), 1);
    expect(forOld[0].id).toBe("x");
    expect(forOld[0].score).toBeCloseTo(0, 5); // old direction no longer indexed
  });
});

describe("NavigableIndex — serialize / deserialize", () => {
  it("round-trips (via JSON) to an index with identical search results", () => {
    const idx = new NavigableIndex(4, { seed: 9 });
    const vecs = seededVectors(60, 4, 123);
    for (const v of vecs) idx.add(v.id, f32(v.vec));

    const snap = JSON.parse(JSON.stringify(idx.serialize()));
    const restored = NavigableIndex.deserialize(snap);

    expect(restored.size).toBe(idx.size);
    expect(restored.dim).toBe(idx.dim);

    const query = f32([0.3, -0.7, 0.2, 0.5]);
    const before = idx.search(query, 10);
    const after = restored.search(query, 10);
    expect(after.map((h) => h.id)).toEqual(before.map((h) => h.id));
    for (let i = 0; i < before.length; i++) {
      expect(after[i].score).toBeCloseTo(before[i].score, 5);
    }
  });

  it("preserves the live set across a round-trip after a remove", () => {
    const idx = new NavigableIndex(3, { seed: 3 });
    idx.add("a", f32([1, 0, 0]));
    idx.add("b", f32([0, 1, 0]));
    idx.add("c", f32([0, 0, 1]));
    idx.remove("b");

    const restored = NavigableIndex.deserialize(JSON.parse(JSON.stringify(idx.serialize())));
    expect(restored.size).toBe(2);
    expect(restored.has("b")).toBe(false);
    const ids = restored.search(f32([0, 0, 1]), 5).map((h) => h.id);
    expect(ids.sort()).toEqual(["a", "c"]);
  });
});

describe("NavigableIndex — recall quality vs brute force (anti no-op guard)", () => {
  it("achieves >= 0.9 mean recall@10 on 800 random vectors", () => {
    const dim = 48;
    const vecs = seededVectors(800, dim, 777);
    const idx = new NavigableIndex(dim, { seed: 13, M: 16, efConstruction: 200 });
    for (const v of vecs) idx.add(v.id, f32(v.vec));
    expect(idx.size).toBe(800);

    const queries = seededVectors(30, dim, 555);
    let recallSum = 0;
    for (const q of queries) {
      const truth = new Set(bruteForceTopK(vecs, q.vec, 10));
      const got = idx.search(f32(q.vec), 10, 100).map((h) => h.id);
      const hit = got.filter((id) => truth.has(id)).length;
      recallSum += hit / 10;
    }
    const meanRecall = recallSum / queries.length;
    expect(meanRecall).toBeGreaterThanOrEqual(0.9);
  });

  it("holds recall at realistic embedding dimensionality (dim 256)", () => {
    const dim = 256;
    const vecs = seededVectors(500, dim, 2024);
    const idx = new NavigableIndex(dim, { seed: 31, M: 16, efConstruction: 200 });
    for (const v of vecs) idx.add(v.id, f32(v.vec));

    const queries = seededVectors(20, dim, 4048);
    let recallSum = 0;
    for (const q of queries) {
      const truth = new Set(bruteForceTopK(vecs, q.vec, 10));
      const got = idx.search(f32(q.vec), 10, 100).map((h) => h.id);
      recallSum += got.filter((id) => truth.has(id)).length / 10;
    }
    expect(recallSum / queries.length).toBeGreaterThanOrEqual(0.85);
  });
});

// ── Wave 3: review-driven correctness (tombstone beam-starvation & guards) ──

describe("NavigableIndex — tombstones must not starve live results", () => {
  it("returns live hits even when many nearer nodes are tombstoned", () => {
    // 30 removed nodes sit STRICTLY nearer the query than 10 live nodes. With an
    // ef-beam smaller than the tombstone count, a naive impl fills every result
    // slot with tombstones and returns nothing live. The graph stays reachable.
    const dim = 8;
    const idx = new NavigableIndex(dim, { seed: 4 });
    const removed: string[] = [];
    for (let i = 0; i < 30; i++) {
      const v = new Array(dim).fill(0);
      v[0] = 1;
      v[1] = 0.001 * (i + 1); // tiny offset → very close to query
      idx.add(`rm${i}`, f32(v));
      removed.push(`rm${i}`);
    }
    for (let j = 0; j < 10; j++) {
      const v = new Array(dim).fill(0);
      v[0] = 1;
      v[2] = 0.15 + 0.002 * j; // larger offset → farther than the removed ones
      idx.add(`lv${j}`, f32(v));
    }
    for (const id of removed) idx.remove(id);
    expect(idx.size).toBe(10);

    const query = new Array(dim).fill(0);
    query[0] = 1;
    const hits = idx.search(f32(query), 10, 20); // ef 20 < 30 tombstones
    expect(hits.length).toBe(10);
    expect(hits.every((h) => h.id.startsWith("lv"))).toBe(true);
  });

  it("keeps >= 0.9 mean recall@10 over the LIVE set after removing 40%", () => {
    const dim = 48;
    const vecs = seededVectors(800, dim, 91);
    const idx = new NavigableIndex(dim, { seed: 17, M: 16, efConstruction: 200 });
    for (const v of vecs) idx.add(v.id, f32(v.vec));
    // Remove every node whose index mod 5 is < 2 → ~40% tombstoned.
    const live = vecs.filter((_, i) => i % 5 >= 2);
    for (let i = 0; i < vecs.length; i++) if (i % 5 < 2) idx.remove(vecs[i].id);
    expect(idx.size).toBe(live.length);

    const queries = seededVectors(30, dim, 92);
    let recallSum = 0;
    for (const q of queries) {
      const truth = new Set(bruteForceTopK(live, q.vec, 10));
      const got = idx.search(f32(q.vec), 10, 100).map((h) => h.id);
      recallSum += got.filter((id) => truth.has(id)).length / 10;
    }
    expect(recallSum / queries.length).toBeGreaterThanOrEqual(0.9);
  });
});

describe("NavigableIndex — score stays within the cosine range", () => {
  it("never returns a score above 1 (Float32 rounding clamp)", () => {
    const dim = 128;
    const vecs = seededVectors(400, dim, 8888);
    const idx = new NavigableIndex(dim, { seed: 3 });
    for (const v of vecs) idx.add(v.id, f32(v.vec));
    for (const v of vecs) {
      const hits = idx.search(f32(v.vec), 3);
      for (const h of hits) {
        expect(h.score).toBeLessThanOrEqual(1);
        expect(h.score).toBeGreaterThanOrEqual(-1);
      }
    }
  });
});

describe("NavigableIndex — integer top-k", () => {
  it("floors a fractional k", () => {
    const idx = new NavigableIndex(3, { seed: 1 });
    idx.add("a", f32([1, 0, 0]));
    idx.add("b", f32([0, 1, 0]));
    idx.add("c", f32([0, 0, 1]));
    idx.add("d", f32([1, 1, 0]));
    idx.add("e", f32([1, 0, 1]));
    expect(idx.search(f32([1, 0.2, 0]), 2.7).length).toBe(2);
  });
});

describe("NavigableIndex — deserialize validation", () => {
  it("round-trips an empty index", () => {
    const idx = new NavigableIndex(4);
    const restored = NavigableIndex.deserialize(JSON.parse(JSON.stringify(idx.serialize())));
    expect(restored.size).toBe(0);
    expect(restored.search(f32([1, 0, 0, 0]), 5)).toEqual([]);
  });

  it("throws RangeError on an out-of-range entry point", () => {
    const idx = new NavigableIndex(3);
    idx.add("a", f32([1, 0, 0]));
    const snap: any = JSON.parse(JSON.stringify(idx.serialize()));
    snap.entryPoint = 999;
    expect(() => NavigableIndex.deserialize(snap)).toThrow(RangeError);
  });

  it("throws RangeError on a dangling neighbor index", () => {
    const idx = new NavigableIndex(3);
    idx.add("a", f32([1, 0, 0]));
    idx.add("b", f32([0, 1, 0]));
    const snap: any = JSON.parse(JSON.stringify(idx.serialize()));
    snap.nodes[0].neighbors[0] = [42];
    expect(() => NavigableIndex.deserialize(snap)).toThrow(RangeError);
  });

  it("throws RangeError on a vector whose length != dim", () => {
    const idx = new NavigableIndex(3);
    idx.add("a", f32([1, 0, 0]));
    const snap: any = JSON.parse(JSON.stringify(idx.serialize()));
    // Encode a 2-dim vector where a 3-dim one is expected.
    snap.nodes[0].v = Buffer.from(Float32Array.from([1, 0]).buffer).toString("base64");
    expect(() => NavigableIndex.deserialize(snap)).toThrow(RangeError);
  });
});

describe("NavigableIndex — determinism", () => {
  it("produces identical results for the same seed + insertion order", () => {
    const vecs = seededVectors(200, 16, 321);
    const build = () => {
      const idx = new NavigableIndex(16, { seed: 99 });
      for (const v of vecs) idx.add(v.id, f32(v.vec));
      return idx;
    };
    const q = f32(vecs[0].vec.map((x) => x + 0.01));
    const a = build().search(q, 10);
    const b = build().search(q, 10);
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
    expect(a.map((h) => h.score)).toEqual(b.map((h) => h.score));
  });
});
