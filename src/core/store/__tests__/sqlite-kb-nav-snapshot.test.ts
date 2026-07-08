/**
 * VectorStore kb-nav SNAPSHOT persistence (Incremento b) — temp DB, real sqlite-vec.
 *
 * The behaviour under test is a RESTART: a fresh VectorStore on the same db file
 * must re-hydrate the navigable index from the on-disk graph-only snapshot and
 * SKIP the minutes-long HNSW rebuild — while staying correct across drift
 * (owners added / removed since the snapshot). All tests run on a throwaway DB
 * with the real kb_vec write path (upsertKbVector) so we verify the true data
 * shape, not synthetic arrays.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { VectorStore } from "../sqlite.js";

const DIMS = 8;
const SNAP_NAME = "kb-nav-index.v1.snapshot.json";

function normalize(values: number[]): Float32Array {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return new Float32Array(values.map((v) => v / mag));
}

/** Deterministic random unit vectors. */
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

function makeLogger() {
  const logs: string[] = [];
  const rec = (m: string) => logs.push(String(m));
  return { logs, logger: { info: rec, warn: rec, error: rec, debug: rec } };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
}

/** Open a fresh store on the given db path and load sqlite-vec (mirrors production init). */
function openStore(dbPath: string, logger?: unknown): VectorStore {
  const store = new VectorStore(dbPath, DIMS, logger as never);
  store.init({ provider: "openai", model: "text-embedding-3-small" });
  expect(store.isDegraded()).toBe(false);
  return store;
}

/** Raw out-of-band delete of owners from kb_vec (simulates deletions between restarts). */
function rawDeleteOwners(dbPath: string, ownerIds: string[]): void {
  const require = createRequire(import.meta.url);
  const sqliteVec = require("sqlite-vec");
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  try {
    db.enableLoadExtension(true);
    sqliteVec.load(db);
    const del = db.prepare("DELETE FROM kb_vec WHERE owner_id = ?");
    for (const id of ownerIds) del.run(id);
  } finally {
    db.close();
  }
}

describe("VectorStore kb-nav snapshot — persist + re-hydrate across restart", () => {
  let dir: string;
  let dbPath: string;
  let snapPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kbnav-snap-"));
    dbPath = path.join(dir, "vectors.db");
    snapPath = path.join(dir, SNAP_NAME);
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Seed `count` single-chunk owners with deterministic vectors; return them. */
  function seedOwners(store: VectorStore, count: number, seed: number): Array<{ id: string; vec: Float32Array }> {
    const vecs = seededUnitVectors(count, DIMS, seed);
    const owners = vecs.map((vec, i) => ({ id: `fact_${i}`, vec }));
    for (const o of owners) store.upsertKbVector(o.id, "fact", [o.vec], "t");
    return owners;
  }

  it("writes a graph-only snapshot after a build (no vector payload on disk)", async () => {
    const store = openStore(dbPath);
    seedOwners(store, 40, 1);
    expect(await store.buildKbNavIndex()).toBe(true);

    expect(await waitFor(() => fs.existsSync(snapPath))).toBe(true);
    const raw = fs.readFileSync(snapPath, "utf8");
    const file = JSON.parse(raw);
    expect(file.formatVersion).toBe(1);
    expect(file.dim).toBe(DIMS);
    expect(file.rowCount).toBe(40);
    expect(file.topology.nodes.length).toBe(40);
    // Graph-only: the base64 vector field must be ABSENT from the persisted file.
    expect(raw).not.toContain('"v"');
    store.close();
  });

  it("re-hydrates from the snapshot on the next start (LOAD path, not rebuild) with recall parity", async () => {
    const s1 = openStore(dbPath);
    const owners = seedOwners(s1, 40, 2);
    expect(await s1.buildKbNavIndex()).toBe(true);
    expect(await waitFor(() => fs.existsSync(snapPath))).toBe(true);
    s1.close();

    const { logs, logger } = makeLogger();
    const s2 = openStore(dbPath, logger);
    expect(await s2.initKbNavIndex()).toBe(true);

    // It took the LOAD path, not a rebuild.
    expect(logs.some((l) => l.includes("LOADED from snapshot"))).toBe(true);
    expect(logs.some((l) => l.includes("kb-nav index built"))).toBe(false);
    expect(s2.getKbNavIndexSize()).toBe(40);

    // Correctness: querying each owner's own vector returns that owner as the top hit.
    for (const o of owners) {
      const hits = s2.searchKbVector(o.vec, 1);
      expect(hits[0]?.owner_id).toBe(o.id);
    }
    s2.close();
  });

  it("reconciles owners ADDED after the snapshot (new memories) on restart", async () => {
    const s1 = openStore(dbPath);
    seedOwners(s1, 30, 3);
    expect(await s1.buildKbNavIndex()).toBe(true); // snapshot = 30 owners
    expect(await waitFor(() => fs.existsSync(snapPath))).toBe(true);
    // Add 8 MORE owners AFTER the snapshot (sync into the live index, not the file).
    const extraVecs = seededUnitVectors(8, DIMS, 99);
    const extra = extraVecs.map((vec, i) => ({ id: `fact_new_${i}`, vec }));
    for (const o of extra) s1.upsertKbVector(o.id, "fact", [o.vec], "t");
    // The on-disk snapshot still reflects 30 (no rebuild happened).
    expect(JSON.parse(fs.readFileSync(snapPath, "utf8")).topology.nodes.length).toBe(30);
    s1.close();

    const { logs, logger } = makeLogger();
    const s2 = openStore(dbPath, logger);
    expect(await s2.initKbNavIndex()).toBe(true);
    expect(logs.some((l) => l.includes("LOADED from snapshot"))).toBe(true);
    expect(s2.getKbNavIndexSize()).toBe(38); // 30 loaded + 8 reconciled

    // Each newly-added owner is findable via the loaded index.
    for (const o of extra) {
      const hits = s2.searchKbVector(o.vec, 1);
      expect(hits[0]?.owner_id).toBe(o.id);
    }
    s2.close();
  });

  it("excises owners DELETED after the snapshot (out-of-band) on restart", async () => {
    const s1 = openStore(dbPath);
    const owners = seedOwners(s1, 40, 4);
    expect(await s1.buildKbNavIndex()).toBe(true); // snapshot = 40
    expect(await waitFor(() => fs.existsSync(snapPath))).toBe(true);
    s1.close();

    // Delete 5 owners directly from the DB (within the freshness band → LOAD, not rebuild).
    const removed = owners.slice(0, 5).map((o) => o.id);
    rawDeleteOwners(dbPath, removed);

    const { logs, logger } = makeLogger();
    const s2 = openStore(dbPath, logger);
    expect(await s2.initKbNavIndex()).toBe(true);
    expect(logs.some((l) => l.includes("LOADED from snapshot"))).toBe(true);
    expect(s2.getKbNavIndexSize()).toBe(35); // 40 - 5 excised

    // A deleted owner must not surface even when queried with its own old vector.
    for (const o of owners.slice(0, 5)) {
      const hits = s2.searchKbVector(o.vec, 5);
      expect(hits.map((h) => h.owner_id)).not.toContain(o.id);
    }
    // A surviving owner is still the top hit for its vector.
    const survivor = owners[10];
    expect(s2.searchKbVector(survivor.vec, 1)[0]?.owner_id).toBe(survivor.id);
    s2.close();
  });

  it("discards a snapshot whose dim disagrees with the store, then rebuilds", async () => {
    const s1 = openStore(dbPath);
    seedOwners(s1, 20, 5);
    expect(await s1.buildKbNavIndex()).toBe(true);
    expect(await waitFor(() => fs.existsSync(snapPath))).toBe(true);
    s1.close();

    // Corrupt the persisted dim to a mismatching value.
    const file = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    file.dim = DIMS + 4;
    file.topology.dim = DIMS + 4;
    fs.writeFileSync(snapPath, JSON.stringify(file), "utf8");

    const { logs, logger } = makeLogger();
    const s2 = openStore(dbPath, logger);
    expect(await s2.initKbNavIndex()).toBe(true);
    expect(logs.some((l) => l.includes("LOADED from snapshot"))).toBe(false);
    expect(logs.some((l) => l.includes("kb-nav index built"))).toBe(true); // rebuilt
    expect(s2.getKbNavIndexSize()).toBe(20);
    s2.close();
  });

  it("discards a corrupt snapshot file and rebuilds cleanly", async () => {
    const s1 = openStore(dbPath);
    seedOwners(s1, 15, 6);
    expect(await s1.buildKbNavIndex()).toBe(true);
    expect(await waitFor(() => fs.existsSync(snapPath))).toBe(true);
    s1.close();

    fs.writeFileSync(snapPath, "{ this is not valid json", "utf8");

    const { logs, logger } = makeLogger();
    const s2 = openStore(dbPath, logger);
    expect(await s2.initKbNavIndex()).toBe(true);
    expect(logs.some((l) => l.includes("kb-nav index built"))).toBe(true);
    expect(s2.getKbNavIndexSize()).toBe(15);
    // The corrupt file was discarded.
    expect(fs.existsSync(snapPath)).toBe(false);
    s2.close();
  });

  it("rebuilds when the snapshot node count is inflated beyond the DB band (anti-DoS)", async () => {
    const s1 = openStore(dbPath);
    seedOwners(s1, 15, 8);
    expect(await s1.buildKbNavIndex()).toBe(true);
    expect(await waitFor(() => fs.existsSync(snapPath))).toBe(true);
    s1.close();

    // A crafted file whose rowCount stays in band (15) but whose topology.nodes is
    // inflated far past currentRows*2 must NOT trigger a huge re-hydration — rebuild.
    const file = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    const orig = file.topology.nodes as unknown[];
    const inflated: unknown[] = [];
    while (inflated.length < 60) inflated.push(...orig); // 60 > 15*2 band
    file.topology.nodes = inflated;
    fs.writeFileSync(snapPath, JSON.stringify(file), "utf8");

    const { logs, logger } = makeLogger();
    const s2 = openStore(dbPath, logger);
    expect(await s2.initKbNavIndex()).toBe(true);
    expect(logs.some((l) => l.includes("exceeds current"))).toBe(true);
    expect(logs.some((l) => l.includes("LOADED from snapshot"))).toBe(false);
    expect(s2.getKbNavIndexSize()).toBe(15); // rebuilt from the DB
    s2.close();
  });

  it("rebuilds (not loads) when the DB row count drifted far out of band", async () => {
    const s1 = openStore(dbPath);
    seedOwners(s1, 40, 7);
    expect(await s1.buildKbNavIndex()).toBe(true); // snapshot = 40
    expect(await waitFor(() => fs.existsSync(snapPath))).toBe(true);
    s1.close();

    // Delete 30 of 40 → current 10 < 40*0.5=20 → out of band → rebuild.
    const owners = seededUnitVectors(40, DIMS, 7).map((_, i) => `fact_${i}`);
    rawDeleteOwners(dbPath, owners.slice(0, 30));

    const { logs, logger } = makeLogger();
    const s2 = openStore(dbPath, logger);
    expect(await s2.initKbNavIndex()).toBe(true);
    expect(logs.some((l) => l.includes("out of band"))).toBe(true);
    expect(logs.some((l) => l.includes("LOADED from snapshot"))).toBe(false);
    expect(s2.getKbNavIndexSize()).toBe(10);
    s2.close();
  });
});
