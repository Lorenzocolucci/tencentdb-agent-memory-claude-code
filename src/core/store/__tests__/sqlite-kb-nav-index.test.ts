/**
 * VectorStore ↔ NavigableIndex integration (Incremento C-1b) — temp DB, real sqlite-vec.
 *
 * These tests run on a THROWAWAY DB and exercise the REAL data shape (kb_vec
 * vectors written by upsertKbVector, read back by getAllKbVectors) — not synthetic
 * arrays — because delegated index work has shipped green-but-no-op before. The
 * anti-no-op guard is PARITY: the navigable route must return the same owners the
 * brute-force scan it replaces returns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";

const DIMS = 8;

function normalize(values: number[]): Float32Array {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return new Float32Array(values.map((v) => v / mag));
}

/** Deterministic random unit vectors for parity benchmarks. */
function seededUnitVectors(count: number, dim: number, seed: number): Float32Array[] {
  let a = seed >>> 0;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    const v: number[] = [];
    for (let d = 0; d < dim; d++) v.push(rand() * 2 - 1);
    out.push(normalize(v));
  }
  return out;
}

describe("VectorStore.getAllKbVectors — raw kb_vec read (real sqlite-vec)", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kbnav-read-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("reads back every chunk with its owner metadata and vector", () => {
    const va = normalize([1, 0, 0, 0, 0, 0, 0, 0]);
    store.upsertKbVector("fact_a", "fact", [va], "t1");
    store.upsertKbVector("ent_b", "entity", [normalize([0, 1, 0, 0, 0, 0, 0, 0]), normalize([0, 0, 1, 0, 0, 0, 0, 0])], "t2");

    const rows = store.getAllKbVectors();
    expect(rows.length).toBe(3); // 1 + 2 chunks

    const byId = new Map(rows.map((r) => [r.chunkId, r]));
    const first = byId.get("fact:fact_a#0");
    expect(first).toBeDefined();
    expect(first!.ownerId).toBe("fact_a");
    expect(first!.ownerKind).toBe("fact");
    expect(first!.vec.length).toBe(DIMS);
    for (let i = 0; i < DIMS; i++) expect(first!.vec[i]).toBeCloseTo(va[i], 5);

    // The two-chunk owner is present with both chunk ids.
    expect(byId.has("entity:ent_b#0")).toBe(true);
    expect(byId.has("entity:ent_b#1")).toBe(true);
  });
});

describe("VectorStore navigable-index routing (parity + fallback + sync)", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kbnav-route-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("searchKbVector works before the index is built (brute-force fallback)", () => {
    store.upsertKbVector("fact_a", "fact", [normalize([1, 0, 0, 0, 0, 0, 0, 0])], "t");
    expect(store.isKbNavIndexActive()).toBe(false);
    const hits = store.searchKbVector(normalize([1, 0, 0, 0, 0, 0, 0, 0]), 5);
    expect(hits[0].owner_id).toBe("fact_a");
  });

  it("builds the index and returns the SAME top owner as the brute-force baseline", async () => {
    const owners = [
      { id: "o1", vec: normalize([1, 0, 0, 0, 0, 0, 0, 0]) },
      { id: "o2", vec: normalize([0.9, 0.1, 0, 0, 0, 0, 0, 0]) },
      { id: "o3", vec: normalize([0, 1, 0, 0, 0, 0, 0, 0]) },
      { id: "o4", vec: normalize([0, 0, 1, 0, 0, 0, 0, 0]) },
    ];
    for (const o of owners) store.upsertKbVector(o.id, "fact", [o.vec], "t");

    const query = normalize([1, 0.05, 0, 0, 0, 0, 0, 0]);
    const baseline = store.searchKbVector(query, 3).map((h) => h.owner_id); // brute force

    expect(await store.buildKbNavIndex()).toBe(true);
    expect(store.isKbNavIndexActive()).toBe(true);
    expect(store.getKbNavIndexSize()).toBe(4);

    const viaIndex = store.searchKbVector(query, 3).map((h) => h.owner_id);
    expect(viaIndex).toEqual(baseline);
  });

  it("actually routes through the index, not the brute-force scan", async () => {
    store.upsertKbVector("o1", "fact", [normalize([1, 0, 0, 0, 0, 0, 0, 0])], "t");
    store.upsertKbVector("o2", "fact", [normalize([0, 1, 0, 0, 0, 0, 0, 0])], "t");
    await store.buildKbNavIndex();

    // Remove o1 from the INDEX only (kb_vec still has it). If search used the
    // brute-force scan it would still return o1; through the index it must not.
    (store as unknown as { kbNavIndex: { remove(id: string): boolean } }).kbNavIndex.remove("fact:o1#0");
    const hits = store.searchKbVector(normalize([1, 0, 0, 0, 0, 0, 0, 0]), 5).map((h) => h.owner_id);
    expect(hits).not.toContain("o1");
  });

  it("syncs a NEW owner upserted after the build", async () => {
    store.upsertKbVector("o1", "fact", [normalize([1, 0, 0, 0, 0, 0, 0, 0])], "t");
    await store.buildKbNavIndex();

    store.upsertKbVector("o2", "fact", [normalize([0, 1, 0, 0, 0, 0, 0, 0])], "t");
    expect(store.getKbNavIndexSize()).toBe(2);
    const hits = store.searchKbVector(normalize([0, 1, 0, 0, 0, 0, 0, 0]), 1);
    expect(hits[0].owner_id).toBe("o2");
  });

  it("reflects an upsert-REPLACE of an existing owner through the index", async () => {
    store.upsertKbVector("o1", "fact", [normalize([1, 0, 0, 0, 0, 0, 0, 0])], "t");
    await store.buildKbNavIndex();

    store.upsertKbVector("o1", "fact", [normalize([0, 0, 1, 0, 0, 0, 0, 0])], "t2"); // new direction
    expect(store.getKbNavIndexSize()).toBe(1);
    const forNew = store.searchKbVector(normalize([0, 0, 1, 0, 0, 0, 0, 0]), 1);
    expect(forNew[0].owner_id).toBe("o1");
    expect(forNew[0].score).toBeCloseTo(1, 4);
    const forOld = store.searchKbVector(normalize([1, 0, 0, 0, 0, 0, 0, 0]), 1);
    expect(forOld[0].score).toBeCloseTo(0, 4); // old direction no longer indexed
  });

  it("honors ownerKindFilter through the index", async () => {
    store.upsertKbVector("f1", "fact", [normalize([1, 0, 0, 0, 0, 0, 0, 0])], "t");
    store.upsertKbVector("e1", "entity", [normalize([1, 0, 0, 0, 0, 0, 0, 0])], "t");
    await store.buildKbNavIndex();
    const facts = store.searchKbVector(normalize([1, 0, 0, 0, 0, 0, 0, 0]), 5, "fact");
    expect(facts.every((h) => h.owner_kind === "fact")).toBe(true);
    expect(facts.some((h) => h.owner_id === "f1")).toBe(true);
  });

  it("returns false (no throw) when the store is closed before/after build", async () => {
    store.upsertKbVector("o1", "fact", [normalize([1, 0, 0, 0, 0, 0, 0, 0])], "t");
    store.close();
    await expect(store.buildKbNavIndex()).resolves.toBe(false);
    expect(store.isKbNavIndexActive()).toBe(false);
  });

  it("falls back to brute force when the index yields no usable hits", async () => {
    store.upsertKbVector("o1", "fact", [normalize([1, 0, 0, 0, 0, 0, 0, 0])], "t");
    await store.buildKbNavIndex();
    expect(store.getKbNavIndexSize()).toBe(1);
    // Simulate an index that returns nothing usable (e.g. lost chunk metadata):
    // searchKbVector must NOT return empty — it must fall back to the brute scan.
    (store as unknown as { kbNavChunkMeta: Map<string, unknown> }).kbNavChunkMeta.clear();
    const hits = store.searchKbVector(normalize([1, 0, 0, 0, 0, 0, 0, 0]), 5);
    expect(hits[0].owner_id).toBe("o1"); // recall preserved via fallback
  });

  it("a rebuild GCs accumulated tombstones (manual)", async () => {
    for (let i = 0; i < 5; i++) {
      store.upsertKbVector(`o${i}`, "fact", [normalize([1, i * 0.01, 0, 0, 0, 0, 0, 0])], "t");
    }
    await store.buildKbNavIndex();
    // Re-upsert the same owner many times → each replace tombstones the old node.
    for (let k = 0; k < 12; k++) {
      store.upsertKbVector("o0", "fact", [normalize([1, 0, k * 0.01, 0, 0, 0, 0, 0])], `t${k}`);
    }
    const before = store.getKbNavIndexStats();
    expect(before).not.toBeNull();
    expect(before!.tombstones).toBeGreaterThan(0);

    expect(await store.buildKbNavIndex()).toBe(true); // fresh rebuild from kb_vec
    const after = store.getKbNavIndexStats();
    expect(after!.tombstones).toBe(0);
    expect(after!.size).toBe(5);
    // Recall still correct after the compacting rebuild.
    const hits = store.searchKbVector(normalize([1, 0, 0.11, 0, 0, 0, 0, 0]), 1);
    expect(hits[0].owner_id).toBe("o0");
  });

  it("auto-triggers a compacting rebuild once tombstones exceed the threshold", async () => {
    // Cross KB_NAV_REBUILD_MIN_LIVE live owners, then replace enough to exceed the ratio.
    const N = 260;
    for (let i = 0; i < N; i++) {
      store.upsertKbVector(`o${i}`, "fact", [seededUnitVectors(1, DIMS, 1000 + i)[0]], "t");
    }
    await store.buildKbNavIndex();
    expect(store.getKbNavIndexSize()).toBe(N);

    // Replace >50% of owners → tombstones exceed size*0.5 → a rebuild should fire.
    for (let i = 0; i < 140; i++) {
      store.upsertKbVector(`o${i}`, "fact", [seededUnitVectors(1, DIMS, 5000 + i)[0]], "t2");
    }
    await vi.waitFor(
      () => {
        const s = store.getKbNavIndexStats();
        expect(s!.tombstones).toBeLessThan(s!.size); // rebuild GC'd the tombstones
      },
      { timeout: 4000, interval: 25 },
    );
    expect(store.getKbNavIndexSize()).toBe(N);
  });

  it("keeps >= 0.9 top-5 parity vs brute force on 300 real-shape vectors", async () => {
    const dim = 32;
    const store2 = new VectorStore(path.join(dir, "big.db"), dim);
    store2.init({ provider: "openai", model: "text-embedding-3-small" });
    const vecs = seededUnitVectors(300, dim, 4242);
    vecs.forEach((v, i) => store2.upsertKbVector(`o${i}`, "fact", [v], "t"));

    const queries = seededUnitVectors(20, dim, 9999);
    const baselines = queries.map((q) => store2.searchKbVector(q, 5).map((h) => h.owner_id));

    expect(await store2.buildKbNavIndex()).toBe(true);

    let recallSum = 0;
    queries.forEach((q, i) => {
      const got = new Set(store2.searchKbVector(q, 5).map((h) => h.owner_id));
      const truth = baselines[i];
      recallSum += truth.filter((id) => got.has(id)).length / truth.length;
    });
    store2.close();
    expect(recallSum / queries.length).toBeGreaterThanOrEqual(0.9);
  });
});
