import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const DIMS = 4;

/** L2-normalize a raw vector (matches the store's cosine expectations). */
function normalize(values: number[]): Float32Array {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return new Float32Array(values.map((v) => v / mag));
}

function makeRecord(id: string, content: string): MemoryRecord {
  const now = "2024-01-01T00:00:00.000Z";
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey: "sess",
    sessionId: "sid",
  };
}

describe("VectorStore chunked vectors (temp DB)", () => {
  let dir: string;
  let dbPath: string;
  let store: VectorStore;

  beforeEach(() => {
    // Throwaway temp dir — NEVER the live store.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-chunk-test-"));
    dbPath = path.join(dir, "vectors.db");
    store = new VectorStore(dbPath, DIMS);
    const res = store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    // Fresh DB → fresh chunked schema, no reindex needed.
    expect(res.needsReindex).toBe(false);
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates the CHUNKED vec0 schema (chunk_id PK + record_id partition key)", () => {
    const sql = (store as unknown as {
      db: { prepare: (q: string) => { get: (n: string) => { sql: string } } };
    }).db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get("l1_vec").sql;
    expect(sql).toMatch(/chunk_id/i);
    expect(sql).toMatch(/partition key/i);
    expect(sql).toMatch(/float\[4\]/);
  });

  it("persists MULTIPLE vectors for a single record (one per chunk)", () => {
    const chunks = [normalize([1, 0, 0, 0]), normalize([0.9, 0.1, 0, 0]), normalize([0.8, 0.2, 0, 0])];
    const ok = store.upsertL1(makeRecord("rec-A", "long content split into chunks"), chunks);
    expect(ok).toBe(true);

    const count = (store as unknown as {
      db: { prepare: (q: string) => { get: () => { c: number } } };
    }).db
      .prepare("SELECT count(*) AS c FROM l1_vec WHERE record_id = 'rec-A'")
      .get().c;
    expect(count).toBe(3);
  });

  it("recall DE-DUPS by record: multiple matching chunks → record returned ONCE", () => {
    // Record A: 3 chunks, all close to the query → would yield 3 raw hits.
    store.upsertL1(makeRecord("rec-A", "alpha chunked memory"), [
      normalize([1, 0, 0, 0]),
      normalize([0.99, 0.01, 0, 0]),
      normalize([0.98, 0.02, 0, 0]),
    ]);
    // Record B: 1 chunk, further from the query.
    store.upsertL1(makeRecord("rec-B", "beta single memory"), [normalize([0, 1, 0, 0])]);

    const results = store.searchL1Vector(normalize([1, 0, 0, 0]), 5);

    const ids = results.map((r) => r.record_id);
    // rec-A appears exactly once despite 3 matching chunks.
    expect(ids.filter((id) => id === "rec-A")).toHaveLength(1);
    // Both distinct records are recalled.
    expect(new Set(ids)).toEqual(new Set(["rec-A", "rec-B"]));
    // Best (closest) record ranks first.
    expect(results[0].record_id).toBe("rec-A");
  });

  it("re-upserting a record REPLACES its chunks (idempotent, no orphans)", () => {
    const rec = makeRecord("rec-C", "content");
    store.upsertL1(rec, [normalize([1, 0, 0, 0]), normalize([0.9, 0.1, 0, 0])]);
    // Re-upsert with a single chunk → old 2 chunks deleted, 1 inserted.
    store.upsertL1(rec, [normalize([0.5, 0.5, 0, 0])]);

    const count = (store as unknown as {
      db: { prepare: (q: string) => { get: () => { c: number } } };
    }).db
      .prepare("SELECT count(*) AS c FROM l1_vec WHERE record_id = 'rec-C'")
      .get().c;
    expect(count).toBe(1);
  });

  it("a single Float32Array is treated as ONE chunk (backward compatible)", () => {
    store.upsertL1(makeRecord("rec-D", "single vector record"), normalize([1, 0, 0, 0]));
    const results = store.searchL1Vector(normalize([1, 0, 0, 0]), 5);
    expect(results.map((r) => r.record_id)).toContain("rec-D");
  });

  it("L0 chunked recall also de-dups by record", () => {
    store.upsertL0(
      { id: "l0-A", sessionKey: "s", sessionId: "i", role: "user", messageText: "long msg", recordedAt: "2024-01-01T00:00:00.000Z", timestamp: 1 },
      [normalize([1, 0, 0, 0]), normalize([0.99, 0.01, 0, 0])],
    );
    const results = store.searchL0Vector(normalize([1, 0, 0, 0]), 5);
    expect(results.filter((r) => r.record_id === "l0-A")).toHaveLength(1);
  });
});

describe("VectorStore legacy-schema migration (temp DB)", () => {
  it("detects legacy single-vector vec0 schema and migrates to chunked, flagging reindex", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-migrate-test-"));
    const dbPath = path.join(dir, "vectors.db");

    try {
      // Build a LEGACY DB by hand: chunked-incompatible vec0 (record_id PK, no chunk_id)
      // plus a populated metadata table so the migration flags a reindex.
      const { createRequire } = require("node:module") as typeof import("node:module");
      const req = createRequire(import.meta.url);
      const { DatabaseSync } = req("node:sqlite") as typeof import("node:sqlite");
      const sqliteVec = req("sqlite-vec") as { load: (db: unknown) => void };
      const raw = new DatabaseSync(dbPath, { allowExtension: true });
      sqliteVec.load(raw);
      raw.exec(`CREATE TABLE l1_records (
        record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50, scene_name TEXT DEFAULT '', session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT '', timestamp_str TEXT DEFAULT '', timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '', created_time TEXT DEFAULT '', updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}')`);
      raw.exec(`CREATE VIRTUAL TABLE l1_vec USING vec0(
        record_id TEXT PRIMARY KEY, embedding float[4] distance_metric=cosine, updated_time TEXT DEFAULT '')`);
      raw.prepare("INSERT INTO l1_records(record_id, content) VALUES (?, ?)").run("old-1", "legacy text");
      raw.close();

      // Now open via VectorStore — should migrate.
      const store = new VectorStore(dbPath, 4);
      const res = store.init({ provider: "openai", model: "text-embedding-3-small" });
      expect(store.isDegraded()).toBe(false);
      // Metadata preserved.
      const metaCount = (store as unknown as {
        db: { prepare: (q: string) => { get: () => { c: number } } };
      }).db.prepare("SELECT count(*) AS c FROM l1_records").get().c;
      expect(metaCount).toBe(1);
      // vec table rebuilt with chunked schema.
      const sql = (store as unknown as {
        db: { prepare: (q: string) => { get: (n: string) => { sql: string } } };
      }).db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get("l1_vec").sql;
      expect(sql).toMatch(/chunk_id/i);
      // Reindex flagged because data existed.
      expect(res.needsReindex).toBe(true);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
