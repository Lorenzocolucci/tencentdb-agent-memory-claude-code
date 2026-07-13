/**
 * memory_lifecycle writer — the access layer over the "living" state of each
 * memory unit (fact/event/lesson). The Consolidation Engine (Phase A) uses
 * these primitives; the source rows (events/facts) are never touched here.
 *
 * Promotion uses a TWO-CONDITION rule (the Synaptic Tagging & Capture analogue
 * from the neuroscience research): a memory moves short -> long only when it has
 * been reinforced enough AND is permanent enough — not on a single signal.
 *
 * Every state change is mirrored into memory_audit (reversible trail).
 */

import type { DatabaseSync } from "node:sqlite";
import { recordAudit } from "./memory-audit.js";
import {
  parseProvenance,
  serializeProvenance,
  deriveTrust,
  withPendingGate,
  withRejectedGate,
  gateStateOf,
  type StakesLevel,
  type StakesDomain,
} from "./provenance.js";

export interface LifecycleRow {
  owner_id: string;
  owner_kind: string;
  permanence_score: number;
  salience: number;
  reinforcement_count: number;
  last_reinforced_at: string | null;
  tier: string;
  state: string;
  retention_class: string;
  function_importance: number;
  provenance_json: string;
  decay_at: string | null;
  namespace: string;
  created_time: string;
  updated_time: string;
}

// Two-condition promotion thresholds (short -> long).
export const PROMOTE_MIN_REINFORCEMENT = 3;
export const PROMOTE_MIN_PERMANENCE = 1.5;

/**
 * v1 permanence score = repetition + salience. The connection term (graph
 * connectedness) is added in Phase D once spreading activation lands.
 */
export function computePermanence(reinforcementCount: number, salience: number): number {
  return reinforcementCount * 0.5 + salience;
}

/** Read one lifecycle row, or null if absent. */
export function getLifecycle(
  db: DatabaseSync,
  ownerId: string,
  ownerKind: string,
): LifecycleRow | null {
  const row = db
    .prepare("SELECT * FROM memory_lifecycle WHERE owner_id = ? AND owner_kind = ?")
    .get(ownerId, ownerKind);
  return (row as LifecycleRow) ?? null;
}

export interface EnsureLifecycleParams {
  ownerId: string;
  ownerKind: string;
  now: string;
  namespace?: string;
  salience?: number;
  retentionClass?: string;
  functionImportance?: number;
  provenance?: unknown;
}

/** Create the lifecycle row with defaults if missing (idempotent); return it. */
export function ensureLifecycle(db: DatabaseSync, p: EnsureLifecycleParams): LifecycleRow {
  const existing = getLifecycle(db, p.ownerId, p.ownerKind);
  if (existing) return existing;
  const salience = p.salience ?? 0;
  db.prepare(
    `INSERT INTO memory_lifecycle
       (owner_id, owner_kind, permanence_score, salience, reinforcement_count,
        tier, state, retention_class, function_importance, provenance_json,
        namespace, created_time, updated_time)
     VALUES (?, ?, ?, ?, 0, 'short', 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.ownerId,
    p.ownerKind,
    computePermanence(0, salience),
    salience,
    p.retentionClass ?? "default",
    p.functionImportance ?? 0.5,
    p.provenance !== undefined ? JSON.stringify(p.provenance) : "{}",
    p.namespace ?? "default",
    p.now,
    p.now,
  );
  return getLifecycle(db, p.ownerId, p.ownerKind) as LifecycleRow;
}

export interface ReinforceParams {
  ownerId: string;
  ownerKind: string;
  now: string;
  namespace?: string;
}

/**
 * Record one reinforcement ("replay"): bump count + last_reinforced_at,
 * recompute permanence, and apply the two-condition promotion. Writes an audit
 * row (operation = "promote" if tier changed, else "reinforce").
 */
export function reinforce(db: DatabaseSync, params: ReinforceParams): LifecycleRow {
  const { ownerId, ownerKind, now } = params;
  const cur = ensureLifecycle(db, { ownerId, ownerKind, now, namespace: params.namespace });

  const newCount = cur.reinforcement_count + 1;
  const newPerm = computePermanence(newCount, cur.salience);
  let newTier = cur.tier;
  if (
    cur.tier === "short" &&
    newCount >= PROMOTE_MIN_REINFORCEMENT &&
    newPerm >= PROMOTE_MIN_PERMANENCE
  ) {
    newTier = "long";
  }

  db.prepare(
    `UPDATE memory_lifecycle
       SET reinforcement_count = ?, last_reinforced_at = ?, permanence_score = ?,
           tier = ?, updated_time = ?
     WHERE owner_id = ? AND owner_kind = ?`,
  ).run(newCount, now, newPerm, newTier, now, ownerId, ownerKind);

  const promoted = newTier !== cur.tier;
  recordAudit(
    db,
    {
      ownerId,
      ownerKind,
      operation: promoted ? "promote" : "reinforce",
      actor: "consolidation",
      before: { tier: cur.tier, reinforcement_count: cur.reinforcement_count, permanence_score: cur.permanence_score },
      after: { tier: newTier, reinforcement_count: newCount, permanence_score: newPerm },
      reason: promoted ? "two-condition promotion short->long" : "reinforcement",
      namespace: cur.namespace,
    },
    now,
  );

  return getLifecycle(db, ownerId, ownerKind) as LifecycleRow;
}

export interface StampSalienceParams {
  ownerId: string;
  ownerKind: string;
  /** Distinctiveness score in [0,1] from Idea 5. */
  salience: number;
  now: string;
}

/**
 * Carry Idea 5's distinctiveness verdict onto the lifecycle `salience` (Pilastro
 * C bridge). This is what lets distinctiveness-aware decay protect the peak.
 *
 * MONOTONIC — only ever RAISES salience: corpus-relative distinctiveness wobbles
 * session to session, and a recognized peak must not flap back down and get
 * decayed like noise. A new value <= the current one is a no-op (no write, no
 * audit). Recomputes permanence (repetition + salience) and writes one audit row
 * (operation="salience"). Creates the lifecycle row first if missing.
 */
export function stampSalience(db: DatabaseSync, p: StampSalienceParams): LifecycleRow | null {
  const cur = ensureLifecycle(db, { ownerId: p.ownerId, ownerKind: p.ownerKind, now: p.now });
  if (p.salience <= cur.salience) return cur; // monotonic: never lower a peak

  const newPerm = computePermanence(cur.reinforcement_count, p.salience);
  db.prepare(
    `UPDATE memory_lifecycle SET salience = ?, permanence_score = ?, updated_time = ?
       WHERE owner_id = ? AND owner_kind = ?`,
  ).run(p.salience, newPerm, p.now, p.ownerId, p.ownerKind);

  recordAudit(
    db,
    {
      ownerId: p.ownerId,
      ownerKind: p.ownerKind,
      operation: "salience",
      actor: "system",
      before: { salience: cur.salience, permanence_score: cur.permanence_score },
      after: { salience: p.salience, permanence_score: newPerm },
      reason: "distinctiveness stamp (cornerstone)",
      namespace: cur.namespace,
    },
    p.now,
  );
  return getLifecycle(db, p.ownerId, p.ownerKind);
}

export interface ConfirmProvenanceParams {
  ownerId: string;
  ownerKind: string;
  now: string;
}

/**
 * Flip a memory unit's provenance stamp to lorenzo_confirmed/trusted and write one
 * audit row (operation="confirm", actor="user"). Creates the lifecycle row first if
 * missing. Returns the updated row, or null if absent after.
 */
export function confirmProvenance(
  db: DatabaseSync,
  p: ConfirmProvenanceParams,
): LifecycleRow | null {
  const cur = ensureLifecycle(db, { ownerId: p.ownerId, ownerKind: p.ownerKind, now: p.now });
  const before = parseProvenance(cur.provenance_json);
  const after = {
    ...before,
    origin: "lorenzo_confirmed" as const,
    trust: deriveTrust("lorenzo_confirmed"),
    confirmed_by: "lorenzo" as const,
    confirmed_at: p.now,
    // Resolving the question CLEARS the gate: a confirmed memory must stop
    // surfacing in getPendingAsks (asked once, learned forever).
    gate_state: "clear" as const,
  };
  db.prepare(
    `UPDATE memory_lifecycle SET provenance_json = ?, updated_time = ?
       WHERE owner_id = ? AND owner_kind = ?`,
  ).run(serializeProvenance(after), p.now, p.ownerId, p.ownerKind);

  recordAudit(
    db,
    {
      ownerId: p.ownerId,
      ownerKind: p.ownerKind,
      operation: "confirm",
      actor: "user",
      before: { trust: before.trust, origin: before.origin },
      after: { trust: after.trust, origin: after.origin },
      reason: "confirmed by Lorenzo",
      namespace: cur.namespace,
    },
    p.now,
  );
  return getLifecycle(db, p.ownerId, p.ownerKind);
}

export interface MarkGatePendingParams {
  ownerId: string;
  ownerKind: string;
  now: string;
  stakes: StakesLevel;
  stakesDomain: StakesDomain | null;
}

/**
 * Mark a memory unit as pending the ask-loop (Phase 2 gate). Idempotent-ish: only
 * a `clear` memory transitions; an already pending/rejected one is left untouched
 * (we never re-gate). Writes one audit row (operation="gate", actor="system").
 * Returns the (possibly unchanged) row.
 */
export function markGatePending(
  db: DatabaseSync,
  p: MarkGatePendingParams,
): LifecycleRow | null {
  const cur = ensureLifecycle(db, { ownerId: p.ownerId, ownerKind: p.ownerKind, now: p.now });
  const before = parseProvenance(cur.provenance_json);
  if (gateStateOf(before) !== "clear") return cur; // never re-gate
  const after = withPendingGate(before, { stakes: p.stakes, stakes_domain: p.stakesDomain });
  db.prepare(
    `UPDATE memory_lifecycle SET provenance_json = ?, updated_time = ?
       WHERE owner_id = ? AND owner_kind = ?`,
  ).run(serializeProvenance(after), p.now, p.ownerId, p.ownerKind);

  recordAudit(
    db,
    {
      ownerId: p.ownerId,
      ownerKind: p.ownerKind,
      operation: "gate",
      actor: "system",
      before: { gate_state: gateStateOf(before) },
      after: { gate_state: "pending_confirmation", stakes: p.stakes, stakes_domain: p.stakesDomain },
      reason: `stakes gate: ${p.stakesDomain ?? "high"}`,
      namespace: cur.namespace,
    },
    p.now,
  );
  return getLifecycle(db, p.ownerId, p.ownerKind);
}

export interface RejectProvenanceParams {
  ownerId: string;
  ownerKind: string;
  now: string;
}

/**
 * Tombstone a memory unit: Lorenzo said NO to the gate question. Marks the stamp
 * `rejected` (KEPT, not hard-deleted — the burned child learns to discriminate,
 * it does not forget the fire) and writes one audit row (operation="reject",
 * actor="user"). Returns the updated row.
 */
export function rejectProvenance(
  db: DatabaseSync,
  p: RejectProvenanceParams,
): LifecycleRow | null {
  const cur = ensureLifecycle(db, { ownerId: p.ownerId, ownerKind: p.ownerKind, now: p.now });
  const before = parseProvenance(cur.provenance_json);
  const after = withRejectedGate(before, p.now);
  db.prepare(
    `UPDATE memory_lifecycle SET provenance_json = ?, updated_time = ?
       WHERE owner_id = ? AND owner_kind = ?`,
  ).run(serializeProvenance(after), p.now, p.ownerId, p.ownerKind);

  recordAudit(
    db,
    {
      ownerId: p.ownerId,
      ownerKind: p.ownerKind,
      operation: "reject",
      actor: "user",
      before: { gate_state: gateStateOf(before) },
      after: { gate_state: "rejected", rejected_at: p.now },
      reason: "rejected by Lorenzo",
      namespace: cur.namespace,
    },
    p.now,
  );
  return getLifecycle(db, p.ownerId, p.ownerKind);
}
