/**
 * Phase A — lifecycle access layer tests (memory_lifecycle + memory_audit).
 *
 * Throwaway in-memory DB. Schema is created via initFoundationsSchema (the same
 * code that runs in production), so these tests also exercise the foundations.
 * Pins:
 *   - ensureLifecycle creates defaults and is idempotent
 *   - reinforce bumps count + permanence + last_reinforced_at
 *   - TWO-CONDITION promotion short -> long (count AND permanence)
 *   - every change writes an audit row (reinforce / promote)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { ensureLifecycle, getLifecycle, reinforce, computePermanence } from "../lifecycle-writer.js";
import { recordAudit } from "../memory-audit.js";
import { _resetUlidStateForTest } from "../kb-queries.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
const NOW = "2026-06-24T01:00:00.000Z";

function auditRows(db: DatabaseSync, ownerId: string): Array<{ operation: string }> {
  return db
    .prepare("SELECT operation FROM memory_audit WHERE owner_id = ? ORDER BY id")
    .all(ownerId) as Array<{ operation: string }>;
}

describe("lifecycle-writer", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    initFoundationsSchema(db);
  });

  it("computePermanence: repetition + salience", () => {
    expect(computePermanence(0, 0)).toBe(0);
    expect(computePermanence(3, 0)).toBe(1.5);
    expect(computePermanence(2, 0.5)).toBe(1.5);
  });

  it("ensureLifecycle creates defaults and is idempotent", () => {
    const a = ensureLifecycle(db, { ownerId: "fact_1", ownerKind: "fact", now: NOW });
    expect(a.tier).toBe("short");
    expect(a.state).toBe("active");
    expect(a.reinforcement_count).toBe(0);
    // Second call returns the SAME row, does not duplicate.
    ensureLifecycle(db, { ownerId: "fact_1", ownerKind: "fact", now: NOW });
    const count = db
      .prepare("SELECT COUNT(*) n FROM memory_lifecycle WHERE owner_id='fact_1'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("reinforce bumps count, permanence, and last_reinforced_at + writes audit", () => {
    const r = reinforce(db, { ownerId: "fact_1", ownerKind: "fact", now: NOW });
    expect(r.reinforcement_count).toBe(1);
    expect(r.permanence_score).toBe(0.5);
    expect(r.last_reinforced_at).toBe(NOW);
    expect(auditRows(db, "fact_1")).toEqual([{ operation: "reinforce" }]);
  });

  it("TWO-CONDITION promotion short -> long after enough reinforcement", () => {
    reinforce(db, { ownerId: "fact_1", ownerKind: "fact", now: NOW }); // count1 perm0.5 short
    reinforce(db, { ownerId: "fact_1", ownerKind: "fact", now: NOW }); // count2 perm1.0 short
    const third = reinforce(db, { ownerId: "fact_1", ownerKind: "fact", now: NOW }); // count3 perm1.5 -> long
    expect(third.tier).toBe("long");
    expect(third.reinforcement_count).toBe(3);
    // audit: two reinforce, then one promote.
    expect(auditRows(db, "fact_1").map((r) => r.operation)).toEqual(["reinforce", "reinforce", "promote"]);
  });

  it("recordAudit writes an append-only row with serialized before/after", () => {
    recordAudit(db, { ownerId: "evt_1", ownerKind: "event", operation: "decay", actor: "consolidation", before: { tier: "short" }, after: { tier: "dormant" } }, NOW);
    const row = db.prepare("SELECT owner_kind, operation, before_json, after_json FROM memory_audit WHERE owner_id='evt_1'").get() as {
      owner_kind: string; operation: string; before_json: string; after_json: string;
    };
    expect(row.owner_kind).toBe("event");
    expect(row.operation).toBe("decay");
    expect(JSON.parse(row.before_json)).toEqual({ tier: "short" });
    expect(JSON.parse(row.after_json)).toEqual({ tier: "dormant" });
  });
});
