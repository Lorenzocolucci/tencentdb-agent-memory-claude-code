/**
 * Compact vec0 layout (kb_vec / l0_vec) — plan item 6.2.
 *
 * Ground truth is the SQLite file itself (counts read straight from the vec0
 * tables and their shadow tables), not the code under test: the legacy fixture
 * is built with raw SQL using the exact legacy DDL.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../sqlite.js";
import { isLegacyVecSql, tableExists, vecTableSql, KB_VEC_SPEC, L0_VEC_SPEC } from "../vec-compact.js";
import {
  buildStaging,
  cleanupTable,
  dropStaging,
  knnEquivalence,
  oldName,
  rollbackTable,
  shadowTables,
  swapTable,
  tableStats,
  verifyTables,
} from "../vec-compact-migrate.js";

const req = createRequire(import.meta.url);
const DIMS = 4;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function vec(rng: () => number): Float32Array {
  const v = new Float32Array(DIMS).map(() => rng() + 0.01);
  const mag = Math.hypot(...v);
  return v.map((x) => x / mag);
}
const blob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

function openRaw(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { allowExtension: true });
  db.enableLoadExtension(true);
  req("sqlite-vec").load(db);
  return db;
}
function count(db: DatabaseSync, q: string, ...p: string[]): number {
  return Number((db.prepare(q).get(...p) as { c: number }).c);
}

const LEGACY_KB = `CREATE VIRTUAL TABLE kb_vec USING vec0(chunk_id TEXT PRIMARY KEY, owner_id TEXT partition key,
  owner_kind TEXT, embedding float[${DIMS}] distance_metric=cosine, updated_time TEXT DEFAULT '', chunk_size=8)`;
const LEGACY_L0 = `CREATE VIRTUAL TABLE l0_vec USING vec0(chunk_id TEXT PRIMARY KEY, record_id TEXT partition key,
  embedding float[${DIMS}] distance_metric=cosine, recorded_at TEXT DEFAULT '', chunk_size=8)`;

/** Legacy-layout fixture: 30 kb owners (every 5th has 2 chunks), 25 l0 records. */
function seedLegacy(file: string): { kbIds: string[]; l0Ids: string[] } {
  const db = openRaw(file);
  db.prepare(LEGACY_KB).run();
  db.prepare(LEGACY_L0).run();
  const rng = lcg(42);
  const kbIns = db.prepare("INSERT INTO kb_vec(chunk_id, owner_id, owner_kind, embedding, updated_time) VALUES (?,?,?,?,?)");
  const l0Ins = db.prepare("INSERT INTO l0_vec(chunk_id, record_id, embedding, recorded_at) VALUES (?,?,?,?)");
  const kbIds: string[] = [];
  const l0Ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const owner = `owner-number-${i}-long-enough-to-overflow`;
    kbIds.push(owner);
    for (let c = 0; c < (i % 5 === 0 ? 2 : 1); c++) {
      kbIns.run(`fact:${owner}#${c}`, owner, i % 2 ? "fact" : "event", blob(vec(rng)), `2026-01-${String(i + 1).padStart(2, "0")}`);
    }
  }
  for (let i = 0; i < 25; i++) {
    const rec = `rec-${i}-session-abcdef`;
    l0Ids.push(rec);
    l0Ins.run(`${rec}#0`, rec, blob(vec(rng)), `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`);
  }
  db.close();
  return { kbIds, l0Ids };
}

describe("compact vec0 layout", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-vec-compact-"));
    file = path.join(dir, "vectors.db");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("new path (fresh DB)", () => {
    it("creates compact kb_vec/l0_vec with owner side tables", () => {
      const store = new VectorStore(file, DIMS);
      store.init({ provider: "openai", model: "m" });
      store.close();
      const db = openRaw(file);
      expect(isLegacyVecSql(vecTableSql(db, "kb_vec"))).toBe(false);
      expect(isLegacyVecSql(vecTableSql(db, "l0_vec"))).toBe(false);
      expect(tableExists(db, "kb_vec_owner")).toBe(true);
      expect(tableExists(db, "l0_vec_owner")).toBe(true);
      db.close();
    });

    it("packs many single-vector owners into few chunks", () => {
      const store = new VectorStore(file, DIMS);
      store.init({ provider: "openai", model: "m" });
      const rng = lcg(7);
      for (let i = 0; i < 100; i++) store.upsertKbVector(`o${i}`, "fact", vec(rng), "t");
      store.close();
      const db = openRaw(file);
      expect(count(db, "SELECT count(*) c FROM kb_vec")).toBe(100);
      expect(count(db, "SELECT count(*) c FROM kb_vec_chunks")).toBe(1); // legacy: 100
      db.close();
    });

    it("delete-by-owner: re-upsert replaces ALL old chunks, leaves other owners alone", () => {
      const store = new VectorStore(file, DIMS);
      store.init({ provider: "openai", model: "m" });
      const rng = lcg(9);
      store.upsertKbVector("a", "fact", [vec(rng), vec(rng), vec(rng)], "t1"); // 3 chunks
      store.upsertKbVector("b", "fact", vec(rng), "t1");
      store.upsertKbVector("a", "fact", [vec(rng)], "t2"); // shrink 3 -> 1
      store.close();
      const db = openRaw(file);
      expect(count(db, "SELECT count(*) c FROM kb_vec WHERE owner_id = ?", "a")).toBe(1);
      expect(count(db, "SELECT count(*) c FROM kb_vec WHERE owner_id = ?", "b")).toBe(1);
      expect(count(db, "SELECT count(*) c FROM kb_vec")).toBe(2);
      expect(count(db, "SELECT count(*) c FROM kb_vec_owner WHERE owner_id = ?", "a")).toBe(1);
      expect(count(db, "SELECT count(*) c FROM kb_vec_owner")).toBe(2);
      db.close();
    });

    it("KNN returns the nearest owner with owner_kind intact", () => {
      const store = new VectorStore(file, DIMS);
      store.init({ provider: "openai", model: "m" });
      store.upsertKbVector("x", "fact", new Float32Array([1, 0, 0, 0]));
      store.upsertKbVector("y", "event", new Float32Array([0, 1, 0, 0]));
      const hits = store.searchKbVector(new Float32Array([0.9, 0.1, 0, 0]), 2);
      expect(hits[0]).toMatchObject({ owner_id: "x", owner_kind: "fact" });
      expect(hits.map((h) => h.owner_id)).toContain("y");
      expect(store.getAllKbVectors().length).toBe(2);
      store.close();
    });

    it("L0: replace, deleteL0, and TTL expiry keep vec + owner side table consistent", () => {
      const store = new VectorStore(file, DIMS);
      store.init({ provider: "openai", model: "m" });
      const rng = lcg(11);
      const rec = (id: string, at: string) => ({ id, sessionKey: "s", sessionId: "s", role: "user", messageText: `m ${id}`, recordedAt: at, timestamp: 1 });
      store.upsertL0(rec("r1", "2026-01-01T00:00:00Z"), vec(rng));
      store.upsertL0(rec("r1", "2026-01-01T00:00:00Z"), vec(rng)); // replace
      store.upsertL0(rec("r2", "2026-01-02T00:00:00Z"), vec(rng));
      store.upsertL0(rec("r3", "2026-06-01T00:00:00Z"), vec(rng));
      store.upsertL0(rec("meta-only", "2026-06-01T00:00:00Z"), undefined); // no vector
      let db = openRaw(file);
      expect(count(db, "SELECT count(*) c FROM l0_vec")).toBe(3);
      expect(count(db, "SELECT count(*) c FROM l0_vec_owner")).toBe(3);
      db.close();

      store.deleteL0("r2");
      expect(store.deleteL0Expired("2026-03-01T00:00:00Z")).toBe(1); // r1 expires
      store.close();
      db = openRaw(file);
      expect(count(db, "SELECT count(*) c FROM l0_vec")).toBe(1);
      expect(count(db, "SELECT count(*) c FROM l0_vec_owner")).toBe(1);
      expect(count(db, "SELECT count(*) c FROM l0_vec_owner WHERE record_id = ?", "r3")).toBe(1);
      db.close();
    });

    it("self-heals a missing owner side table from the vec rows", () => {
      const store = new VectorStore(file, DIMS);
      store.init({ provider: "openai", model: "m" });
      store.upsertKbVector("a", "fact", [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])]);
      store.close();
      let db = openRaw(file);
      db.prepare("DROP TABLE kb_vec_owner").run();
      db.close();
      const again = new VectorStore(file, DIMS);
      again.init();
      again.upsertKbVector("a", "fact", new Float32Array([0, 0, 1, 0])); // must delete both old chunks
      again.close();
      db = openRaw(file);
      expect(count(db, "SELECT count(*) c FROM kb_vec")).toBe(1);
      db.close();
    });
  });

  describe("old path (legacy DB not yet migrated)", () => {
    it("keeps the partition-key tables and still reads/writes/deletes correctly", () => {
      const { kbIds } = seedLegacy(file);
      const store = new VectorStore(file, DIMS);
      store.init(); // no providerInfo → no drop
      expect(store.isDegraded()).toBe(false);
      store.upsertKbVector(kbIds[0], "fact", new Float32Array([1, 0, 0, 0])); // had 2 chunks
      store.upsertKbVector("brand-new-owner", "fact", new Float32Array([0, 1, 0, 0]));
      const hits = store.searchKbVector(new Float32Array([0, 1, 0, 0]), 1);
      expect(hits[0].owner_id).toBe("brand-new-owner");
      store.close();
      const db = openRaw(file);
      expect(isLegacyVecSql(vecTableSql(db, "kb_vec"))).toBe(true);
      expect(tableExists(db, "kb_vec_owner")).toBe(false);
      expect(count(db, "SELECT count(*) c FROM kb_vec WHERE owner_id = ?", kbIds[0])).toBe(1);
      expect(count(db, "SELECT count(*) c FROM kb_vec")).toBe(36); // 36 seeded - 2 (owner 0) + 1 (replacement) + 1 (new owner)
      db.close();
    });
  });

  describe("migration", () => {
    function migrate(db: DatabaseSync, suffix = "20261003") {
      const res: Record<string, ReturnType<typeof buildStaging>> = {};
      for (const spec of [KB_VEC_SPEC, L0_VEC_SPEC]) {
        const built = buildStaging(db, spec, { batchSize: 7 });
        const v = verifyTables(db, spec, spec.table, `${spec.table}_new`, built.chunkIds, { sampleSize: 500, ownerTable: `${spec.table}_new_owner` });
        expect(v.problems).toEqual([]);
        res[spec.table] = built;
        swapTable(db, spec, suffix);
      }
      return res;
    }

    it("copies counts + bytes exactly, then swaps; gateway code runs on the compact tables", () => {
      const { kbIds } = seedLegacy(file);
      const db = openRaw(file);
      const before = {
        kb: db.prepare("SELECT chunk_id, owner_id, owner_kind, embedding, updated_time FROM kb_vec ORDER BY chunk_id").all() as Array<Record<string, unknown>>,
        l0: db.prepare("SELECT chunk_id, record_id, embedding, recorded_at FROM l0_vec ORDER BY chunk_id").all() as Array<Record<string, unknown>>,
      };
      const statsBefore = tableStats(db, KB_VEC_SPEC);
      expect(statsBefore.layout).toBe("legacy");
      expect(statsBefore.chunks).toBe(30); // one chunk per distinct owner (the bloat), not per 256 rows

      const built = migrate(db);
      expect(built.kb_vec.copied).toBe(36);
      expect(built.l0_vec.copied).toBe(25);
      db.close();

      const fresh = openRaw(file); // fresh connection: renamed shadows must resolve
      const after = {
        kb: fresh.prepare("SELECT chunk_id, owner_id, owner_kind, embedding, updated_time FROM kb_vec ORDER BY chunk_id").all() as Array<Record<string, unknown>>,
        l0: fresh.prepare("SELECT chunk_id, record_id, embedding, recorded_at FROM l0_vec ORDER BY chunk_id").all() as Array<Record<string, unknown>>,
      };
      expect(after.kb.length).toBe(before.kb.length);
      for (let i = 0; i < before.kb.length; i++) {
        expect(after.kb[i].chunk_id).toBe(before.kb[i].chunk_id);
        expect(after.kb[i].owner_id).toBe(before.kb[i].owner_id);
        expect(after.kb[i].owner_kind).toBe(before.kb[i].owner_kind);
        expect(after.kb[i].updated_time).toBe(before.kb[i].updated_time);
        expect(Buffer.compare(Buffer.from(after.kb[i].embedding as Uint8Array), Buffer.from(before.kb[i].embedding as Uint8Array))).toBe(0);
      }
      expect(after.l0.length).toBe(25);
      for (let i = 0; i < 25; i++) {
        expect(Buffer.compare(Buffer.from(after.l0[i].embedding as Uint8Array), Buffer.from(before.l0[i].embedding as Uint8Array))).toBe(0);
        expect(after.l0[i].record_id).toBe(before.l0[i].record_id);
      }
      const statsAfter = tableStats(fresh, KB_VEC_SPEC);
      expect(statsAfter.layout).toBe("compact");
      expect(statsAfter.chunks).toBe(1);
      expect(count(fresh, "SELECT count(*) c FROM kb_vec_owner")).toBe(36);
      // legacy table is parked, not dropped
      expect(count(fresh, "SELECT count(*) c FROM kb_vec_old_20261003")).toBe(36);
      fresh.close();

      // The store now takes the compact path on the migrated file: delete-by-owner works.
      const store = new VectorStore(file, DIMS);
      store.init();
      store.upsertKbVector(kbIds[0], "fact", new Float32Array([1, 0, 0, 0])); // had 2 chunks
      store.close();
      const db2 = openRaw(file);
      expect(count(db2, "SELECT count(*) c FROM kb_vec WHERE owner_id = ?", kbIds[0])).toBe(1);
      expect(count(db2, "SELECT count(*) c FROM kb_vec_owner WHERE owner_id = ?", kbIds[0])).toBe(1);
      db2.close();
    });

    it("KNN top-k is identical before and after (old table vs compact table)", () => {
      seedLegacy(file);
      const db = openRaw(file);
      migrate(db);
      db.close();
      const fresh = openRaw(file);
      const rng = lcg(1234);
      const qs = Array.from({ length: 20 }, () => vec(rng));
      for (const [table] of [["kb_vec"], ["l0_vec"]]) {
        const r = knnEquivalence(fresh, `${table}_old_20261003`, table, qs, 10);
        expect(r.different).toBe(0);
        expect(r.identical + r.tieOnly).toBe(20);
      }
      fresh.close();
    });

    it("is resumable/idempotent: a second build copies nothing; partial staging is completed", () => {
      seedLegacy(file);
      const db = openRaw(file);
      const first = buildStaging(db, KB_VEC_SPEC, { batchSize: 5 });
      expect(first.copied).toBe(36);
      const second = buildStaging(db, KB_VEC_SPEC, { batchSize: 5 });
      expect(second.copied).toBe(0);
      expect(second.skippedExisting).toBe(36);
      expect(second.newRows).toBe(36);
      // simulate an interruption: remove some staged rows (+ side rows), resume
      for (const id of first.chunkIds.slice(0, 10)) {
        db.prepare("DELETE FROM kb_vec_new WHERE chunk_id = ?").run(id);
        db.prepare("DELETE FROM kb_vec_new_owner WHERE chunk_id = ?").run(id);
      }
      const resumed = buildStaging(db, KB_VEC_SPEC, { batchSize: 5 });
      expect(resumed.copied).toBe(10);
      expect(resumed.newRows).toBe(36);
      expect(resumed.ownerRows).toBe(36);
      const v = verifyTables(db, KB_VEC_SPEC, "kb_vec", "kb_vec_new", resumed.chunkIds, { sampleSize: 1000, ownerTable: "kb_vec_new_owner" });
      expect(v.ok).toBe(true);
      expect(v.sampled).toBe(36);
      db.close();
    });

    it("verify detects a corrupted vector and a missing row", () => {
      seedLegacy(file);
      const db = openRaw(file);
      const built = buildStaging(db, KB_VEC_SPEC);
      db.prepare("DELETE FROM kb_vec_new WHERE chunk_id = ?").run(built.chunkIds[3]);
      db.prepare("DELETE FROM kb_vec_new WHERE chunk_id = ?").run(built.chunkIds[4]);
      db.prepare("INSERT INTO kb_vec_new(chunk_id, owner_id, owner_kind, embedding, updated_time) VALUES (?,?,?,?,?)")
        .run(built.chunkIds[3], "x", "fact", blob(new Float32Array([1, 2, 3, 4])), "");
      db.prepare("INSERT INTO kb_vec_new(chunk_id, owner_id, owner_kind, embedding, updated_time) VALUES (?,?,?,?,?)")
        .run(built.chunkIds[4], "y", "fact", blob(new Float32Array([1, 2, 3, 5])), "");
      const v = verifyTables(db, KB_VEC_SPEC, "kb_vec", "kb_vec_new", built.chunkIds, { sampleSize: 1000 });
      expect(v.ok).toBe(false);
      expect(v.problems.some((p) => p.includes("embedding bytes differ"))).toBe(true);
      // drop staging resets the state
      dropStaging(db, KB_VEC_SPEC);
      expect(tableExists(db, "kb_vec_new")).toBe(false);
      expect(tableExists(db, "kb_vec_new_owner")).toBe(false);
      expect(shadowTables(db, "kb_vec_new")).toEqual([]);
      db.close();
    });

    it("rollback restores the legacy table; cleanup drops parked legacy tables only", () => {
      seedLegacy(file);
      const db = openRaw(file);
      migrate(db);
      db.close();

      let c = openRaw(file);
      rollbackTable(c, KB_VEC_SPEC, "20261003");
      rollbackTable(c, L0_VEC_SPEC, "20261003");
      c.close();
      c = openRaw(file);
      expect(isLegacyVecSql(vecTableSql(c, "kb_vec"))).toBe(true);
      expect(count(c, "SELECT count(*) c FROM kb_vec")).toBe(36);
      expect(count(c, "SELECT count(*) c FROM kb_vec_compact_20261003")).toBe(36);
      expect(tableExists(c, "kb_vec_owner")).toBe(false);
      // and the store is happy on the restored legacy table
      c.close();
      const store = new VectorStore(file, DIMS);
      store.init();
      expect(store.upsertKbVector("z", "fact", new Float32Array([0, 0, 1, 0]))).toBe(true);
      store.close();

      // re-migrate under a new suffix, then cleanup the parked legacy tables
      c = openRaw(file);
      for (const spec of [KB_VEC_SPEC, L0_VEC_SPEC]) {
        dropStaging(c, spec);
        const b = buildStaging(c, spec);
        swapTable(c, spec, "20261004");
        expect(b.newRows).toBe(b.oldRows);
      }
      expect(cleanupTable(c, KB_VEC_SPEC, "20261004")).toBe(true);
      expect(tableExists(c, oldName(KB_VEC_SPEC, "20261004"))).toBe(false);
      expect(shadowTables(c, oldName(KB_VEC_SPEC, "20261004"))).toEqual([]);
      expect(count(c, "SELECT count(*) c FROM kb_vec")).toBe(37);
      expect(tableExists(c, "kb_vec_compact_20261003")).toBe(true); // other parked tables untouched
      c.close();
    });

    it("refuses to build from an already-compact table", () => {
      const store = new VectorStore(file, DIMS);
      store.init({ provider: "openai", model: "m" });
      store.close();
      const db = openRaw(file);
      expect(() => buildStaging(db, KB_VEC_SPEC)).toThrow(/already compact/);
      db.close();
    });
  });
});
