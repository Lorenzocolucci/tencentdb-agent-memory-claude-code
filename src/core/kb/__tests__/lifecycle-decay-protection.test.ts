/**
 * Pilastro C — Fase 1: distinctiveness-aware decay ("dimenticare con gusto").
 *
 * The gap this closes: today decay() halves every stale memory's permanence,
 * blind to how distinctive it is. A rare-but-crucial peak (von Restorff /
 * cornerstone) fades exactly like noise. Fix: memories whose `salience` clears
 * PROTECTED_MIN_SALIENCE decay SLOWER (PROTECTED_DECAY_FACTOR), never fall below
 * PROTECTED_PERMANENCE_FLOOR, and never go `dormant`. They fade, they don't die.
 *
 * Deterministic, no LLM, no embeddings — immune to any embedding outage.
 *
 * Pins:
 *   - noise (salience 0) still halves + goes dormant (regression pin, unchanged)
 *   - a distinctive peak decays gently and stays `active` at the same staleness
 *   - the floor holds under repeated decay: a peak never goes dormant
 *   - protected decays leave a distinct audit reason (inspectable trail)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { ensureLifecycle, getLifecycle, type LifecycleRow } from "../lifecycle-writer.js";
import {
  decay,
  applyStaleness,
  DECAY_FACTOR,
  PROTECTED_DECAY_FACTOR,
  PROTECTED_MIN_SALIENCE,
  PROTECTED_PERMANENCE_FLOOR,
} from "../lifecycle-decay.js";
import { _resetUlidStateForTest } from "../kb-queries.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };

const NOW = "2026-06-24T01:00:00.000Z";
const OLD = "2026-06-01T00:00:00.000Z"; // well before NOW → stale

/** Seed one lifecycle row with an explicit state for decay scenarios. */
function seed(
  db: DatabaseSync,
  p: { ownerId: string; salience: number; perm: number; tier: string; last?: string | null },
): LifecycleRow {
  ensureLifecycle(db, { ownerId: p.ownerId, ownerKind: "fact", now: NOW, salience: p.salience });
  db.prepare(
    `UPDATE memory_lifecycle
       SET permanence_score = ?, tier = ?, state = 'active', last_reinforced_at = ?
     WHERE owner_id = ? AND owner_kind = 'fact'`,
  ).run(p.perm, p.tier, p.last ?? OLD, p.ownerId);
  return getLifecycle(db, p.ownerId, "fact") as LifecycleRow;
}

function lastAuditReason(db: DatabaseSync, ownerId: string): string {
  const row = db
    .prepare("SELECT reason FROM memory_audit WHERE owner_id = ? AND operation = 'decay' ORDER BY id DESC LIMIT 1")
    .get(ownerId) as { reason: string } | undefined;
  return row?.reason ?? "";
}

describe("lifecycle-decay — distinctiveness-aware protection", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    initFoundationsSchema(db);
  });

  it("threshold constants are sane (peak protection is gentler than noise)", () => {
    expect(PROTECTED_DECAY_FACTOR).toBeGreaterThan(DECAY_FACTOR);
    expect(PROTECTED_DECAY_FACTOR).toBeLessThan(1);
    expect(PROTECTED_MIN_SALIENCE).toBeGreaterThan(0);
    expect(PROTECTED_PERMANENCE_FLOOR).toBeGreaterThan(0);
  });

  it("noise (salience 0) halves and goes dormant — unchanged behavior", () => {
    seed(db, { ownerId: "noise", salience: 0, perm: 0.4, tier: "short" });
    const after = decay(db, { ownerId: "noise", ownerKind: "fact", now: NOW });
    expect(after?.permanence_score).toBeCloseTo(0.2, 10);
    expect(after?.state).toBe("dormant");
  });

  it("a distinctive peak decays gently and stays active at the SAME staleness", () => {
    seed(db, { ownerId: "peak", salience: PROTECTED_MIN_SALIENCE, perm: 0.4, tier: "short" });
    const after = decay(db, { ownerId: "peak", ownerKind: "fact", now: NOW });
    // 0.4 * 0.9 = 0.36 (gentle), still ≥ floor, still active
    expect(after?.permanence_score).toBeCloseTo(0.4 * PROTECTED_DECAY_FACTOR, 10);
    expect(after?.state).toBe("active");
  });

  it("the floor holds: a peak never goes dormant under repeated decay", () => {
    seed(db, { ownerId: "peak", salience: 0.9, perm: 1.0, tier: "short" });
    let row: LifecycleRow | null = null;
    for (let i = 0; i < 50; i++) {
      row = decay(db, { ownerId: "peak", ownerKind: "fact", now: NOW });
    }
    expect(row?.state).toBe("active");
    expect(row?.permanence_score).toBeGreaterThanOrEqual(PROTECTED_PERMANENCE_FLOOR);
  });

  it("applyStaleness: peak survives active while noise goes dormant (side by side)", () => {
    seed(db, { ownerId: "noise", salience: 0, perm: 0.4, tier: "short" });
    seed(db, { ownerId: "peak", salience: 0.8, perm: 0.4, tier: "short" });
    const n = applyStaleness(db, { now: NOW, staleAfterMs: 1000 });
    expect(n).toBe(2); // both were stale and swept
    expect(getLifecycle(db, "noise", "fact")?.state).toBe("dormant");
    expect(getLifecycle(db, "peak", "fact")?.state).toBe("active");
  });

  it("protected decay leaves a distinct, inspectable audit reason", () => {
    seed(db, { ownerId: "peak", salience: 0.8, perm: 0.4, tier: "short" });
    decay(db, { ownerId: "peak", ownerKind: "fact", now: NOW });
    expect(lastAuditReason(db, "peak")).toMatch(/protected/i);
  });
});
