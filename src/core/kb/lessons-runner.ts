/**
 * Lessons orchestrator (Phase B, B2a+) — clusters → trigger → distill → write.
 *
 * B2a: trigger_pattern = canonicalTrigger(clusterTrigger(...)), never LLM text.
 * Fix texts from fixed-by/caused relations only (not bugTexts.slice(1)).
 * DB helpers in lessons-runner-db.ts.
 */

import type { DatabaseSync } from "node:sqlite";
import type { LLMRunner } from "../types.js";
import { selectFailureClusters, type FailureCluster } from "./bug-clusters.js";
import type { EmbeddingReader } from "./bug-embeddings.js";
import { extractErrorSignatures } from "./error-signature-extractor.js";
import { clusterTrigger, canonicalTrigger, type PerBugBreakdown } from "./lesson-trigger.js";
import { loadEntityMap, resolvePerBugFiles, loadFixTexts } from "./lessons-runner-db.js";
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

// ── Dedup ─────────────────────────────────────────────────────────────────────

function clusterAlreadyCovered(db: DatabaseSync, bugEventIds: readonly string[]): boolean {
  for (const id of bugEventIds) {
    const row = db
      .prepare("SELECT 1 FROM lessons WHERE evidence_event_ids_json LIKE ? LIMIT 1")
      .get(`%"${id}"%`);
    if (row != null) return true;
  }
  return false;
}

// ── Distillable adapter ───────────────────────────────────────────────────────

function toDistillable(cluster: FailureCluster, fixTexts: string[]): DistillableCluster {
  return {
    project: cluster.project,
    bugTexts: [...cluster.bugTexts],
    fixTexts,
  };
}

// ── Cluster processor ─────────────────────────────────────────────────────────

async function processCluster(
  db: DatabaseSync,
  llmRunner: LLMRunner,
  params: DistillLessonsParams,
  cluster: FailureCluster,
  stats: LessonsRunStats,
): Promise<void> {
  if (clusterAlreadyCovered(db, cluster.bugEventIds)) {
    stats.skippedDuplicate += 1;
    return;
  }

  // Per-bug breakdowns for canonical trigger computation
  const entityMapRaw = loadEntityMap(db, cluster.bugEventIds);
  const perBugFiles = resolvePerBugFiles(db, cluster.bugEventIds, entityMapRaw);

  const breakdowns: PerBugBreakdown[] = cluster.bugEventIds.map((bugId, i) => ({
    bugEventId: bugId,
    files: perBugFiles.get(bugId) ?? [],
    errorSignatures: extractErrorSignatures(cluster.bugTexts[i] ?? ""),
    // taskType: live events have no task_type field (honesty-check: spec §2)
    taskType: "",
  }));

  const triggerFp = clusterTrigger(cluster, breakdowns);
  const triggerPattern = canonicalTrigger(triggerFp);

  // Fix texts from relations (NOT bugTexts.slice(1) — those are recurrences).
  // Pass entityMapRaw so loadFixTexts can traverse ent_* relation endpoints
  // without an extra DB query (the map is already built above).
  const fixTexts = loadFixTexts(db, cluster.bugEventIds, entityMapRaw);

  const distilled = await distillLesson(
    toDistillable(cluster, fixTexts),
    llmRunner,
    params.distill,
  );
  if (!distilled) {
    stats.skippedUndistillable += 1;
    return;
  }
  stats.distilled += 1;

  const head = queryHeadLessonByTrigger(db, {
    namespace: cluster.namespace,
    domain: distilled.domain,
    triggerPattern,
  });

  if (head && distilled.confidence <= head.confidence) {
    stats.skippedNotImproved += 1;
    return;
  }

  const inserted = insertLesson(
    db,
    {
      namespace: cluster.namespace,
      project: cluster.project,
      domain: distilled.domain,
      triggerPattern,
      lessonText: distilled.lessonText,
      antiPatterns: distilled.antiPatterns,
      evidenceEventIds: cluster.bugEventIds,
      confidence: distilled.confidence,
      version: head ? head.version + 1 : 1,
      provenance: {
        sessionKeys: cluster.sessionKeys,
        source: "phase-b2a-cluster-distiller",
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

// ── Main export ───────────────────────────────────────────────────────────────

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
    try {
      await processCluster(db, llmRunner, params, cluster, stats);
    } catch {
      stats.skippedUndistillable += 1;
    }
  }

  return stats;
}
