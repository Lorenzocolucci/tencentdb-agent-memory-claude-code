/**
 * Phase 1 KB data-layer tests.
 *
 * ALL tests run on a THROWAWAY temp DB (NEVER the live vectors.db). They cover
 * the invariants that make the entity-centric core trustworthy:
 *   - head uniqueness per (entity, attribute)
 *   - supersession keeps the old row (valid_to + superseded_by set) — never deletes
 *   - same-value corroboration -> support++ and NO new version
 *   - older-than-head value -> closed historical row, head untouched
 *   - deterministic entity resolution (same ns/type/name -> same id; aliases merge)
 *   - relation upsert idempotent (support++)
 *   - idempotent re-apply of the same fact set -> identical head state
 *   - empty-DB init works
 *   - a DB pre-seeded with ONLY the old l0_ / l1_ tables opens and GAINS the new tables
 *   - kb_vec / kb_fts recall round-trip
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { VectorStore } from "../../store/sqlite.js";
import {
  canonicalKey,
  entityId,
  relationId,
  ulidLike,
  _resetUlidStateForTest,
} from "../kb-queries.js";

const DIMS = 4;
const NOW = "2024-06-01T00:00:00.000Z";

/** L2-normalize a raw vector (cosine expectations). */
function normalize(values: number[]): Float32Array {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return new Float32Array(values.map((v) => v / mag));
}

/** Direct DB row reader for assertions (bypasses the typed mappers). */
function dbAll(store: VectorStore, sql: string, ...args: unknown[]): Record<string, unknown>[] {
  const handle = (store as unknown as {
    db: { prepare: (q: string) => { all: (...a: unknown[]) => Record<string, unknown>[] } };
  }).db;
  return handle.prepare(sql).all(...args);
}

describe("kb-queries pure helpers", () => {
  beforeEach(() => _resetUlidStateForTest());

  it("canonicalKey: NFKC + lowercase + trim, type-prefixed", () => {
    expect(canonicalKey("concept", "  TypeScript  ")).toBe("concept:typescript");
    // Same name, different type -> different key.
    expect(canonicalKey("person", "Sofia")).not.toBe(canonicalKey("project", "Sofia"));
  });

  it("canonicalKey file: posix-normalizes the path", () => {
    expect(canonicalKey("file", "C:\\Users\\lo\\App.ts")).toBe("file:c:/users/lo/app.ts");
    expect(canonicalKey("file", "src//core///x.ts/")).toBe("file:src/core/x.ts");
  });

  it("canonicalKey library: strips version suffix", () => {
    expect(canonicalKey("library", "react@18.2.0")).toBe("library:react");
    expect(canonicalKey("library", "react 18")).toBe("library:react");
    expect(canonicalKey("library", "react")).toBe("library:react");
    expect(canonicalKey("library", "node-llama-cpp@^3.16.2")).toBe("library:node-llama-cpp");
  });

  it("entityId/relationId are deterministic", () => {
    expect(entityId("default", "concept", "concept:typescript")).toBe(
      entityId("default", "concept", "concept:typescript"),
    );
    expect(entityId("default", "concept", "a")).not.toBe(entityId("default", "concept", "b"));
    expect(relationId("default", "ent_a", "uses", "ent_b")).toBe(
      relationId("default", "ent_a", "uses", "ent_b"),
    );
  });

  it("ulidLike ids are time-sortable (monotonic within a ms)", () => {
    const a = ulidLike("fact", 1000);
    const b = ulidLike("fact", 1000); // same ms -> counter bumps
    const c = ulidLike("fact", 2000); // later ms
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(a.startsWith("fact_")).toBe(true);
  });
});

describe("KB data layer (temp DB)", () => {
  let dir: string;
  let dbPath: string;
  let store: VectorStore;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kb-test-"));
    dbPath = path.join(dir, "vectors.db");
    store = new VectorStore(dbPath, DIMS);
    const res = store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    expect(res.needsReindex).toBe(false);
    expect(store.isKbReady()).toBe(true);
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates the 6 KB tables + recall surfaces (additive, l0_/l1_ untouched)", () => {
    const names = dbAll(
      store,
      "SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name",
    ).map((r) => r.name as string);
    for (const t of ["entities", "facts", "events", "relations", "kb_vec", "kb_fts"]) {
      expect(names).toContain(t);
    }
    // Existing tables are still present (not dropped/altered).
    for (const t of ["l1_records", "l0_conversations", "l1_vec", "l0_vec", "l1_fts", "l0_fts"]) {
      expect(names).toContain(t);
    }
  });

  it("kb_vec uses the chunked owner-partitioned vec0 schema with the right dims", () => {
    const sql = (dbAll(store, "SELECT sql FROM sqlite_master WHERE name='kb_vec'")[0].sql) as string;
    expect(sql).toMatch(/chunk_id/i);
    expect(sql).toMatch(/owner_id/i);
    expect(sql).toMatch(/partition key/i);
    expect(sql).toMatch(/float\[4\]/);
  });

  // -- Entity resolution --------------------------------------------------

  it("resolveOrCreateEntity: same ns/type/name -> SAME entity id (deterministic)", () => {
    const a = store.resolveOrCreateEntity({ type: "concept", name: "TypeScript", now: NOW });
    const b = store.resolveOrCreateEntity({ type: "concept", name: "  typescript ", now: NOW });
    expect(b.id).toBe(a.id);
    expect(a.id).toBe(entityId("default", "concept", "concept:typescript"));
    // Exactly one row.
    expect(dbAll(store, "SELECT count(*) AS c FROM entities")[0].c).toBe(1);
  });

  it("resolveOrCreateEntity: different type with same name -> DIFFERENT entity", () => {
    const person = store.resolveOrCreateEntity({ type: "person", name: "Sofia", now: NOW });
    const project = store.resolveOrCreateEntity({ type: "project", name: "Sofia", now: NOW });
    expect(person.id).not.toBe(project.id);
    expect(dbAll(store, "SELECT count(*) AS c FROM entities")[0].c).toBe(2);
  });

  it("resolveOrCreateEntity: alias match merges name into aliases (no duplicate entity)", () => {
    // Seed an entity that already lists "TS" as an alias.
    const created = store.resolveOrCreateEntity({
      type: "concept",
      name: "TypeScript",
      aliases: ["TS"],
      now: NOW,
    });
    // A later observation that uses the alias "TS" as the NAME must resolve to
    // the same entity, and the new display spelling is merged into aliases.
    const viaAlias = store.resolveOrCreateEntity({ type: "concept", name: "TS", now: NOW });
    expect(viaAlias.id).toBe(created.id);
    expect(dbAll(store, "SELECT count(*) AS c FROM entities")[0].c).toBe(1);
    // The alias set now contains the original alias plus the new spelling.
    const aliases = viaAlias.aliases.map((a) => a.toLowerCase());
    expect(aliases).toContain("ts");
  });

  it("queryEntityById / queryEntityByKey round-trip", () => {
    const e = store.resolveOrCreateEntity({ type: "library", name: "react@18", now: NOW });
    expect(store.queryEntityById(e.id)?.id).toBe(e.id);
    expect(store.queryEntityByKey("default", "library", "library:react")?.id).toBe(e.id);
    expect(store.queryEntityById("ent_does_not_exist")).toBeNull();
  });

  // -- Events (append-only) -----------------------------------------------

  it("insertEvent: append-only, time-sortable id, persists provenance", () => {
    const e1 = store.insertEvent({
      ts: NOW,
      sessionKey: "sess-1",
      type: "decision",
      text: "chose sqlite-vec",
      entities: ["ent_x"],
      sourceMessageIds: ["msg-1", "msg-2"],
    });
    expect(e1.id.startsWith("evt_")).toBe(true);
    const row = dbAll(store, "SELECT * FROM events WHERE id = ?", e1.id)[0];
    expect(row.source_message_ids_json).toBe(JSON.stringify(["msg-1", "msg-2"]));
    expect(row.entities_json).toBe(JSON.stringify(["ent_x"]));
    expect(dbAll(store, "SELECT count(*) AS c FROM events")[0].c).toBe(1);
  });

  // -- Facts: supersession invariants -------------------------------------

  it("first fact for (entity, attribute) is the HEAD (valid_to NULL, superseded_by NULL)", () => {
    const e = store.resolveOrCreateEntity({ type: "person", name: "Lorenzo", now: NOW });
    const f = store.upsertFact({ entityId: e.id, attribute: "role", value: "founder", now: NOW });
    expect(f.valid_to).toBeNull();
    expect(f.superseded_by).toBeNull();
    const heads = store.queryHeadFacts(e.id);
    expect(heads).toHaveLength(1);
    expect(heads[0].value).toBe("founder");
  });

  it("HEAD uniqueness: at most ONE head per (entity, attribute) after a supersede", () => {
    const e = store.resolveOrCreateEntity({ type: "person", name: "Lorenzo", now: NOW });
    store.upsertFact({ entityId: e.id, attribute: "city", value: "Rome", validFrom: "2024-01-01T00:00:00.000Z", now: NOW });
    store.upsertFact({ entityId: e.id, attribute: "city", value: "Milan", validFrom: "2024-05-01T00:00:00.000Z", now: NOW });

    const heads = dbAll(
      store,
      "SELECT * FROM facts WHERE entity_id = ? AND attribute = ? AND superseded_by IS NULL AND valid_to IS NULL",
      e.id,
      "city",
    );
    expect(heads).toHaveLength(1);
    expect(heads[0].value).toBe("Milan");
  });

  it("supersede KEEPS the old row (valid_to + superseded_by set) - never deletes", () => {
    const e = store.resolveOrCreateEntity({ type: "person", name: "L", now: NOW });
    const first = store.upsertFact({
      entityId: e.id, attribute: "city", value: "Rome",
      validFrom: "2024-01-01T00:00:00.000Z", now: "2024-01-01T00:00:00.000Z",
    });
    const second = store.upsertFact({
      entityId: e.id, attribute: "city", value: "Milan",
      validFrom: "2024-05-01T00:00:00.000Z", now: "2024-05-01T00:00:00.000Z",
    });

    // Two rows total - nothing was deleted.
    expect(dbAll(store, "SELECT count(*) AS c FROM facts WHERE entity_id = ? AND attribute = 'city'", e.id)[0].c).toBe(2);

    const oldRow = dbAll(store, "SELECT * FROM facts WHERE id = ?", first.id)[0];
    expect(oldRow.valid_to).toBe("2024-05-01T00:00:00.000Z"); // closed when new head began
    expect(oldRow.superseded_by).toBe(second.id);
    expect(oldRow.superseded_at).toBe("2024-05-01T00:00:00.000Z");
  });

  it("same-value corroboration: support++ and max(confidence), NO new version", () => {
    const e = store.resolveOrCreateEntity({ type: "person", name: "L", now: NOW });
    const a = store.upsertFact({ entityId: e.id, attribute: "lang", value: "Italian", confidence: 0.6, now: NOW });
    const b = store.upsertFact({ entityId: e.id, attribute: "lang", value: " Italian ", confidence: 0.9, now: NOW });

    // Same head id (no new version) and only ONE row exists.
    expect(b.id).toBe(a.id);
    expect(dbAll(store, "SELECT count(*) AS c FROM facts WHERE entity_id = ? AND attribute = 'lang'", e.id)[0].c).toBe(1);
    expect(b.support).toBe(2);
    expect(b.confidence).toBeCloseTo(0.9, 6);
    expect(b.valid_to).toBeNull();
  });

  it("same-value corroboration keeps the EARLIEST valid_from", () => {
    const e = store.resolveOrCreateEntity({ type: "person", name: "L", now: NOW });
    store.upsertFact({ entityId: e.id, attribute: "lang", value: "Italian", validFrom: "2024-03-01T00:00:00.000Z", now: NOW });
    const b = store.upsertFact({ entityId: e.id, attribute: "lang", value: "Italian", validFrom: "2024-01-01T00:00:00.000Z", now: NOW });
    expect(b.valid_from).toBe("2024-01-01T00:00:00.000Z");
  });

  it("older-than-head different value -> CLOSED historical row, head untouched", () => {
    const e = store.resolveOrCreateEntity({ type: "person", name: "L", now: NOW });
    // Head established at 2024-05.
    const head = store.upsertFact({
      entityId: e.id, attribute: "city", value: "Milan",
      validFrom: "2024-05-01T00:00:00.000Z", now: "2024-05-01T00:00:00.000Z",
    });
    // Now we learn an OLDER different value (true before the head).
    const historical = store.upsertFact({
      entityId: e.id, attribute: "city", value: "Rome",
      validFrom: "2024-01-01T00:00:00.000Z", now: "2024-06-01T00:00:00.000Z",
    });

    // Head is unchanged: still Milan, still open.
    const headNow = dbAll(store, "SELECT * FROM facts WHERE id = ?", head.id)[0];
    expect(headNow.valid_to).toBeNull();
    expect(headNow.superseded_by).toBeNull();
    expect(headNow.value).toBe("Milan");

    // The historical row is CLOSED: valid_to = head.valid_from, superseded_by = head.id.
    const histRow = dbAll(store, "SELECT * FROM facts WHERE id = ?", historical.id)[0];
    expect(histRow.value).toBe("Rome");
    expect(histRow.valid_to).toBe("2024-05-01T00:00:00.000Z");
    expect(histRow.superseded_by).toBe(head.id);

    // Still exactly one head.
    expect(store.queryHeadFacts(e.id).filter((f) => f.attribute === "city")).toHaveLength(1);
  });

  it("idempotent re-apply of the SAME fact set -> identical head state (only support grows)", () => {
    const apply = () => {
      const e = store.resolveOrCreateEntity({ type: "person", name: "L", now: NOW });
      store.upsertFact({ entityId: e.id, attribute: "role", value: "founder", validFrom: NOW, now: NOW });
      store.upsertFact({ entityId: e.id, attribute: "city", value: "Milan", validFrom: NOW, now: NOW });
      return e.id;
    };
    const id1 = apply();
    const headsAfter1 = store.queryHeadFacts(id1).map((f) => `${f.attribute}=${f.value}`).sort();

    const id2 = apply(); // re-apply identical set
    expect(id2).toBe(id1); // same entity
    const headsAfter2 = store.queryHeadFacts(id2).map((f) => `${f.attribute}=${f.value}`).sort();

    // Head VALUES are identical; no extra versions created.
    expect(headsAfter2).toEqual(headsAfter1);
    expect(dbAll(store, "SELECT count(*) AS c FROM facts WHERE entity_id = ?", id1)[0].c).toBe(2);
    // Support incremented (corroboration), not duplicated.
    for (const f of store.queryHeadFacts(id1)) {
      expect(f.support).toBe(2);
    }
  });

  // -- Relations ----------------------------------------------------------

  it("upsertRelation idempotent by unique edge (support++ on conflict)", () => {
    const a = store.resolveOrCreateEntity({ type: "project", name: "Sofia AI", now: NOW });
    const b = store.resolveOrCreateEntity({ type: "library", name: "sqlite-vec", now: NOW });
    const r1 = store.upsertRelation({ srcEntityId: a.id, type: "uses", dstEntityId: b.id, now: NOW });
    const r2 = store.upsertRelation({ srcEntityId: a.id, type: "uses", dstEntityId: b.id, now: NOW });

    expect(r2.id).toBe(r1.id);
    expect(r2.id).toBe(relationId("default", a.id, "uses", b.id));
    expect(r2.support).toBe(2);
    expect(dbAll(store, "SELECT count(*) AS c FROM relations")[0].c).toBe(1);
  });

  // -- Recall surfaces ----------------------------------------------------

  it("kb_vec / kb_fts write + search round-trip", () => {
    store.upsertKbVector("ent_a", "entity", [normalize([1, 0, 0, 0])], NOW);
    store.upsertKbVector("fact_b", "fact", [normalize([0, 1, 0, 0])], NOW);
    store.upsertKbFts({ ownerId: "ent_a", ownerKind: "entity", content: "TypeScript language preference", entityType: "concept" });

    const vec = store.searchKbVector(normalize([1, 0, 0, 0]), 5);
    expect(vec[0].owner_id).toBe("ent_a");
    expect(vec[0].owner_kind).toBe("entity");
    expect(vec[0].score).toBeGreaterThan(0.9);

    // ownerKindFilter restricts results.
    const onlyFacts = store.searchKbVector(normalize([0, 1, 0, 0]), 5, "fact");
    expect(onlyFacts.every((r) => r.owner_kind === "fact")).toBe(true);
    expect(onlyFacts[0].owner_id).toBe("fact_b");

    const fts = store.searchKbFts('"TypeScript"', 5);
    expect(fts.some((r) => r.owner_id === "ent_a")).toBe(true);
  });

  it("upsertKbVector re-write replaces chunks (idempotent, no orphans)", () => {
    store.upsertKbVector("ent_a", "entity", [normalize([1, 0, 0, 0]), normalize([0.9, 0.1, 0, 0])], NOW);
    store.upsertKbVector("ent_a", "entity", [normalize([0.5, 0.5, 0, 0])], NOW);
    expect(dbAll(store, "SELECT count(*) AS c FROM kb_vec WHERE owner_id = 'ent_a'")[0].c).toBe(1);
  });

  it("input validation: rejects empty required fields", () => {
    expect(() => store.resolveOrCreateEntity({ type: "", name: "x", now: NOW })).toThrow();
    const e = store.resolveOrCreateEntity({ type: "person", name: "L", now: NOW });
    expect(() => store.upsertFact({ entityId: e.id, attribute: "role", value: "", now: NOW })).toThrow();
  });
});

describe("KB schema init resilience (temp DB)", () => {
  it("empty-DB init works and KB is ready", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kb-empty-"));
    const dbPath = path.join(dir, "vectors.db");
    try {
      const store = new VectorStore(dbPath, DIMS);
      const res = store.init({ provider: "openai", model: "text-embedding-3-small" });
      expect(store.isDegraded()).toBe(false);
      expect(res.needsReindex).toBe(false);
      expect(store.isKbReady()).toBe(true);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a DB pre-seeded with ONLY legacy l0_*/l1_* tables opens and GAINS the new KB tables", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kb-legacy-"));
    const dbPath = path.join(dir, "vectors.db");
    try {
      // Build a legacy DB by hand: ONLY l1_records + l1_vec + l0_conversations,
      // NO entities/facts/events/relations. The chunked l1_vec schema is used so
      // the legacy-migration path does NOT fire (isolating the KB-add behavior).
      const req = createRequire(import.meta.url);
      const { DatabaseSync } = req("node:sqlite") as typeof import("node:sqlite");
      const sqliteVec = req("sqlite-vec") as { load: (db: unknown) => void };
      const seed = new DatabaseSync(dbPath, { allowExtension: true });
      sqliteVec.load(seed);
      seed.exec(`CREATE TABLE l1_records (
        record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50, scene_name TEXT DEFAULT '', session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT '', timestamp_str TEXT DEFAULT '', timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '', created_time TEXT DEFAULT '', updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}')`);
      seed.exec(`CREATE VIRTUAL TABLE l1_vec USING vec0(
        chunk_id TEXT PRIMARY KEY, record_id TEXT partition key,
        embedding float[4] distance_metric=cosine, updated_time TEXT DEFAULT '')`);
      seed.exec(`CREATE TABLE l0_conversations (
        record_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, session_id TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT '', message_text TEXT NOT NULL, recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0)`);
      seed.prepare("INSERT INTO l1_records(record_id, content) VALUES (?, ?)").run("old-1", "legacy text");
      // Sanity: KB tables absent before opening with VectorStore.
      const before = seed
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('entities','facts','events','relations','kb_vec','kb_fts')")
        .all() as Array<{ name: string }>;
      expect(before).toHaveLength(0);
      seed.close();

      // Open via VectorStore - must NOT degrade, and must GAIN the KB tables.
      const store = new VectorStore(dbPath, DIMS);
      store.init({ provider: "openai", model: "text-embedding-3-small" });
      expect(store.isDegraded()).toBe(false);
      expect(store.isKbReady()).toBe(true);

      const names = dbAll(
        store,
        "SELECT name FROM sqlite_master WHERE name IN ('entities','facts','events','relations','kb_vec','kb_fts')",
      ).map((r) => r.name as string);
      for (const t of ["entities", "facts", "events", "relations", "kb_vec", "kb_fts"]) {
        expect(names).toContain(t);
      }
      // Legacy data preserved.
      expect(dbAll(store, "SELECT count(*) AS c FROM l1_records")[0].c).toBe(1);

      // And the KB methods actually work on the upgraded legacy DB.
      const e = store.resolveOrCreateEntity({ type: "concept", name: "TypeScript", now: NOW });
      expect(store.queryEntityById(e.id)?.id).toBe(e.id);

      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
