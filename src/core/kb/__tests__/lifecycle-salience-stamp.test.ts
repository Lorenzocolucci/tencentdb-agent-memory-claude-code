/**
 * Pilastro C — Fase 1 bridge: stampSalience.
 *
 * Idea 5 (distinctiveness) computes which memories are distinctive peaks. This
 * primitive carries that verdict onto the lifecycle row's `salience` so the
 * distinctiveness-aware decay can protect them. MONOTONIC: it only ever RAISES
 * salience — corpus-relative distinctiveness wobbles session to session, and a
 * recognized peak must not flap back into "noise" and get decayed away.
 *
 * Pins:
 *   - stamps salience on a fresh row, recomputes permanence, writes audit
 *   - monotonic: a lower (or equal) salience is a no-op
 *   - a higher salience raises it and re-audits
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { ensureLifecycle, getLifecycle, stampSalience, computePermanence } from "../lifecycle-writer.js";
import { _resetUlidStateForTest } from "../kb-queries.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
const NOW = "2026-06-24T01:00:00.000Z";

function auditOps(db: DatabaseSync, ownerId: string): string[] {
  return (
    db.prepare("SELECT operation FROM memory_audit WHERE owner_id = ? ORDER BY id").all(ownerId) as Array<{ operation: string }>
  ).map((r) => r.operation);
}

describe("lifecycle-writer — stampSalience (Pilastro C bridge)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    initFoundationsSchema(db);
  });

  it("stamps salience on a fresh row, recomputes permanence, writes audit", () => {
    const r = stampSalience(db, { ownerId: "evt_1", ownerKind: "event", salience: 0.8, now: NOW });
    expect(r?.salience).toBeCloseTo(0.8, 10);
    // permanence = reinforcement_count(0)*0.5 + salience(0.8)
    expect(r?.permanence_score).toBeCloseTo(computePermanence(0, 0.8), 10);
    expect(auditOps(db, "evt_1")).toContain("salience");
  });

  it("is monotonic: a lower salience is a no-op (peak stays a peak)", () => {
    stampSalience(db, { ownerId: "evt_1", ownerKind: "event", salience: 0.8, now: NOW });
    const before = getLifecycle(db, "evt_1", "event");
    const r = stampSalience(db, { ownerId: "evt_1", ownerKind: "event", salience: 0.3, now: NOW });
    expect(r?.salience).toBeCloseTo(0.8, 10); // unchanged
    // no second 'salience' audit row for the no-op
    expect(auditOps(db, "evt_1").filter((o) => o === "salience").length).toBe(1);
    expect(r?.permanence_score).toBeCloseTo(before?.permanence_score ?? -1, 10);
  });

  it("raises salience when the new value is higher, and re-audits", () => {
    stampSalience(db, { ownerId: "evt_1", ownerKind: "event", salience: 0.5, now: NOW });
    const r = stampSalience(db, { ownerId: "evt_1", ownerKind: "event", salience: 0.9, now: NOW });
    expect(r?.salience).toBeCloseTo(0.9, 10);
    expect(auditOps(db, "evt_1").filter((o) => o === "salience").length).toBe(2);
  });

  it("preserves reinforcement in the recomputed permanence", () => {
    ensureLifecycle(db, { ownerId: "evt_1", ownerKind: "event", now: NOW });
    db.prepare("UPDATE memory_lifecycle SET reinforcement_count = 3 WHERE owner_id='evt_1'").run();
    const r = stampSalience(db, { ownerId: "evt_1", ownerKind: "event", salience: 0.6, now: NOW });
    // permanence = 3*0.5 + 0.6 = 2.1
    expect(r?.permanence_score).toBeCloseTo(computePermanence(3, 0.6), 10);
  });
});
