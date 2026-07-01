/**
 * Usage writer (Slice B2, Percorso B) — stores a recurring behavioral tendency
 * as a first-class `events` atom (type='usage'), mirroring principle-writer.
 *
 * WHY an events atom: it flows through the existing recall (kb_fts/kb_vec) so a
 * usage tendency surfaces PROACTIVELY with no new injection code, and its
 * `salience` is stamped high so Pilastro C Fase 1's decay protects the peak.
 * Additive only: the source events are never touched (they decay via Fase 1).
 *
 * DETERMINISTIC — no LLM (B2 is wiring; LLM refinement is A3). The atom text is
 * the cluster's representative behavior, marked as an observed tendency (honest:
 * observed, not a stated law — laws are Percorso A).
 *
 * Off the critical path: never throws; returns null on any failure.
 */
import type { IMemoryStore, KbEvent } from "../store/types.js";
import type { UsageCluster } from "./usage-clusters.js";

export const USAGE_TYPE = "usage";
/** Prefix stored per member event id, so idempotency can detect coverage. */
export const USAGE_SRC_PREFIX = "usage-src:";
/** ≥ PROTECTED_MIN_SALIENCE (0.7 in lifecycle-decay) so Fase 1 shields the peak. */
export const USAGE_SALIENCE = 0.8;

export function writeUsage(params: {
  store: IMemoryStore;
  cluster: UsageCluster;
  now: string;
  salience?: number;
}): KbEvent | null {
  const { store, cluster, now } = params;
  try {
    if (typeof store.insertEvent !== "function") return null;
    const evidence = cluster.eventIds.length;
    // Member ids are recorded as entity markers so a later pass can skip a
    // cluster whose events are already covered by a usage atom (idempotency).
    const srcMarkers = cluster.eventIds.map((id) => `${USAGE_SRC_PREFIX}${id}`);
    const event = store.insertEvent({
      ts: now,
      sessionKey: cluster.sessionKey,
      project: cluster.project,
      type: USAGE_TYPE,
      text: `[modo d'uso ricorrente] ${cluster.theme}`,
      entities: [`evidence:${evidence}`, ...srcMarkers],
      sourceMessageIds: cluster.sourceMessageIds,
    });
    // Protect from staleness decay (Fase 1 bridge). Off critical path.
    store.stampSalience?.({
      ownerId: event.id,
      ownerKind: "event",
      salience: params.salience ?? USAGE_SALIENCE,
      now,
    });
    return event;
  } catch {
    return null;
  }
}
