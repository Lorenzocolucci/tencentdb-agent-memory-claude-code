/**
 * Principle writer (Pilastro C, Fase 2) — stores a distilled principle as a
 * first-class `events` atom (type='principle'), NOT a row in the lessons table.
 *
 * WHY an events atom: it flows through the existing recall (kb_fts/kb_vec) so a
 * principle surfaces PROACTIVELY with no new injection code, and its lifecycle
 * `salience` is stamped high so Pilastro C Fase 1's distinctiveness-aware decay
 * protects it from staleness. Conservative: additive only — the source events
 * are never touched (they decay on their own via Fase 1).
 *
 * Off the critical path: never throws; returns null on any failure.
 */
import type { IMemoryStore, KbEvent } from "../store/types.js";
import type { PrincipleCluster } from "./principle-clusters.js";
import type { DistilledPrinciple } from "./principle-distiller.js";

export const PRINCIPLE_TYPE = "principle";
/** ≥ PROTECTED_MIN_SALIENCE (0.7 in lifecycle-decay) so Fase 1 shields the peak. */
export const PRINCIPLE_SALIENCE = 0.8;

export function writePrinciple(params: {
  store: IMemoryStore;
  cluster: PrincipleCluster;
  distilled: DistilledPrinciple;
  now: string;
  salience?: number;
}): KbEvent | null {
  const { store, cluster, distilled, now } = params;
  try {
    if (typeof store.insertEvent !== "function") return null;
    const evidence = cluster.eventIds.length;
    const event = store.insertEvent({
      ts: now,
      sessionKey: cluster.sessionKey,
      project: cluster.project,
      type: PRINCIPLE_TYPE,
      text: distilled.principleText,
      // domainEntity first so dedup/recall can key on it; the rest is metadata.
      entities: [cluster.domainEntity, `principle-domain:${distilled.domain}`, `evidence:${evidence}`],
      sourceMessageIds: cluster.sourceMessageIds,
    });
    // Protect from staleness decay (Fase 1 bridge). Off critical path.
    store.stampSalience?.({
      ownerId: event.id,
      ownerKind: "event",
      salience: params.salience ?? PRINCIPLE_SALIENCE,
      now,
    });
    return event;
  } catch {
    return null;
  }
}
