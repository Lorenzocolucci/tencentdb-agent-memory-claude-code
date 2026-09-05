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
  /** Optional sink so a capped pairwise pass is never silent. */
  logger?: { warn?(msg: string): void };
}

export interface LessonsRunStats {
  candidates: number;
  distilled: number;
  inserted: number;
  superseded: number;
  skippedDuplicate: number;
  /** The LLM answered but the answer was unusable (unparseable / CJK residue). */
  skippedUndistillable: number;
  skippedNotImproved: number;
  /**
   * The LLM call itself THREW (dead model, timeout, refusal). Counted apart from
   * skippedUndistillable so a dead model never reads as "nothing to learn"
   * (live 2026-09-05: 17/17 calls failed and the log said "no new lessons").
   */
  skippedLlmFailed: number;
  /** First few LLM error messages (bounded), for the runner's log line. */
  llmErrors: string[];
}

/** How many distinct LLM error messages a stats object keeps. */
export const MAX_LLM_ERRORS_KEPT = 3;

/** Record one thrown LLM call in the stats (bounded message list). */
export function noteLlmFailure(stats: { skippedLlmFailed: number; llmErrors: string[] }, message: string): void {
  stats.skippedLlmFailed += 1;
  if (stats.llmErrors.length < MAX_LLM_ERRORS_KEPT && !stats.llmErrors.includes(message)) {
    stats.llmErrors.push(message);
  }
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

  let llmFailed = false;
  const distilled = await distillLesson(
    toDistillable(cluster, fixTexts),
    llmRunner,
    {
      ...params.distill,
      onLlmError: (e) => {
        llmFailed = true;
        noteLlmFailure(stats, e.message);
        params.distill?.onLlmError?.(e);
      },
    },
  );
  if (!distilled) {
    // A thrown call is already counted by noteLlmFailure; only an unusable
    // ANSWER is "undistillable".
    if (!llmFailed) stats.skippedUndistillable += 1;
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
    skippedLlmFailed: 0,
    llmErrors: [],
  };

  const allClusters = selectFailureClusters(db, {
    namespace: params.namespace,
    sinceTs: params.sinceTs,
    embeddingReader: params.embeddingReader,
    logger: params.logger,
  });
  // Drop clusters that already have a lesson BEFORE applying the maxClusters
  // cap. Without this the cap always re-selected the SAME first N clusters —
  // which are precisely the ones distilled earliest — so every run skipped them
  // as duplicates and clusters beyond the cap were NEVER reached. Measured on
  // the live DB (2026-08-07): 27 real failure clusters, only 6 lessons ever
  // produced. The check is a cheap DB lookup (no LLM), so filtering first is
  // free and makes the cap mean "N NEW clusters per run" instead of
  // "the same N clusters forever". processCluster keeps its own guard.
  const fresh: FailureCluster[] = [];
  for (const c of allClusters) {
    if (clusterAlreadyCovered(db, c.bugEventIds)) {
      // Counted here (not in processCluster) so the reported stat is unchanged
      // while the cluster no longer consumes the maxClusters budget.
      stats.skippedDuplicate += 1;
      continue;
    }
    fresh.push(c);
  }
  const clusters =
    typeof params.maxClusters === "number"
      ? fresh.slice(0, params.maxClusters)
      : fresh;
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
