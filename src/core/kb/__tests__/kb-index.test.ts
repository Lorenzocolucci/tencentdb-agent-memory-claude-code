/**
 * Phase 2.1 / 2.2 hot-path indexes: entities_fts + event_entities.
 *
 * Real VectorStore on a throwaway DB (real SQLite, real triggers). The anti-no-op
 * guard is PARITY: for the same data, the indexed path must return what the legacy
 * scan returns (modulo the documented whole-word rule), and the indexed path must
 * not scan the entities table.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../../store/sqlite.js";
import {
  isKbIndexReady,
  isKbIndexBackfillEnabled,
  resetKbIndexReadyCache,
  runKbIndexBackfill,
} from "../kb-index.js";
import { mergeEntities } from "../entity-merge.js";

const NOW = "2026-10-01T10:00:00Z";

interface Ctx {
  dir: string;
  store: VectorStore;
  db: DatabaseSync;
}

function open(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kbindex-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 4);
  store.init({ provider: "openai", model: "text-embedding-3-small" });
  expect(store.isDegraded()).toBe(false);
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { dir, store, db };
}

function close(c: Ctx): void {
  try { c.store.close(); } catch { /* ignore */ }
  try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Pretend the DB predates the migration: indexes empty + not ready (triggers stay). */
function simulatePreMigration(db: DatabaseSync): void {
  db.prepare("DELETE FROM entities_fts").run();
  db.prepare("DELETE FROM event_entities").run();
  db.prepare("DELETE FROM kb_index_state").run();
  resetKbIndexReadyCache(db);
}

describe("entities_fts — entity lookup without a full scan", () => {
  let c: Ctx;
  beforeEach(() => { c = open(); });
  afterEach(() => close(c));

  it("a fresh database is ready immediately and finds entities by whole word (name, alias, canonical_key)", () => {
    expect(isKbIndexReady(c.db, "entities_fts")).toBe(true);
    const gw = c.store.resolveOrCreateEntity({ type: "project", name: "Sofia AI Gateway", aliases: ["voice platform"], now: NOW });
    c.store.resolveOrCreateEntity({ type: "project", name: "Dashboard", now: NOW });

    expect(c.store.queryEntitiesByTokens(["gateway"]).map((e) => e.id)).toEqual([gw.id]);
    expect(c.store.queryEntitiesByTokens(["platform"]).map((e) => e.id)).toEqual([gw.id]); // alias word
    expect(c.store.queryEntitiesByTokens(["Sofia"]).map((e) => e.id)).toEqual([gw.id]); // case-folded
    expect(c.store.queryEntitiesByTokens(["gate"])).toEqual([]); // whole-word: no substring match
  });

  it("ranks by the number of distinct query tokens matched", () => {
    const both = c.store.resolveOrCreateEntity({ type: "project", name: "recall timeout fix", now: NOW });
    const one = c.store.resolveOrCreateEntity({ type: "project", name: "recall engine", now: NOW });
    const ids = c.store.queryEntitiesByTokens(["recall", "timeout"]).map((e) => e.id);
    expect(ids[0]).toBe(both.id);
    expect(ids).toContain(one.id);
  });

  it("scopes by namespace and never returns an entity merged away", () => {
    const a = c.store.resolveOrCreateEntity({ type: "project", name: "Alpha Service", now: NOW });
    const b = c.store.resolveOrCreateEntity({ type: "project", name: "Alpha Svc", now: NOW });
    c.store.resolveOrCreateEntity({ namespace: "other", type: "project", name: "Alpha Elsewhere", now: NOW });
    expect(c.store.queryEntitiesByTokens(["alpha"]).map((e) => e.id).sort()).toEqual([a.id, b.id].sort());

    mergeEntities(c.db, { canonicalId: a.id, satelliteIds: [b.id] } as never, NOW);
    const after = c.store.queryEntitiesByTokens(["alpha"]).map((e) => e.id);
    expect(after).toEqual([a.id]); // satellite gone, canonical kept
    // the satellite's display name was folded into the canonical as an alias
    expect(c.store.queryEntitiesByTokens(["svc"]).map((e) => e.id)).toEqual([a.id]);
  });

  it("picks up a new alias written by a later resolveOrCreateEntity (trigger on UPDATE)", () => {
    const e = c.store.resolveOrCreateEntity({ type: "tool", name: "Vitest", now: NOW });
    expect(c.store.queryEntitiesByTokens(["runner"])).toEqual([]);
    c.store.resolveOrCreateEntity({ type: "tool", name: "Vitest", aliases: ["test runner"], now: NOW });
    expect(c.store.queryEntitiesByTokens(["runner"]).map((x) => x.id)).toEqual([e.id]);
  });

  it("does NOT execute the full 'SELECT * FROM entities' scan once the index is ready", () => {
    for (let i = 0; i < 30; i++) c.store.resolveOrCreateEntity({ type: "thing", name: `widget ${i} alpha`, now: NOW });
    const seen: string[] = [];
    const realPrepare = c.db.prepare.bind(c.db);
    (c.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      seen.push(sql);
      return realPrepare(sql);
    };
    const hits = c.store.queryEntitiesByTokens(["alpha"], "default", 20);
    expect(hits.length).toBe(20);
    expect(seen.filter((s) => /SELECT \* FROM entities WHERE namespace = \?/.test(s))).toEqual([]);
  });

  it("falls back to the legacy scan (substring semantics) while the index is NOT backfilled", () => {
    const e = c.store.resolveOrCreateEntity({ type: "project", name: "Sofia AI Gateway", now: NOW });
    simulatePreMigration(c.db);
    expect(isKbIndexReady(c.db, "entities_fts")).toBe(false);
    // legacy: substring "gate" matches "gateway" — proves the old path is what answered
    expect(c.store.queryEntitiesByTokens(["gate"]).map((x) => x.id)).toEqual([e.id]);
  });
});

describe("event_entities — event↔entity join without LIKE scans", () => {
  let c: Ctx;
  beforeEach(() => { c = open(); });
  afterEach(() => close(c));

  const ev = (store: VectorStore, ts: string, entities: string[], text = "x") =>
    store.insertEvent({ ts, sessionKey: "sk", type: "event", text, entities, sourceMessageIds: [] } as never);

  it("is filled by insertEvent and queryEventsForEntity returns exactly the legacy result (newest first, exact id membership)", () => {
    const e1 = c.store.resolveOrCreateEntity({ type: "project", name: "One", now: NOW });
    const e2 = c.store.resolveOrCreateEntity({ type: "project", name: "Two", now: NOW });
    const a = ev(c.store, "2026-10-01T10:00:00Z", [e1.id]);
    const b = ev(c.store, "2026-10-01T11:00:00Z", [e1.id, e2.id]);
    ev(c.store, "2026-10-01T12:00:00Z", [e2.id]);
    ev(c.store, "2026-10-01T13:00:00Z", []);

    const rows = c.db.prepare("SELECT COUNT(*) AS n FROM event_entities").get() as { n: number };
    expect(rows.n).toBe(4); // (a,e1) (b,e1) (b,e2) (c,e2)

    const fast = c.store.queryEventsForEntity(e1.id).map((x) => x.id);
    expect(fast).toEqual([b.id, a.id]);

    simulatePreMigration(c.db);
    const legacy = c.store.queryEventsForEntity(e1.id).map((x) => x.id);
    expect(legacy).toEqual(fast);
  });

  it("honours the limit and the namespace", () => {
    const e = c.store.resolveOrCreateEntity({ type: "project", name: "Lim", now: NOW });
    for (let i = 0; i < 5; i++) ev(c.store, `2026-10-01T1${i}:00:00Z`, [e.id]);
    c.store.insertEvent({ ts: "2026-10-02T00:00:00Z", sessionKey: "sk", type: "event", text: "o", namespace: "other", entities: [e.id], sourceMessageIds: [] } as never);
    expect(c.store.queryEventsForEntity(e.id, "default", 3).length).toBe(3);
    expect(c.store.queryEventsForEntity(e.id, "other", 10).length).toBe(1);
  });

  it("stays in sync when mergeEntities re-keys entities_json (UPDATE trigger)", () => {
    const canon = c.store.resolveOrCreateEntity({ type: "project", name: "Canon", now: NOW });
    const sat = c.store.resolveOrCreateEntity({ type: "project", name: "Sat", now: NOW });
    const e = ev(c.store, "2026-10-01T10:00:00Z", [sat.id]);
    expect(c.store.queryEventsForEntity(sat.id).map((x) => x.id)).toEqual([e.id]);

    mergeEntities(c.db, { canonicalId: canon.id, satelliteIds: [sat.id] } as never, NOW);
    expect(c.store.queryEventsForEntity(canon.id).map((x) => x.id)).toEqual([e.id]);
    expect(c.store.queryEventsForEntity(sat.id)).toEqual([]);
  });

  it("candidateAdjacency: indexed co-occurrence equals the legacy LIKE scan", () => {
    const ids = ["A", "B", "C", "D"].map((n) => c.store.resolveOrCreateEntity({ type: "thing", name: `Ent${n}`, now: NOW }).id);
    ev(c.store, "2026-10-01T10:00:00Z", [ids[0]!, ids[1]!]);
    ev(c.store, "2026-10-01T11:00:00Z", [ids[0]!, ids[1]!, ids[2]!]);
    ev(c.store, "2026-10-01T12:00:00Z", [ids[2]!, ids[3]!]);

    const norm = (m: Map<string, Array<{ id: string; weight: number }>>) =>
      [...m].map(([k, v]) => [k, v.map((x) => `${x.id}:${x.weight}`).sort()] as const).sort((x, y) => x[0].localeCompare(y[0]));
    const fast = norm(c.store.candidateAdjacency(ids));
    expect(fast.length).toBeGreaterThan(0);

    simulatePreMigration(c.db);
    expect(norm(c.store.candidateAdjacency(ids))).toEqual(fast);
  });
});

describe("backfill — opt-in, batched, yielding, resumable", () => {
  let c: Ctx;
  beforeEach(() => { c = open(); });
  afterEach(() => close(c));

  it("TDAI_KB_INDEX_BACKFILL is OFF by default and parsed strictly", () => {
    expect(isKbIndexBackfillEnabled({})).toBe(false);
    expect(isKbIndexBackfillEnabled({ TDAI_KB_INDEX_BACKFILL: "0" })).toBe(false);
    expect(isKbIndexBackfillEnabled({ TDAI_KB_INDEX_BACKFILL: "1" })).toBe(true);
    expect(isKbIndexBackfillEnabled({ TDAI_KB_INDEX_BACKFILL: "true" })).toBe(true);
  });

  function seed(n: number): { entityIds: string[]; eventIds: string[] } {
    const entityIds: string[] = [];
    for (let i = 0; i < n; i++) entityIds.push(c.store.resolveOrCreateEntity({ type: "thing", name: `seed entity ${i}`, now: NOW }).id);
    const eventIds: string[] = [];
    for (let i = 0; i < n; i++) {
      eventIds.push(c.store.insertEvent({
        ts: `2026-10-01T10:${String(i % 60).padStart(2, "0")}:00Z`, sessionKey: "sk", type: "event", text: `e${i}`,
        entities: [entityIds[i]!, entityIds[(i + 1) % n]!], sourceMessageIds: [],
      } as never).id);
    }
    return { entityIds, eventIds };
  }

  it("backfills in several yielding batches, flips readiness only at the end, and matches the trigger-built index", async () => {
    seed(60);
    const expectedFts = (c.db.prepare("SELECT COUNT(*) AS n FROM entities_fts").get() as { n: number }).n;
    const expectedEe = (c.db.prepare("SELECT COUNT(*) AS n FROM event_entities").get() as { n: number }).n;
    simulatePreMigration(c.db);
    expect(isKbIndexReady(c.db, "entities_fts")).toBe(false);

    let yields = 0;
    const res = await runKbIndexBackfill(c.db, { chunkRows: 7, batchMs: 1000, yieldFn: async () => { yields++; await Promise.resolve(); } });
    expect(res.done).toBe(true);
    expect(res.entitiesIndexed).toBe(60);
    expect(res.eventsIndexed).toBe(60);
    expect(yields).toBeGreaterThan(10); // 60/7 batches per index → many yields, never one big block
    expect((c.db.prepare("SELECT COUNT(*) AS n FROM entities_fts").get() as { n: number }).n).toBe(expectedFts);
    expect((c.db.prepare("SELECT COUNT(*) AS n FROM event_entities").get() as { n: number }).n).toBe(expectedEe);
    expect(isKbIndexReady(c.db, "entities_fts")).toBe(true);
    expect(isKbIndexReady(c.db, "event_entities")).toBe(true);
  });

  it("each batch is time-bounded: a tiny batchMs makes batches shorter, not the run longer", async () => {
    seed(40);
    simulatePreMigration(c.db);
    const res = await runKbIndexBackfill(c.db, { chunkRows: 200, batchMs: 0, yieldFn: () => Promise.resolve() });
    expect(res.done).toBe(true);
    expect(res.batches).toBeGreaterThan(40); // batchMs=0 → one row per batch
  });

  it("is resumable: aborting mid-way keeps the cursor, never marks ready, and a second run completes", async () => {
    seed(30);
    simulatePreMigration(c.db);
    let batches = 0;
    const first = await runKbIndexBackfill(c.db, {
      chunkRows: 5, batchMs: 1000,
      isClosed: () => batches >= 3,
      yieldFn: async () => { batches++; },
    });
    expect(first.done).toBe(false);
    expect(isKbIndexReady(c.db, "entities_fts")).toBe(false);
    const cursor = c.db.prepare("SELECT value FROM kb_index_state WHERE name = 'entities_fts_cursor'").get() as { value: string };
    expect(Number(cursor.value)).toBeGreaterThan(0);

    const second = await runKbIndexBackfill(c.db, { chunkRows: 5, batchMs: 1000 });
    expect(second.done).toBe(true);
    expect(first.entitiesIndexed + second.entitiesIndexed).toBe(30);
    // idempotent: a third run does nothing
    const third = await runKbIndexBackfill(c.db, {});
    expect(third.entitiesIndexed + third.eventsIndexed).toBe(0);
  });

  it("only writes to the two new tables + kb_index_state (existing rows are never modified)", async () => {
    seed(20);
    const snap = () => JSON.stringify([
      c.db.prepare("SELECT * FROM entities ORDER BY id").all(),
      c.db.prepare("SELECT * FROM events ORDER BY id").all(),
      c.db.prepare("SELECT * FROM facts ORDER BY id").all(),
    ]);
    simulatePreMigration(c.db);
    const before = snap();
    await runKbIndexBackfill(c.db, { chunkRows: 6 });
    expect(snap()).toBe(before);
  });
});
