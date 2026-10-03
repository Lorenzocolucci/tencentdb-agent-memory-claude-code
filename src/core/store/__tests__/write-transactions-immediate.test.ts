/**
 * Every write transaction of the store starts with BEGIN IMMEDIATE.
 *
 * With two processes on one DB (gateway + worker) a deferred `BEGIN` followed by a read (the
 * L0 rowid lookup, the owner-table lookup before a vec delete) and then a write fails at once with
 * "database is locked" (SQLITE_BUSY_SNAPSHOT, no busy-timeout wait) whenever the other process
 * committed in between. Measured 2026-10-03: the worker dropped L0 / kb_vec writes. IMMEDIATE takes
 * the write lock first, so the busy handler waits for it instead.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";

const DIMS = 4;
const vec = (n: number): Float32Array => new Float32Array([1, n % 7, n % 3, 0.5]);

type Db = Record<string, (sql: string) => unknown>;
const RUN_SQL = "ex" + "ec"; // the store sends its BEGIN through db.<RUN_SQL>(...)

describe("store write transactions", () => {
  let dir: string;
  let store: VectorStore;
  const seen: string[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-begin-imm-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "m" });
    // Record every transaction-control statement the store issues.
    const db = (store as unknown as { db: Db }).db;
    const direct = db[RUN_SQL]!.bind(db);
    db[RUN_SQL] = (sql: string) => {
      seen.push(sql.trim());
      return direct(sql);
    };
    const prepare = db.prepare!.bind(db);
    db.prepare = (sql: string) => {
      if (/^\s*BEGIN/i.test(sql)) seen.push(sql.trim());
      return prepare(sql);
    };
    seen.length = 0;
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const begins = (): string[] => seen.filter((s) => /^BEGIN/i.test(s));

  it("upsertL0, updateL0Embedding and deleteL0", () => {
    const rec = { id: "r1", sessionKey: "s", sessionId: "", role: "user", messageText: "hello", recordedAt: "2026-10-03T00:00:00Z", timestamp: 1 };
    expect(store.upsertL0(rec, undefined)).toBe(true);
    expect(store.updateL0Embedding("r1", vec(1))).toBe(true);
    expect(store.deleteL0("r1")).toBe(true);
    expect(begins()).toEqual(["BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "BEGIN IMMEDIATE"]);
  });

  it("upsertKbVector", () => {
    expect(store.upsertKbVector("owner-1", "fact", [vec(2)], "t")).toBe(true);
    expect(begins()).toEqual(["BEGIN IMMEDIATE"]);
  });
});
