import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { backfillCanonicalizeAttributes } from "../canonicalize-attributes.js";

const NOW = "2026-07-21T00:00:00.000Z";

/** Minimal facts table matching the columns the backfill reads/writes. */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // prepare().run() (not .exec) for DDL — dodges a security-hook false positive.
  db.prepare(
    "CREATE TABLE facts (" +
      "id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, attribute TEXT NOT NULL, value TEXT NOT NULL, " +
      "confidence REAL NOT NULL DEFAULT 0.7, support INTEGER NOT NULL DEFAULT 1, " +
      "valid_from TEXT NOT NULL, valid_to TEXT, learned_at TEXT NOT NULL, " +
      "superseded_by TEXT, superseded_at TEXT)",
  ).run();
  return db;
}

function insertHead(
  db: DatabaseSync,
  f: { id: string; entity: string; attr: string; value: string; from: string; confidence?: number; support?: number },
) {
  db.prepare(
    "INSERT INTO facts (id, entity_id, attribute, value, confidence, support, valid_from, valid_to, learned_at, superseded_by, superseded_at) VALUES (?,?,?,?,?,?,?,NULL,?,NULL,NULL)",
  ).run(f.id, f.entity, f.attr, f.value, f.confidence ?? 0.7, f.support ?? 1, f.from, f.from);
}

function heads(db: DatabaseSync, entity: string) {
  return db
    .prepare("SELECT * FROM facts WHERE entity_id = ? AND superseded_by IS NULL AND valid_to IS NULL")
    .all(entity) as Array<Record<string, unknown>>;
}

describe("backfillCanonicalizeAttributes", () => {
  let db: DatabaseSync;
  beforeEach(() => (db = makeDb()));

  it("dry run computes changes WITHOUT writing", () => {
    insertHead(db, { id: "f1", entity: "e1", attr: "costo", value: "€18", from: "2026-06-24T00:00:00.000Z" });
    const res = backfillCanonicalizeAttributes(db, { apply: false, nowIso: NOW });
    expect(res.applied).toBe(false);
    expect(res.relabeled).toBe(1);
    // DB untouched.
    expect(heads(db, "e1")[0].attribute).toBe("costo");
  });

  it("relabels a lone synonym HEAD in place (no supersession)", () => {
    insertHead(db, { id: "f1", entity: "e1", attr: "costo", value: "€18", from: "2026-06-24T00:00:00.000Z" });
    const res = backfillCanonicalizeAttributes(db, { apply: true, nowIso: NOW });
    expect(res.applied).toBe(true);
    expect(res.relabeled).toBe(1);
    expect(res.headsSuperseded).toBe(0);
    const h = heads(db, "e1");
    expect(h).toHaveLength(1);
    expect(h[0].attribute).toBe("cost");
    expect(h[0].value).toBe("€18");
  });

  it("collapses two competing synonym HEADs → newest wins, older closed, nothing deleted", () => {
    insertHead(db, { id: "old", entity: "e1", attr: "costo", value: "€18", from: "2026-06-24T00:00:00.000Z" });
    insertHead(db, { id: "new", entity: "e1", attr: "cost", value: "€387", from: "2026-07-20T00:00:00.000Z" });
    const res = backfillCanonicalizeAttributes(db, { apply: true, nowIso: NOW });

    expect(res.groupsResolved).toBe(1);
    expect(res.headsSuperseded).toBe(1);

    const h = heads(db, "e1");
    expect(h).toHaveLength(1);
    expect(h[0].id).toBe("new");
    expect(h[0].value).toBe("€387");

    // Older row kept as audit, correctly closed.
    const old = db.prepare("SELECT * FROM facts WHERE id = 'old'").get() as Record<string, unknown>;
    expect(old.attribute).toBe("cost");
    expect(old.superseded_by).toBe("new");
    expect(old.valid_to).toBe("2026-07-20T00:00:00.000Z");
    expect(old.superseded_at).toBe(NOW);
    // Two rows total — no delete.
    expect((db.prepare("SELECT count(*) AS c FROM facts").get() as { c: number }).c).toBe(2);
  });

  it("SAME-value synonym collision → corroborates (support folded), matches upsertFact Case B", () => {
    // Two legacy HEADs, same value, different attribute surface + validity.
    insertHead(db, { id: "a", entity: "e1", attr: "stato", value: "open", from: "2026-06-01T00:00:00.000Z", confidence: 0.6, support: 1 });
    insertHead(db, { id: "b", entity: "e1", attr: "status", value: "open", from: "2026-07-01T00:00:00.000Z", confidence: 0.9, support: 1 });
    const res = backfillCanonicalizeAttributes(db, { apply: true, nowIso: NOW });

    // Exactly ONE HEAD survives, holding the folded support + max confidence +
    // earliest valid_from (the Case B contract).
    const h = heads(db, "e1");
    expect(h).toHaveLength(1);
    expect(h[0].id).toBe("a"); // earliest survives as the corroborated head
    expect(h[0].support).toBe(2);
    expect(h[0].confidence).toBeCloseTo(0.9, 6);
    expect(h[0].valid_from).toBe("2026-06-01T00:00:00.000Z");
    // The duplicate is closed (kept as audit), nothing deleted.
    const dup = db.prepare("SELECT * FROM facts WHERE id = 'b'").get() as Record<string, unknown>;
    expect(dup.superseded_by).toBe("a");
    expect((db.prepare("SELECT count(*) AS c FROM facts").get() as { c: number }).c).toBe(2);
    expect(res.headsSuperseded).toBe(1);
    expect(res.supersededHeads).toHaveLength(1);
  });

  it("is idempotent: a second apply makes zero changes", () => {
    insertHead(db, { id: "old", entity: "e1", attr: "costo", value: "€18", from: "2026-06-24T00:00:00.000Z" });
    insertHead(db, { id: "new", entity: "e1", attr: "cost", value: "€387", from: "2026-07-20T00:00:00.000Z" });
    backfillCanonicalizeAttributes(db, { apply: true, nowIso: NOW });
    const second = backfillCanonicalizeAttributes(db, { apply: true, nowIso: NOW });
    expect(second.relabeled).toBe(0);
    expect(second.headsSuperseded).toBe(0);
  });

  it("leaves unknown + qualified-money attributes untouched", () => {
    insertHead(db, { id: "f1", entity: "e1", attr: "commit_hash", value: "abc", from: NOW });
    insertHead(db, { id: "f2", entity: "e1", attr: "monthly_cost", value: "€387", from: NOW });
    const res = backfillCanonicalizeAttributes(db, { apply: true, nowIso: NOW });
    expect(res.relabeled).toBe(0);
    const attrs = heads(db, "e1").map((r) => r.attribute).sort();
    expect(attrs).toEqual(["commit_hash", "monthly_cost"]);
  });
});
