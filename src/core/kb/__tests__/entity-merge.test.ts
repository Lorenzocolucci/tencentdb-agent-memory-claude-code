import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mergeEntities,
  pickCanonical,
  ensureMergedIntoColumn,
  resolveEntityHeadCollisions,
} from "../entity-merge.js";

const NOW = "2026-07-21T00:00:00.000Z";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.prepare(
    "CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, namespace TEXT, name TEXT, " +
      "canonical_key TEXT, aliases_json TEXT DEFAULT '[]', importance INTEGER DEFAULT 50, " +
      "created_time TEXT, updated_time TEXT)",
  ).run();
  db.prepare(
    "CREATE TABLE facts (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, attribute TEXT NOT NULL, value TEXT NOT NULL, " +
      "confidence REAL DEFAULT 0.7, support INTEGER DEFAULT 1, valid_from TEXT NOT NULL, valid_to TEXT, " +
      "learned_at TEXT NOT NULL, superseded_by TEXT, superseded_at TEXT)",
  ).run();
  return db;
}
function ent(db: DatabaseSync, e: { id: string; name: string; type?: string; imp?: number; created?: string; aliases?: string[] }) {
  db.prepare(
    "INSERT INTO entities (id, type, namespace, name, canonical_key, aliases_json, importance, created_time, updated_time) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(e.id, e.type ?? "topic", "default", e.name, e.name.toLowerCase(), JSON.stringify(e.aliases ?? []), e.imp ?? 50, e.created ?? NOW, NOW);
}
function fact(db: DatabaseSync, f: { id: string; entity: string; attr: string; value: string; from: string; support?: number }) {
  db.prepare(
    "INSERT INTO facts (id, entity_id, attribute, value, confidence, support, valid_from, valid_to, learned_at, superseded_by, superseded_at) VALUES (?,?,?,?,?,?,?,NULL,?,NULL,NULL)",
  ).run(f.id, f.entity, f.attr, f.value, 0.7, f.support ?? 1, f.from, f.from);
}
const heads = (db: DatabaseSync, e: string) =>
  db.prepare("SELECT * FROM facts WHERE entity_id = ? AND superseded_by IS NULL AND valid_to IS NULL").all(e) as Array<Record<string, unknown>>;

describe("pickCanonical", () => {
  it("prefers importance, then factCount, then earliest created", () => {
    expect(pickCanonical([
      { id: "a", importance: 50, factCount: 2, createdTime: "2026-01-01" },
      { id: "b", importance: 80, factCount: 1, createdTime: "2026-02-01" },
    ])).toBe("b"); // higher importance
    expect(pickCanonical([
      { id: "a", importance: 50, factCount: 5, createdTime: "2026-03-01" },
      { id: "b", importance: 50, factCount: 2, createdTime: "2026-01-01" },
    ])).toBe("a"); // same importance → more facts
  });
});

describe("ensureMergedIntoColumn", () => {
  it("is idempotent", () => {
    const db = makeDb();
    ensureMergedIntoColumn(db);
    ensureMergedIntoColumn(db);
    const cols = (db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols.filter((c) => c === "merged_into")).toHaveLength(1);
  });
});

describe("mergeEntities", () => {
  let db: DatabaseSync;
  beforeEach(() => (db = makeDb()));

  it("re-keys facts, folds aliases, marks merged_into, resolves diff-value collision", () => {
    ent(db, { id: "C", name: "OpenAI", imp: 80 });
    ent(db, { id: "S", name: "costi OpenAI", imp: 50, aliases: ["openai costs"] });
    fact(db, { id: "fc", entity: "C", attr: "status", value: "active", from: "2026-05-01T00:00:00.000Z" });
    fact(db, { id: "fs_old", entity: "S", attr: "status", value: "deprecated", from: "2026-06-01T00:00:00.000Z" });

    const res = mergeEntities(db, { canonicalId: "C", satelliteIds: ["S"] }, NOW);
    expect(res.satellitesMerged).toBe(1);
    expect(res.factsRekeyed).toBe(1);
    expect(res.headCollisionsResolved).toBe(1);

    // S's fact re-keyed to C; ONE HEAD for status, newest ("deprecated", 2026-06) wins.
    const h = heads(db, "C").filter((f) => f.attribute === "status");
    expect(h).toHaveLength(1);
    expect(h[0].value).toBe("deprecated");
    // satellite marked, name folded into canonical aliases, nothing deleted.
    const s = db.prepare("SELECT merged_into FROM entities WHERE id='S'").get() as { merged_into: string };
    expect(s.merged_into).toBe("C");
    const aliases = JSON.parse((db.prepare("SELECT aliases_json FROM entities WHERE id='C'").get() as { aliases_json: string }).aliases_json) as string[];
    expect(aliases).toContain("costi OpenAI");
    expect(aliases).toContain("openai costs");
    expect(aliases).not.toContain("OpenAI"); // canonical's own name not duplicated
    expect((db.prepare("SELECT count(*) c FROM facts").get() as { c: number }).c).toBe(2); // no delete
  });

  it("corroborates a same-value collision (support folded) instead of superseding", () => {
    ent(db, { id: "C", name: "GPT" });
    ent(db, { id: "S", name: "gpt model" });
    fact(db, { id: "fc", entity: "C", attr: "vendor", value: "OpenAI", from: "2026-05-01T00:00:00.000Z", support: 1 });
    fact(db, { id: "fs", entity: "S", attr: "vendor", value: "OpenAI", from: "2026-06-01T00:00:00.000Z", support: 1 });
    const res = mergeEntities(db, { canonicalId: "C", satelliteIds: ["S"] }, NOW);
    expect(res.headCollisionsResolved).toBe(1);
    const h = heads(db, "C").filter((f) => f.attribute === "vendor");
    expect(h).toHaveLength(1);
    expect(h[0].support).toBe(2); // folded
  });

  it("rejects a type mismatch and rolls back (no partial write)", () => {
    ent(db, { id: "C", name: "OpenAI", type: "topic" });
    ent(db, { id: "S", name: "OpenAI", type: "person" });
    fact(db, { id: "fs", entity: "S", attr: "role", value: "x", from: NOW });
    expect(() => mergeEntities(db, { canonicalId: "C", satelliteIds: ["S"] }, NOW)).toThrow(/type mismatch/);
    // rolled back: S's fact NOT re-keyed, S not marked.
    expect((db.prepare("SELECT entity_id FROM facts WHERE id='fs'").get() as { entity_id: string }).entity_id).toBe("S");
  });

  it("resolveEntityHeadCollisions is a no-op when attributes don't collide", () => {
    ent(db, { id: "C", name: "X" });
    fact(db, { id: "f1", entity: "C", attr: "a", value: "1", from: NOW });
    fact(db, { id: "f2", entity: "C", attr: "b", value: "2", from: NOW });
    expect(resolveEntityHeadCollisions(db, "C", NOW)).toBe(0);
  });
});
