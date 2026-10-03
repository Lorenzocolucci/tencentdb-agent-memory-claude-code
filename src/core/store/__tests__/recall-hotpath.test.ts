/**
 * Phase 2 recall hot-path behaviours of VectorStore (real SQLite + sqlite-vec):
 *   2.3 getMemoryHealth: recent-window query + 5-minute cache
 *   2.4 short busy_timeout for recall-path writes; no redundant session registry writes
 *   2.5 no brute-force kb_vec KNN when the caller opts out
 *   2.6 getAllKbVectorsAsync: same rows as the sync read, yields every 2k rows
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../sqlite.js";

const DIMS = 8;
const unit = (i: number): Float32Array => {
  const v = new Float32Array(DIMS);
  v[i % DIMS] = 1;
  return v;
};

describe("VectorStore recall hot path", () => {
  let dir: string;
  let store: VectorStore;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-hotpath-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    db = (store as unknown as { db: DatabaseSync }).db;
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe("2.5 searchKbVector brute-force opt-out", () => {
    it("default keeps the brute-force fallback; allowBruteForce:false returns [] while no index is published", async () => {
      store.upsertKbVector("fact_a", "fact", [unit(0)], "t");
      store.upsertKbVector("fact_b", "fact", [unit(1)], "t");
      expect(store.isKbNavIndexActive()).toBe(false);

      const viaScan = store.searchKbVector(unit(0), 2);
      expect(viaScan[0]?.owner_id).toBe("fact_a"); // legacy behaviour untouched

      expect(store.searchKbVector(unit(0), 2, undefined, { allowBruteForce: false })).toEqual([]);

      await store.buildKbNavIndex();
      expect(store.isKbNavIndexActive()).toBe(true);
      const viaIndex = store.searchKbVector(unit(0), 2, undefined, { allowBruteForce: false });
      expect(viaIndex[0]?.owner_id).toBe("fact_a"); // published index still answers
    });

    it("an index that returns nothing after the kind filter is NOT retried by brute force when opted out", async () => {
      store.upsertKbVector("fact_a", "fact", [unit(0)], "t");
      await store.buildKbNavIndex();
      const scan = vi.spyOn(db, "prepare");
      const out = store.searchKbVector(unit(0), 2, "event", { allowBruteForce: false });
      expect(out).toEqual([]);
      expect(scan.mock.calls.filter((c) => /FROM kb_vec/.test(String(c[0])))).toEqual([]);
    });
  });

  describe("2.6 getAllKbVectorsAsync", () => {
    it("returns the same rows as the synchronous read", async () => {
      for (let i = 0; i < 6; i++) store.upsertKbVector(`own_${i}`, i % 2 ? "fact" : "event", [unit(i), unit(i + 1)], "t");
      const sync = store.getAllKbVectors().map((r) => r.chunkId).sort();
      const asyncRows = (await store.getAllKbVectorsAsync()).map((r) => r.chunkId).sort();
      expect(asyncRows.length).toBe(12);
      expect(asyncRows).toEqual(sync);
    });

    it("yields to the event loop every 2000 rows instead of one long block", async () => {
      const insert = (store as unknown as { stmtKbVecInsert: { run: (...a: unknown[]) => unknown } }).stmtKbVecInsert;
      db.prepare("BEGIN").run();
      for (let i = 0; i < 4500; i++) {
        insert.run(`fact:o${i}#0`, `o${i}`, "fact", Buffer.from(unit(i).buffer), "t");
      }
      db.prepare("COMMIT").run();

      const spy = vi.spyOn(globalThis, "setImmediate");
      const rows = await store.getAllKbVectorsAsync();
      expect(rows.length).toBe(4500);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2); // 2000 and 4000
      spy.mockRestore();
    });
  });

  describe("2.3 getMemoryHealth", () => {
    const NOW = Date.parse("2026-07-05T12:00:00Z");
    const l0 = (id: string, sk: string, iso: string) => ({
      id, sessionKey: sk, sessionId: "s", role: "user" as const,
      messageText: "x", recordedAt: iso, timestamp: Math.floor(Date.parse(iso) / 1000),
    });

    it("caches for 5 minutes (same answer), then recomputes", () => {
      store.upsertL0(l0("m1", "sk-a", "2026-07-05T11:00:00Z"), [new Float32Array(DIMS).fill(0.1)]);
      store.insertEvent({ ts: "2026-07-05T11:30:00Z", sessionKey: "sk-a", sessionId: "s", type: "event", text: "ok", sourceMessageIds: [] } as never);
      expect(store.getMemoryHealth(NOW).healthy).toBe(true);

      // A session turns stale (events 3 days behind a fresh L0)…
      store.upsertL0(l0("m2", "sk-b", "2026-07-05T11:30:00Z"), [new Float32Array(DIMS).fill(0.2)]);
      store.insertEvent({ ts: "2026-07-02T10:00:00Z", sessionKey: "sk-b", sessionId: "s", type: "event", text: "old", sourceMessageIds: [] } as never);
      // …inside the window the cached verdict is served,
      expect(store.getMemoryHealth(NOW + 60_000).healthy).toBe(true);
      // …after 5 minutes it is recomputed against the DB.
      const fresh = store.getMemoryHealth(NOW + 6 * 60_000);
      expect(fresh.healthy).toBe(false);
      expect(fresh.stale[0]?.sessionKey).toBe("sk-b");
    });

    it("does not group the whole L0 table: the recent-window query is bounded by recorded_at", () => {
      store.upsertL0(l0("old", "sk-old", "2026-01-01T10:00:00Z"), [new Float32Array(DIMS).fill(0.3)]);
      const spy = vi.spyOn(db, "prepare");
      store.getMemoryHealth(NOW);
      const sql = spy.mock.calls.map((c) => String(c[0]));
      expect(sql.some((s) => /FROM l0_conversations/.test(s) && /recorded_at > \?/.test(s))).toBe(true);
      expect(sql.some((s) => /FROM l0_conversations l GROUP BY/.test(s))).toBe(false);
    });

    it("unchanged semantics: never-extracted session uses the session's oldest L0 as baseline", () => {
      store.setSessionProject("sk-backlog", "Sofia-AI");
      store.upsertL0(l0("a", "sk-backlog", "2026-07-03T11:00:00Z"), [new Float32Array(DIMS).fill(0.4)]);
      store.upsertL0(l0("b", "sk-backlog", "2026-07-05T11:00:00Z"), [new Float32Array(DIMS).fill(0.5)]);
      const h = store.getMemoryHealth(NOW);
      expect(h.healthy).toBe(false);
      expect(h.stale[0]?.project).toBe("Sofia-AI");
      expect(h.stale[0]?.lagHours).toBe(48);
    });
  });

  describe("2.4 recall-path writes", () => {
    it("runWithShortBusyTimeout lowers busy_timeout inside the callback and restores 5000 after", () => {
      const read = () => (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
      expect(read()).toBe(5000);
      const inside = store.runWithShortBusyTimeout(() => read(), 200);
      expect(inside).toBe(200);
      expect(read()).toBe(5000);
      expect(() => store.runWithShortBusyTimeout(() => { throw new Error("boom"); })).toThrow("boom");
      expect(read()).toBe(5000); // restored even when the callback throws
    });

    it("setSessionProject skips the redundant write but never skips a CHANGED project", () => {
      const spy = vi.spyOn(db, "prepare");
      const writes = () => spy.mock.calls.filter((c) => /INSERT INTO session_projects/.test(String(c[0]))).length;
      store.setSessionProject("sk", "Alpha");
      store.setSessionProject("sk", "Alpha");
      store.setSessionProject("sk", "Alpha");
      expect(writes()).toBe(1);
      expect(store.getSessionProject("sk")).toBe("Alpha");
      store.setSessionProject("sk", "Beta");
      expect(writes()).toBe(2);
      expect(store.getSessionProject("sk")).toBe("Beta");
    });
  });
});
