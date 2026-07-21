import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mergeEntities,
  pickCanonical,
  ensureMergedIntoColumn,
  resolveEntityHeadCollisions,
  rekeyRelationsOnMerge,
  groupByUltimateCanonical,
} from "../entity-merge.js";
import { relationId } from "../kb-queries.js";

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

  it("returns zero relation counts when there is no relations table (backward compatible)", () => {
    ent(db, { id: "C", name: "OpenAI" });
    ent(db, { id: "S", name: "openai" });
    fact(db, { id: "fs", entity: "S", attr: "a", value: "1", from: NOW });
    const res = mergeEntities(db, { canonicalId: "C", satelliteIds: ["S"] }, NOW);
    expect(res.relationsRekeyed).toBe(0);
    expect(res.relationsFolded).toBe(0);
    expect(res.relationsSelfLoopsDropped).toBe(0);
  });
});

// ── Cura #2c: relation re-keying ─────────────────────────────────────────────

function addRelationsTable(db: DatabaseSync): void {
  db.prepare(
    "CREATE TABLE relations (id TEXT PRIMARY KEY, src_entity_id TEXT NOT NULL, type TEXT NOT NULL, " +
      "dst_entity_id TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT 'default', valid_from TEXT, valid_to TEXT, " +
      "support INTEGER DEFAULT 1, source_event_id TEXT, created_time TEXT, " +
      "UNIQUE(namespace, src_entity_id, type, dst_entity_id))",
  ).run();
}
function rel(db: DatabaseSync, r: { src: string; type: string; dst: string; support?: number; ns?: string }): void {
  const ns = r.ns ?? "default";
  db.prepare(
    "INSERT INTO relations (id, src_entity_id, type, dst_entity_id, namespace, support, created_time) VALUES (?,?,?,?,?,?,?)",
  ).run(relationId(ns, r.src, r.type, r.dst), r.src, r.type, r.dst, ns, r.support ?? 1, NOW);
}
const rels = (db: DatabaseSync) =>
  db.prepare("SELECT src_entity_id s, type t, dst_entity_id d, support FROM relations ORDER BY s, t, d").all() as Array<{
    s: string; t: string; d: string; support: number;
  }>;

describe("rekeyRelationsOnMerge (Cura #2c)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = makeDb();
    addRelationsTable(db);
    ent(db, { id: "C", name: "OpenAI", imp: 80 });
    ent(db, { id: "S", name: "openai-dup" });
    ent(db, { id: "X", name: "Other" });
  });

  it("re-keys a satellite's UNIQUE edge onto the canonical (src side)", () => {
    rel(db, { src: "S", type: "uses", dst: "X" });
    const res = mergeEntities(db, { canonicalId: "C", satelliteIds: ["S"] }, NOW);
    expect(res.relationsRekeyed).toBe(1);
    expect(res.relationsFolded).toBe(0);
    expect(rels(db)).toEqual([{ s: "C", t: "uses", d: "X", support: 1 }]);
    // id was recomputed deterministically so upsertRelation resolves to this row.
    const id = db.prepare("SELECT id FROM relations").get() as { id: string };
    expect(id.id).toBe(relationId("default", "C", "uses", "X"));
  });

  it("re-keys the dst side of an edge pointing AT a satellite", () => {
    rel(db, { src: "X", type: "uses", dst: "S" });
    const res = mergeEntities(db, { canonicalId: "C", satelliteIds: ["S"] }, NOW);
    expect(res.relationsRekeyed).toBe(1);
    expect(rels(db)).toEqual([{ s: "X", t: "uses", d: "C", support: 1 }]);
  });

  it("folds support when the satellite edge duplicates an existing canonical edge", () => {
    rel(db, { src: "C", type: "uses", dst: "X", support: 2 });
    rel(db, { src: "S", type: "uses", dst: "X", support: 3 });
    const res = mergeEntities(db, { canonicalId: "C", satelliteIds: ["S"] }, NOW);
    expect(res.relationsFolded).toBe(1);
    expect(res.relationsRekeyed).toBe(0);
    // one surviving edge, support folded 2+3.
    expect(rels(db)).toEqual([{ s: "C", t: "uses", d: "X", support: 5 }]);
  });

  it("drops a self-loop (satellite → its own canonical)", () => {
    rel(db, { src: "S", type: "related", dst: "C" });
    const res = mergeEntities(db, { canonicalId: "C", satelliteIds: ["S"] }, NOW);
    expect(res.relationsSelfLoopsDropped).toBe(1);
    expect(res.relationsRekeyed).toBe(0);
    expect(rels(db)).toEqual([]); // meaningless self-loop removed
  });

  it("drops a self-loop when BOTH endpoints merge into the canonical", () => {
    ent(db, { id: "S2", name: "openai-dup2" });
    rel(db, { src: "S", type: "related", dst: "S2" });
    const res = mergeEntities(db, { canonicalId: "C", satelliteIds: ["S", "S2"] }, NOW);
    expect(res.relationsSelfLoopsDropped).toBe(1);
    expect(rels(db)).toEqual([]);
  });

  it("two satellite edges collapsing onto the same target: one re-keyed, one folded", () => {
    ent(db, { id: "S2", name: "openai-dup2" });
    rel(db, { src: "S", type: "uses", dst: "X", support: 1 });
    rel(db, { src: "S2", type: "uses", dst: "X", support: 4 });
    const res = mergeEntities(db, { canonicalId: "C", satelliteIds: ["S", "S2"] }, NOW);
    expect(res.relationsRekeyed).toBe(1);
    expect(res.relationsFolded).toBe(1);
    expect(rels(db)).toEqual([{ s: "C", t: "uses", d: "X", support: 5 }]);
  });

  it("leaves edges that don't touch any satellite untouched", () => {
    rel(db, { src: "C", type: "uses", dst: "X" }); // canonical→X, no satellite involved
    const res = mergeEntities(db, { canonicalId: "C", satelliteIds: ["S"] }, NOW);
    expect(res.relationsRekeyed).toBe(0);
    expect(res.relationsFolded).toBe(0);
    expect(res.relationsSelfLoopsDropped).toBe(0);
    expect(rels(db)).toEqual([{ s: "C", t: "uses", d: "X", support: 1 }]);
  });

  it("direct rekeyRelationsOnMerge is a no-op with an empty satellite list", () => {
    rel(db, { src: "S", type: "uses", dst: "X" });
    const r = rekeyRelationsOnMerge(db, "C", []);
    expect(r).toEqual({ relationsRekeyed: 0, relationsFolded: 0, relationsSelfLoopsDropped: 0 });
    expect(rels(db)).toEqual([{ s: "S", t: "uses", d: "X", support: 1 }]); // untouched
  });

  it("cross-canonical edge converges over two sequential merges (backfill two-pass)", () => {
    // S1 → C, S2 → C2; an edge between the two satellites must land on (C → C2).
    ent(db, { id: "C2", name: "Anthropic" });
    ent(db, { id: "S2", name: "anthropic-dup" });
    rel(db, { src: "S", type: "uses", dst: "S2" });
    // Two independent merges (as the per-canonical backfill would run them).
    ensureMergedIntoColumn(db);
    db.prepare("UPDATE entities SET merged_into='C' WHERE id='S'").run();
    db.prepare("UPDATE entities SET merged_into='C2' WHERE id='S2'").run();
    const r1 = rekeyRelationsOnMerge(db, "C", ["S"]);
    const r2 = rekeyRelationsOnMerge(db, "C2", ["S2"]);
    expect(r1.relationsRekeyed).toBe(1); // S→S2 becomes C→S2
    expect(r2.relationsRekeyed).toBe(1); // C→S2 becomes C→C2
    expect(rels(db)).toEqual([{ s: "C", t: "uses", d: "C2", support: 1 }]);
  });
});

describe("groupByUltimateCanonical (Cura #2c backfill grouping)", () => {
  it("groups a simple satellite under its canonical", () => {
    const g = groupByUltimateCanonical([{ id: "S", merged_into: "C" }]);
    expect(g.byCanon.get("C")).toEqual(["S"]);
    expect(g.cyclic).toEqual([]);
  });

  it("follows a multi-hop chain S1→M→C to the ULTIMATE canonical", () => {
    const g = groupByUltimateCanonical([
      { id: "S1", merged_into: "M" },
      { id: "M", merged_into: "C" },
    ]);
    expect(g.byCanon.get("C")).toEqual(["M", "S1"]); // sorted by id, both under C
    expect(g.byCanon.size).toBe(1);
    expect(g.cyclic).toEqual([]);
  });

  it("keeps distinct canonicals separate (cross-canonical)", () => {
    const g = groupByUltimateCanonical([
      { id: "S1", merged_into: "C1" },
      { id: "S2", merged_into: "C2" },
    ]);
    expect(g.byCanon.get("C1")).toEqual(["S1"]);
    expect(g.byCanon.get("C2")).toEqual(["S2"]);
    expect(g.cyclic).toEqual([]);
  });

  it("detects a cycle and skips it (no infinite loop)", () => {
    const g = groupByUltimateCanonical([
      { id: "S1", merged_into: "S2" },
      { id: "S2", merged_into: "S1" },
    ]);
    expect(g.byCanon.size).toBe(0);
    expect(new Set(g.cyclic)).toEqual(new Set(["S1", "S2"]));
  });

  it("is deterministic — satellites sorted by id regardless of input order", () => {
    const g = groupByUltimateCanonical([
      { id: "Sc", merged_into: "C" },
      { id: "Sa", merged_into: "C" },
      { id: "Sb", merged_into: "C" },
    ]);
    expect(g.byCanon.get("C")).toEqual(["Sa", "Sb", "Sc"]);
  });
});
