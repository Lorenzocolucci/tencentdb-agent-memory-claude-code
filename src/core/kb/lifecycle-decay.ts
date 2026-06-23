/**
 * Lifecycle decay — the "forget the noise" half of consolidation.
 *
 * The research insight: the best memory is not the one that remembers
 * everything, it's the one that lets the noise fade at the right time. Memories
 * that stop being reinforced lose permanence and drift down the tiers
 * (long -> short -> dormant). Nothing is ever DELETED — dormant rows stay for
 * audit and can be revived by a future reinforcement.
 *
 * Every decay is mirrored into memory_audit (reversible trail).
 */

import type { DatabaseSync } from "node:sqlite";
import { getLifecycle, type LifecycleRow, PROMOTE_MIN_PERMANENCE } from "./lifecycle-writer.js";
import { recordAudit } from "./memory-audit.js";

/** Each decay multiplies permanence by this factor. */
export const DECAY_FACTOR = 0.5;
/** Below this permanence a 'short' memory goes dormant. */
export const DORMANT_MIN_PERMANENCE = 0.25;

/** Decay one memory: lower permanence, demote tier/state if it falls through. */
export function decay(
  db: DatabaseSync,
  params: { ownerId: string; ownerKind: string; now: string; reason?: string },
): LifecycleRow | null {
  const { ownerId, ownerKind, now } = params;
  const cur = getLifecycle(db, ownerId, ownerKind);
  if (!cur || cur.state === "dormant") return cur;

  const newPerm = cur.permanence_score * DECAY_FACTOR;
  let newTier = cur.tier;
  let newState = cur.state;
  if (cur.tier === "long" && newPerm < PROMOTE_MIN_PERMANENCE) {
    newTier = "short";
  } else if (cur.tier === "short" && newPerm < DORMANT_MIN_PERMANENCE) {
    newState = "dormant";
  }

  db.prepare(
    `UPDATE memory_lifecycle
       SET permanence_score = ?, tier = ?, state = ?, updated_time = ?
     WHERE owner_id = ? AND owner_kind = ?`,
  ).run(newPerm, newTier, newState, now, ownerId, ownerKind);

  recordAudit(
    db,
    {
      ownerId,
      ownerKind,
      operation: "decay",
      actor: "consolidation",
      before: { tier: cur.tier, state: cur.state, permanence_score: cur.permanence_score },
      after: { tier: newTier, state: newState, permanence_score: newPerm },
      reason: params.reason ?? "staleness decay",
      namespace: cur.namespace,
    },
    now,
  );

  return getLifecycle(db, ownerId, ownerKind);
}

/**
 * Decay every ACTIVE memory not reinforced since `now - staleAfterMs`. Uses
 * created_time as the fallback when a row was never reinforced. Returns how many
 * rows were decayed.
 */
export function applyStaleness(
  db: DatabaseSync,
  params: { now: string; staleAfterMs: number; namespace?: string },
): number {
  const cutoff = new Date((Date.parse(params.now) || 0) - params.staleAfterMs).toISOString();
  const rows = db
    .prepare(
      `SELECT owner_id, owner_kind FROM memory_lifecycle
        WHERE state = 'active'
          AND COALESCE(last_reinforced_at, created_time) < ?
          ${params.namespace ? "AND namespace = ?" : ""}`,
    )
    .all(...(params.namespace ? [cutoff, params.namespace] : [cutoff])) as Array<{
    owner_id: string;
    owner_kind: string;
  }>;

  for (const r of rows) {
    decay(db, { ownerId: r.owner_id, ownerKind: r.owner_kind, now: params.now, reason: "staleness sweep" });
  }
  return rows.length;
}
