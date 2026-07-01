/**
 * Usage orchestrator (Slice B2, Percorso B) — one behavioral-tendency pass:
 * fetch recent events → cluster recurring cross-session behaviors SEMANTICALLY
 * → skip clusters already covered by a usage atom (idempotent) → write the
 * usage atom. Deterministic: no LLM (B2 is wiring; refinement is A3).
 *
 * Store-level like principle-runner, PLUS an injected EmbeddingReader (usage
 * clustering is semantic — it needs vectors, unlike per-entity principles).
 * In live the reader is createKbVecEmbeddingReader(db); tests inject a fake.
 * CHEAP: no cluster → no write. Never throws: any failure degrades to a skip.
 */
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingReader } from "./bug-embeddings.js";
import { selectUsageClusters, DEFAULT_USAGE_ELIGIBLE_TYPES } from "./usage-clusters.js";
import { writeUsage, USAGE_TYPE, USAGE_SRC_PREFIX } from "./usage-writer.js";

export interface DistillUsageParams {
  now: string;
  namespace?: string;
  /** Cap clusters processed per run. */
  maxClusters?: number;
  /** Only consider events newer than this ISO ts. */
  sinceTs?: string;
  /** How many recent events to scan. */
  scanLimit?: number;
  salience?: number;
  eligibleTypes?: readonly string[];
}

export interface UsageRunStats {
  candidates: number;
  inserted: number;
  skippedDuplicate: number;
}

const ZERO: UsageRunStats = { candidates: 0, inserted: 0, skippedDuplicate: 0 };

export async function distillUsage(
  store: IMemoryStore,
  embeddingReader: EmbeddingReader,
  params: DistillUsageParams,
): Promise<UsageRunStats> {
  const stats: UsageRunStats = { ...ZERO };
  try {
    if (typeof store.listRecentEvents !== "function" || typeof store.insertEvent !== "function") {
      return stats;
    }

    const events = store.listRecentEvents(params.namespace, {
      sinceTs: params.sinceTs,
      limit: params.scanLimit ?? 2000,
    });
    if (events.length === 0) return stats;

    const eligibleTypes = params.eligibleTypes ?? DEFAULT_USAGE_ELIGIBLE_TYPES;
    const eligibleSet = new Set(eligibleTypes);

    // Embeddings for the eligible events only (usage clustering is semantic).
    const embeddings = new Map<string, Float32Array>();
    for (const e of events) {
      if (!eligibleSet.has(e.type)) continue;
      const v = embeddingReader(e.id);
      if (v) embeddings.set(e.id, v);
    }

    const clusters = selectUsageClusters(events, { embeddings, eligibleTypes });
    stats.candidates = clusters.length;
    if (clusters.length === 0) return stats;

    // Idempotency: an event id already recorded by an existing usage atom.
    const covered = new Set<string>();
    for (const e of events) {
      if (e.type !== USAGE_TYPE) continue;
      for (const ent of e.entities ?? []) {
        if (ent.startsWith(USAGE_SRC_PREFIX)) covered.add(ent.slice(USAGE_SRC_PREFIX.length));
      }
    }

    const toProcess =
      typeof params.maxClusters === "number" ? clusters.slice(0, params.maxClusters) : clusters;

    for (const cluster of toProcess) {
      if (cluster.eventIds.some((id) => covered.has(id))) {
        stats.skippedDuplicate += 1;
        continue;
      }
      const written = writeUsage({ store, cluster, now: params.now, salience: params.salience });
      if (written) {
        stats.inserted += 1;
        for (const id of cluster.eventIds) covered.add(id); // guard within the same pass
      }
    }

    return stats;
  } catch {
    return stats;
  }
}
