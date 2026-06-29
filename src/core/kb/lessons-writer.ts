/**
 * Lessons writer (Phase B, part 2) — sync DB access layer over the `lessons`
 * table. Mirrors the kb-queries style: pure functions that take a DatabaseSync.
 *
 * A lesson's IDENTITY for versioning is (namespace, domain, trigger_pattern);
 * each version is its own row with a unique id, linked by superseded_by. The
 * HEAD of a trigger is the row with superseded_by IS NULL. "accept-if-improves"
 * (whether to supersede) is the orchestrator's call — this layer only provides
 * the primitives: insert, find-HEAD, supersede.
 */

import type { DatabaseSync } from "node:sqlite";
import { ulidLike } from "./kb-queries.js";

/** A row in the `lessons` table. */
export interface LessonRow {
  id: string;
  namespace: string;
  project: string;
  domain: string;
  trigger_pattern: string;
  lesson_text: string;
  anti_patterns_json: string;
  evidence_event_ids_json: string;
  evidence_count: number;
  confidence: number;
  version: number;
  superseded_by: string | null;
  superseded_at: string | null;
  provenance_json: string;
  created_time: string;
  updated_time: string;
}

export interface InsertLessonParams {
  namespace?: string;
  project?: string;
  domain: string;
  triggerPattern: string;
  lessonText: string;
  antiPatterns?: string[];
  evidenceEventIds?: string[];
  confidence?: number;
  version?: number;
  provenance?: unknown;
  now: string;
}

/** Insert a new lesson row (a fresh version). Returns the stored row. */
export function insertLesson(db: DatabaseSync, p: InsertLessonParams, nowMs?: number): LessonRow {
  const id = ulidLike("les", nowMs);
  const namespace = p.namespace ?? "default";
  const antiPatterns = p.antiPatterns ?? [];
  const evidenceEventIds = p.evidenceEventIds ?? [];
  db.prepare(
    `INSERT INTO lessons
       (id, namespace, project, domain, trigger_pattern, lesson_text,
        anti_patterns_json, evidence_event_ids_json, evidence_count,
        confidence, version, provenance_json, created_time, updated_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    namespace,
    p.project ?? "",
    p.domain,
    p.triggerPattern,
    p.lessonText,
    JSON.stringify(antiPatterns),
    JSON.stringify(evidenceEventIds),
    evidenceEventIds.length,
    p.confidence ?? 0.5,
    p.version ?? 1,
    p.provenance !== undefined ? JSON.stringify(p.provenance) : "{}",
    p.now,
    p.now,
  );
  return getLessonById(db, id) as LessonRow;
}

/** Fetch a lesson by id (any version), or null. */
export function getLessonById(db: DatabaseSync, id: string): LessonRow | null {
  const row = db.prepare("SELECT * FROM lessons WHERE id = ?").get(id);
  return (row as LessonRow) ?? null;
}

export interface TriggerKey {
  namespace?: string;
  domain: string;
  triggerPattern: string;
}

/** The current (HEAD) lesson for a (namespace, domain, trigger), or null. */
export function queryHeadLessonByTrigger(db: DatabaseSync, key: TriggerKey): LessonRow | null {
  const row = db
    .prepare(
      `SELECT * FROM lessons
        WHERE namespace = ? AND domain = ? AND trigger_pattern = ? AND superseded_by IS NULL
        ORDER BY version DESC LIMIT 1`,
    )
    .get(key.namespace ?? "default", key.domain, key.triggerPattern);
  return (row as LessonRow) ?? null;
}

/**
 * HEAD lessons whose trigger_pattern.files contains `fileEntityId` (B2b read).
 *
 * This is the RETRIEVAL counterpart to queryHeadLessonByTrigger (which is an
 * exact-trigger lookup for write-time dedup). Here the agent touched ONE file at
 * PostToolUse time and we want every live lesson whose recurring-failure pattern
 * involves that file, so Proactive Injection can resurface it unbidden.
 *
 * Matching uses json_each over the canonical trigger JSON's `$.files` array
 * (file entity ids), so a lesson triggered by {fileA, fileB} surfaces when EITHER
 * is touched. Only HEAD versions (superseded_by IS NULL) are returned, ranked by
 * confidence then evidence_count (strongest, best-attested lesson first).
 */
export function queryHeadLessonsByFile(
  db: DatabaseSync,
  fileEntityId: string,
  namespace = "default",
  limit = 3,
): LessonRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM lessons
        WHERE namespace = ? AND superseded_by IS NULL
          AND EXISTS (
            SELECT 1 FROM json_each(lessons.trigger_pattern, '$.files')
            WHERE json_each.value = ?
          )
        ORDER BY confidence DESC, evidence_count DESC, version DESC
        LIMIT ?`,
    )
    .all(namespace, fileEntityId, limit);
  return rows as LessonRow[];
}

/** Link an old lesson to the new version that replaces it (old leaves HEAD). */
export function supersedeLesson(db: DatabaseSync, oldId: string, newId: string, now: string): void {
  db.prepare(
    "UPDATE lessons SET superseded_by = ?, superseded_at = ?, updated_time = ? WHERE id = ?",
  ).run(newId, now, now, oldId);
}
