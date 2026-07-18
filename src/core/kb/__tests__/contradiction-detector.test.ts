/**
 * Contradiction detector (Phase A / L4 v1, part 3) — deterministic tests.
 *
 * Throwaway in-memory DB, minimal `facts` shape (mirrors
 * consolidation-runner.test.ts's convention — id/entity_id/attribute/value/
 * namespace/superseded_by/valid_to is all the detector reads).
 *
 * NOTE: uses db.prepare(sql).run() instead of db.exec(sql) for BEGIN/COMMIT/
 * DDL — same convention as sqlite.ts's dropVectorTables (avoids a lint false
 * positive that flags any `.exec(` call as child_process.exec()).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import {
  detectContradictions,
  MAX_ACTIVE_FACTS_SCANNED,
} from "../contradiction-detector.js";
import { getLifecycle } from "../lifecycle-writer.js";
import { _resetUlidStateForTest } from "../kb-queries.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSync;
};
const NOW = "2026-07-18T01:00:00.000Z";

function seedFactsTable(db: DatabaseSync): void {
  db.prepare(
    `CREATE TABLE facts (
       id TEXT PRIMARY KEY,
       entity_id TEXT NOT NULL,
       attribute TEXT NOT NULL,
       value TEXT NOT NULL,
       namespace TEXT NOT NULL DEFAULT 'default',
       superseded_by TEXT,
       valid_to TEXT
     )`,
  ).run();
}

function insertFact(
  db: DatabaseSync,
  p: {
    id: string;
    entityId: string;
    attribute: string;
    value: string;
    namespace?: string;
    superseded?: boolean;
  },
): void {
  db.prepare(
    "INSERT INTO facts (id, entity_id, attribute, value, namespace, superseded_by, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    p.id,
    p.entityId,
    p.attribute,
    p.value,
    p.namespace ?? "default",
    p.superseded ? "fact_superseder" : null,
    p.superseded ? NOW : null,
  );
}

describe("detectContradictions", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    initFoundationsSchema(db);
    seedFactsTable(db);
  });

  it("flags two active facts about the same entity+attribute with different values", () => {
    insertFact(db, { id: "fact_a", entityId: "ent_1", attribute: "llm_model", value: "GPT-5.4" });
    insertFact(db, { id: "fact_b", entityId: "ent_1", attribute: "llm_model", value: "GPT-4.1" });

    const stats = detectContradictions(db, { now: NOW });

    expect(stats.groupsConflicting).toBe(1);
    expect(stats.factsFlagged).toBe(2);
    expect(stats.factsCleared).toBe(0);

    const flagA = getLifecycle(db, "fact_a", "fact");
    expect(flagA?.contradiction_json).toBeTruthy();
    const parsedA = JSON.parse(flagA!.contradiction_json!);
    expect(parsedA.conflict_with).toEqual([{ fact_id: "fact_b", value: "GPT-4.1" }]);

    const flagB = getLifecycle(db, "fact_b", "fact");
    const parsedB = JSON.parse(flagB!.contradiction_json!);
    expect(parsedB.conflict_with).toEqual([{ fact_id: "fact_a", value: "GPT-5.4" }]);
  });

  it("does NOT flag facts with the same (normalized) value — corroboration, not contradiction", () => {
    insertFact(db, { id: "fact_a", entityId: "ent_1", attribute: "status", value: "active " });
    insertFact(db, { id: "fact_b", entityId: "ent_1", attribute: "status", value: " active" });

    const stats = detectContradictions(db, { now: NOW });

    expect(stats.groupsConflicting).toBe(0);
    expect(stats.factsFlagged).toBe(0);
    expect(getLifecycle(db, "fact_a", "fact")).toBeNull(); // no lifecycle row created at all
  });

  it("ignores a superseded fact — only ACTIVE (HEAD) facts are compared", () => {
    insertFact(db, { id: "fact_old", entityId: "ent_1", attribute: "status", value: "draft", superseded: true });
    insertFact(db, { id: "fact_new", entityId: "ent_1", attribute: "status", value: "final" });

    const stats = detectContradictions(db, { now: NOW });

    expect(stats.groupsConflicting).toBe(0);
    expect(stats.factsFlagged).toBe(0);
  });

  it("never touches the facts table (NO-DELETE invariant)", () => {
    insertFact(db, { id: "fact_a", entityId: "ent_1", attribute: "x", value: "1" });
    insertFact(db, { id: "fact_b", entityId: "ent_1", attribute: "x", value: "2" });
    const before = db.prepare("SELECT * FROM facts ORDER BY id").all();

    detectContradictions(db, { now: NOW });

    const after = db.prepare("SELECT * FROM facts ORDER BY id").all();
    expect(after).toEqual(before);
  });

  it("is idempotent — a second identical pass re-flags nothing new and writes no duplicate audit rows", () => {
    insertFact(db, { id: "fact_a", entityId: "ent_1", attribute: "x", value: "1" });
    insertFact(db, { id: "fact_b", entityId: "ent_1", attribute: "x", value: "2" });

    const first = detectContradictions(db, { now: NOW });
    expect(first.factsFlagged).toBe(2);

    const second = detectContradictions(db, { now: NOW });
    expect(second.factsFlagged).toBe(0);
    expect(second.factsUnchanged).toBe(2);

    const auditRows = db
      .prepare("SELECT COUNT(*) AS n FROM memory_audit WHERE operation = 'contradiction_flagged'")
      .get() as { n: number };
    expect(auditRows.n).toBe(2); // NOT 4 — the second pass wrote nothing new
  });

  it("clears the flag once a conflict resolves (sibling superseded away)", () => {
    insertFact(db, { id: "fact_a", entityId: "ent_1", attribute: "x", value: "1" });
    insertFact(db, { id: "fact_b", entityId: "ent_1", attribute: "x", value: "2" });
    detectContradictions(db, { now: NOW });
    expect(getLifecycle(db, "fact_a", "fact")?.contradiction_json).toBeTruthy();

    // Simulate resolution: fact_b gets superseded (as a real supersession would).
    db.prepare("UPDATE facts SET superseded_by = 'fact_c', valid_to = ? WHERE id = 'fact_b'").run(NOW);

    const stats = detectContradictions(db, { now: NOW });

    // Both flags clear: fact_a (no longer in any conflicting ACTIVE group) AND
    // fact_b (no longer active at all — a superseded row must not keep carrying
    // a stale "contradicted" flag forward either).
    expect(stats.factsCleared).toBe(2);
    expect(getLifecycle(db, "fact_a", "fact")?.contradiction_json).toBeNull();
    expect(getLifecycle(db, "fact_b", "fact")?.contradiction_json).toBeNull();
    const resolved = db
      .prepare("SELECT operation FROM memory_audit WHERE owner_id = 'fact_a' AND operation = 'contradiction_resolved'")
      .get() as { operation: string } | undefined;
    expect(resolved?.operation).toBe("contradiction_resolved");
  });

  it("scopes detection to the given namespace — other namespaces are untouched", () => {
    insertFact(db, { id: "fact_a", entityId: "ent_1", attribute: "x", value: "1", namespace: "ns1" });
    insertFact(db, { id: "fact_b", entityId: "ent_1", attribute: "x", value: "2", namespace: "ns1" });
    insertFact(db, { id: "fact_c", entityId: "ent_1", attribute: "x", value: "3", namespace: "ns2" });
    insertFact(db, { id: "fact_d", entityId: "ent_1", attribute: "x", value: "4", namespace: "ns2" });

    const stats = detectContradictions(db, { now: NOW, namespace: "ns1" });

    expect(stats.groupsConflicting).toBe(1);
    expect(stats.factsFlagged).toBe(2);
    // ns2's conflicting pair was never scanned this pass.
    expect(getLifecycle(db, "fact_c", "fact")).toBeNull();
    expect(getLifecycle(db, "fact_d", "fact")).toBeNull();
  });

  it("reports scanCapped when the active-fact scan hits MAX_ACTIVE_FACTS_SCANNED", () => {
    db.prepare("BEGIN").run();
    for (let i = 0; i < MAX_ACTIVE_FACTS_SCANNED + 1; i++) {
      insertFact(db, { id: `fact_${i}`, entityId: `ent_${i}`, attribute: "solo", value: "v" });
    }
    db.prepare("COMMIT").run();

    const stats = detectContradictions(db, { now: NOW });

    expect(stats.scanCapped).toBe(true);
  });

  it("never throws — an internal error degrades to all-zero stats", () => {
    // Drop the facts table the detector depends on to force an internal error.
    db.prepare("DROP TABLE facts").run();
    const stats = detectContradictions(db, { now: NOW });
    expect(stats).toEqual({
      groupsChecked: 0,
      groupsConflicting: 0,
      factsFlagged: 0,
      factsUnchanged: 0,
      factsCleared: 0,
      scanCapped: false,
    });
  });
});
