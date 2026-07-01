/**
 * Principle orchestrator (Pilastro C, Fase 2) — one distillation pass:
 * fetch recent events → cluster recurring cross-session decisions → skip domains
 * already distilled (idempotent) → distil via LLM → write the principle atom.
 *
 * Store-level (IMemoryStore) like the rollover capture, so it is testable on a
 * real VectorStore. CHEAP by design: no cluster → no LLM call (the common case).
 * Never throws: any per-cluster failure degrades to a skip.
 */
import type { IMemoryStore } from "../store/types.js";
import type { LLMRunner } from "../types.js";
import { selectPrincipleClusters } from "./principle-clusters.js";
import { distillPrinciple, type DistillPrincipleOptions } from "./principle-distiller.js";
import { writePrinciple, PRINCIPLE_TYPE } from "./principle-writer.js";

export interface DistillPrinciplesParams {
  now: string;
  namespace?: string;
  /** Cap clusters processed per run (LLM cost control). */
  maxClusters?: number;
  /** Only consider events newer than this ISO ts. */
  sinceTs?: string;
  /** How many recent events to scan for clusters. */
  scanLimit?: number;
  salience?: number;
  distill?: DistillPrincipleOptions;
}

export interface PrincipleRunStats {
  candidates: number;
  inserted: number;
  skippedDuplicate: number;
  skippedUndistillable: number;
}

const ZERO: PrincipleRunStats = { candidates: 0, inserted: 0, skippedDuplicate: 0, skippedUndistillable: 0 };

export async function distillPrinciples(
  store: IMemoryStore,
  llmRunner: LLMRunner,
  params: DistillPrinciplesParams,
): Promise<PrincipleRunStats> {
  const stats: PrincipleRunStats = { ...ZERO };
  try {
    if (typeof store.listRecentEvents !== "function" || typeof store.insertEvent !== "function") {
      return stats;
    }

    const events = store.listRecentEvents(params.namespace, {
      sinceTs: params.sinceTs,
      limit: params.scanLimit ?? 2000,
    });
    if (events.length === 0) return stats;

    const clusters = selectPrincipleClusters(events, {});
    stats.candidates = clusters.length;
    if (clusters.length === 0) return stats;

    // Domains that already have a principle (idempotency): a principle atom's
    // first entity is its domainEntity.
    const covered = new Set<string>();
    for (const e of events) {
      if (e.type !== PRINCIPLE_TYPE) continue;
      for (const ent of e.entities ?? []) covered.add(ent);
    }

    const toProcess =
      typeof params.maxClusters === "number" ? clusters.slice(0, params.maxClusters) : clusters;

    for (const cluster of toProcess) {
      if (covered.has(cluster.domainEntity)) {
        stats.skippedDuplicate += 1;
        continue;
      }
      try {
        const distilled = await distillPrinciple(
          { project: cluster.project, domainEntity: cluster.domainEntity, texts: cluster.texts },
          llmRunner,
          params.distill,
        );
        if (!distilled) {
          stats.skippedUndistillable += 1;
          continue;
        }
        const written = writePrinciple({ store, cluster, distilled, now: params.now, salience: params.salience });
        if (written) {
          stats.inserted += 1;
          covered.add(cluster.domainEntity); // guard within the same pass
        } else {
          stats.skippedUndistillable += 1;
        }
      } catch {
        stats.skippedUndistillable += 1;
      }
    }

    return stats;
  } catch {
    return stats;
  }
}
