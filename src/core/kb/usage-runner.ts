/**
 * Usage orchestrator (Slice B2 + A3, Percorso B) — one behavioral-tendency pass:
 * fetch recent events → cluster recurring cross-session behaviors SEMANTICALLY
 * (wide recall at the candidate threshold) → LLM PRECISION GATE ("is this a real
 * tendency, or noise?") → skip clusters already covered (idempotent) → write the
 * confirmed tendency as a usage atom.
 *
 * WHY the LLM gate (A3): the live dry-run proved clustering alone surfaces mostly
 * noise on real data (status notes / test strings misclassified as `observation`).
 * Clustering gives recall; the distiller gives precision. Cheap: no cluster → no
 * LLM; calls are capped by maxClusters. Never throws: failures degrade to a skip.
 *
 * Store-level like principle-runner, PLUS an injected EmbeddingReader (semantic
 * clustering needs vectors) and an injected LLMRunner (the precision gate). In
 * live the reader is createKbVecEmbeddingReader(db); tests inject fakes.
 */
import type { IMemoryStore } from "../store/types.js";
import type { LLMRunner } from "../types.js";
import type { EmbeddingReader } from "./bug-embeddings.js";
import { selectUsageClusters, DEFAULT_USAGE_ELIGIBLE_TYPES } from "./usage-clusters.js";
import { USAGE_CANDIDATE_TAU } from "./usage-similarity.js";
import { distillUsageCluster, type DistillUsageOptions } from "./usage-distiller.js";
import { writeUsage, USAGE_TYPE, USAGE_SRC_PREFIX } from "./usage-writer.js";

export interface DistillUsageParams {
  now: string;
  namespace?: string;
  /** Cap clusters processed per run (LLM cost control). */
  maxClusters?: number;
  /** Only consider events newer than this ISO ts. */
  sinceTs?: string;
  /** How many recent events to scan. */
  scanLimit?: number;
  salience?: number;
  eligibleTypes?: readonly string[];
  /** Recall threshold for candidate clusters (LLM does precision). */
  candidateTau?: number;
  distill?: DistillUsageOptions;
  /** Optional logger so the pairwise-cap notice is observable in the gateway. */
  logger?: { warn?(msg: string): void };
}

export interface UsageRunStats {
  candidates: number;
  /** Clusters the LLM confirmed as genuine tendencies. */
  confirmed: number;
  inserted: number;
  skippedDuplicate: number;
  /** Clusters the LLM rejected as noise (or that were undistillable). */
  skippedRejected: number;
}

const ZERO: UsageRunStats = { candidates: 0, confirmed: 0, inserted: 0, skippedDuplicate: 0, skippedRejected: 0 };

export async function distillUsage(
  store: IMemoryStore,
  embeddingReader: EmbeddingReader,
  llmRunner: LLMRunner,
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

    // Wide recall: cluster at the candidate threshold; the LLM does precision.
    const clusters = selectUsageClusters(events, {
      embeddings,
      eligibleTypes,
      tau: params.candidateTau ?? USAGE_CANDIDATE_TAU,
      logger: params.logger,
    });
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
      // A3 precision gate: the LLM confirms/cleans, or rejects as noise.
      const distilled = await distillUsageCluster(
        { project: cluster.project, texts: cluster.texts },
        llmRunner,
        params.distill,
      );
      if (!distilled) {
        stats.skippedRejected += 1;
        continue;
      }
      stats.confirmed += 1;
      const written = writeUsage({
        store,
        cluster,
        now: params.now,
        salience: params.salience,
        text: distilled.tendencyText,
        confidence: distilled.confidence,
      });
      if (written) {
        stats.inserted += 1;
        for (const id of cluster.eventIds) covered.add(id); // guard within the same pass
      } else {
        stats.skippedRejected += 1;
      }
    }

    return stats;
  } catch {
    return stats;
  }
}
