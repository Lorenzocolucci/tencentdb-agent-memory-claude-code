/**
 * Lessons orchestrator (Phase B, B1+) — ties cross-session clustering to the
 * LLM distiller and the writer.
 *
 * Flow per FailureCluster:
 *   1. Skip if any bug event already covered by a lesson (dedup by event id).
 *   2. Build a DistillableCluster from the cluster's bugTexts.
 *   3. Distill via the LLM (skip on null — never throws).
 *   4. Write: insert new HEAD when (domain, trigger) is new; otherwise
 *      "accept-if-improves" — supersede old HEAD only when the new lesson
 *      scores higher (v1: confidence; eval-set scoring lands at B3).
 *
 * evidence_count = cluster.bugEventIds.length (distinct cross-session bugs).
 * Async + LLM, but the runner is injected → unit-testable offline.
 */

import type { DatabaseSync } from "node:sqlite";
import type { LLMRunner } from "../types.js";
import { selectFailureClusters, type FailureCluster } from "./bug-clusters.js";
import type { EmbeddingReader } from "./bug-embeddings.js";
import {
  distillLesson,
  type DistillableCluster,
  type DistillOptions,
} from "./lessons-distiller.js";
import {
  insertLesson,
  queryHeadLessonByTrigger,
  supersedeLesson,
} from "./lessons-writer.js";

export interface DistillLessonsParams {
  namespace?: string;
  sinceTs?: string;
  /** Cap the clusters processed in one run (LLM cost control). */
  maxClusters?: number;
  now: string;
  /** Injectable clock for deterministic ids in tests. */
  nowMs?: number;
  distill?: DistillOptions;
  /** Injectable embedding reader for tests (omit to use live sqlite-vec). */
  embeddingReader?: EmbeddingReader;
}

export interface LessonsRunStats {
  candidates: number;
  distilled: number;
  inserted: number;
  superseded: number;
  skippedDuplicate: number;
  skippedUndistillable: number;
  skippedNotImproved: number;
}

/** Has any lesson already recorded ANY of this cluster's bug event ids? (dedup) */
function clusterAlreadyCovered(db: DatabaseSync, bugEventIds: readonly string[]): boolean {
  for (const id of bugEventIds) {
    const row = db
      .prepare("SELECT 1 FROM lessons WHERE evidence_event_ids_json LIKE ? LIMIT 1")
      .get(`%"${id}"%`);
    if (row != null) return true;
  }
  return false;
}

/** Map a FailureCluster to a minimal DistillableCluster for the prompt. */
function toDistillable(cluster: FailureCluster): DistillableCluster {
  return {
    project: cluster.project,
    bugText: cluster.bugTexts[0] ?? "",
    // Remaining bug recurrences are treated as "fix texts" to give the LLM full
    // context. B2 will replace this with a proper trigger fingerprint prompt.
    fixTexts: cluster.bugTexts.slice(1),
  };
}

/**
 * Run one lesson-distillation pass over cross-session failure clusters. Returns
 * counters; never throws (individual cluster failures degrade to a skip).
 */
export async function distillLessons(
  db: DatabaseSync,
  llmRunner: LLMRunner,
  params: DistillLessonsParams,
): Promise<LessonsRunStats> {
  const stats: LessonsRunStats = {
    candidates: 0,
    distilled: 0,
    inserted: 0,
    superseded: 0,
    skippedDuplicate: 0,
    skippedUndistillable: 0,
    skippedNotImproved: 0,
  };

  const allClusters = selectFailureClusters(db, {
    namespace: params.namespace,
    sinceTs: params.sinceTs,
    embeddingReader: params.embeddingReader,
  });
  const clusters =
    typeof params.maxClusters === "number"
      ? allClusters.slice(0, params.maxClusters)
      : allClusters;
  stats.candidates = clusters.length;

  for (const cluster of clusters) {
    if (clusterAlreadyCovered(db, cluster.bugEventIds)) {
      stats.skippedDuplicate += 1;
      continue;
    }

    const distilled = await distillLesson(toDistillable(cluster), llmRunner, params.distill);
    if (!distilled) {
      stats.skippedUndistillable += 1;
      continue;
    }
    stats.distilled += 1;

    const head = queryHeadLessonByTrigger(db, {
      namespace: cluster.namespace,
      domain: distilled.domain,
      triggerPattern: distilled.triggerPattern,
    });

    // accept-if-improves: only replace an existing HEAD when the new lesson
    // scores higher. v1 score = confidence; eval-set scoring lands at B3.
    if (head && distilled.confidence <= head.confidence) {
      stats.skippedNotImproved += 1;
      continue;
    }

    // evidence_count = number of distinct bug events in the cross-session cluster.
    const inserted = insertLesson(
      db,
      {
        namespace: cluster.namespace,
        project: cluster.project,
        domain: distilled.domain,
        triggerPattern: distilled.triggerPattern,
        lessonText: distilled.lessonText,
        antiPatterns: distilled.antiPatterns,
        evidenceEventIds: cluster.bugEventIds,
        confidence: distilled.confidence,
        version: head ? head.version + 1 : 1,
        provenance: {
          sessionKeys: cluster.sessionKeys,
          source: "phase-b1-cluster-distiller",
        },
        now: params.now,
      },
      params.nowMs,
    );

    if (head) {
      supersedeLesson(db, head.id, inserted.id, params.now);
      stats.superseded += 1;
    } else {
      stats.inserted += 1;
    }
  }

  return stats;
}
