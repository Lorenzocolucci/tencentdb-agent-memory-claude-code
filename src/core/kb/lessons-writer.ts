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
import { confidenceAfterAvoidance, confidenceAfterRecurrence } from "./lesson-reinforcement.js";
import { willingnessAfterConfirm, willingnessAfterReject } from "./stance-track-record.js";

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
  // B3 reinforcement (additive columns; default 0/null on legacy rows).
  exposure_count: number;
  avoidance_count: number;
  last_exposed_session_id: string | null;
  last_exposed_at: string | null;
  // Pilastro B stance track record (additive; default 0/WILLINGNESS_DEFAULT on legacy rows).
  stance_fire_count: number;
  stance_confirmed_count: number;
  stance_rejected_count: number;
  stance_willingness: number;
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

// ── B3 reinforcement primitives ──────────────────────────────────────────────

/**
 * Record that a lesson RESURFACED into a matching situation (it was injected). This
 * is the "the situation came back" signal both crediting paths hang on. Stamps the
 * session so session-end can scope the implicit "exposed-and-not-relapsed" inference.
 */
export function recordExposure(
  db: DatabaseSync,
  lessonId: string,
  sessionId: string,
  now: string,
): void {
  db.prepare(
    `UPDATE lessons
        SET exposure_count = exposure_count + 1,
            last_exposed_session_id = ?, last_exposed_at = ?, updated_time = ?
      WHERE id = ?`,
  ).run(sessionId, now, now, lessonId);
}

/**
 * Credit a successful AVOIDANCE: bump avoidance_count (drives the explicit→implicit
 * phase switch) and raise confidence with diminishing returns. Returns the updated row.
 */
export function creditAvoidance(db: DatabaseSync, lessonId: string, now: string): LessonRow | null {
  const cur = getLessonById(db, lessonId);
  if (!cur) return null;
  const confidence = confidenceAfterAvoidance(cur.confidence);
  db.prepare(
    `UPDATE lessons SET avoidance_count = avoidance_count + 1, confidence = ?, updated_time = ?
      WHERE id = ?`,
  ).run(confidence, now, lessonId);
  return getLessonById(db, lessonId);
}

/**
 * Temper confidence after a RELAPSE (the failure recurred despite the lesson): the
 * lesson did not fully protect. Floored so one relapse never discredits it entirely.
 */
export function temperOnRecurrence(db: DatabaseSync, lessonId: string, now: string): LessonRow | null {
  const cur = getLessonById(db, lessonId);
  if (!cur) return null;
  const confidence = confidenceAfterRecurrence(cur.confidence);
  db.prepare("UPDATE lessons SET confidence = ?, updated_time = ? WHERE id = ?").run(
    confidence, now, lessonId,
  );
  return getLessonById(db, lessonId);
}

// ── Pilastro B stance track-record primitives ────────────────────────────────

/**
 * Record that a stance FIRED a hard interrupt (it spoke). Bumps stance_fire_count.
 * This is the denominator the confirm/reject signal hangs on — "of the times this
 * stance interrupted, how often was it right?". Willingness itself moves only on
 * confirm/reject, not on the bare fire.
 */
export function recordStanceFire(db: DatabaseSync, lessonId: string, now: string): LessonRow | null {
  const cur = getLessonById(db, lessonId);
  if (!cur) return null;
  db.prepare(
    `UPDATE lessons SET stance_fire_count = stance_fire_count + 1, updated_time = ? WHERE id = ?`,
  ).run(now, lessonId);
  return getLessonById(db, lessonId);
}

/**
 * Credit a CONFIRMED stance fire (Lorenzo said the interrupt mattered): bump
 * stance_confirmed_count and raise willingness with diminishing returns
 * (willingnessAfterConfirm). Returns the updated row.
 */
export function creditStanceConfirmed(db: DatabaseSync, lessonId: string, now: string): LessonRow | null {
  const cur = getLessonById(db, lessonId);
  if (!cur) return null;
  const willingness = willingnessAfterConfirm(cur.stance_willingness);
  db.prepare(
    `UPDATE lessons
        SET stance_confirmed_count = stance_confirmed_count + 1,
            stance_willingness = ?, updated_time = ?
      WHERE id = ?`,
  ).run(willingness, now, lessonId);
  return getLessonById(db, lessonId);
}

/**
 * Credit a REJECTED stance fire (Lorenzo said it was a false alarm): bump
 * stance_rejected_count and shed willingness (willingnessAfterReject — stronger
 * than the confirm gain, so crying wolf silences fast). Floored, never erased.
 * Returns the updated row.
 */
export function creditStanceRejected(db: DatabaseSync, lessonId: string, now: string): LessonRow | null {
  const cur = getLessonById(db, lessonId);
  if (!cur) return null;
  const willingness = willingnessAfterReject(cur.stance_willingness);
  db.prepare(
    `UPDATE lessons
        SET stance_rejected_count = stance_rejected_count + 1,
            stance_willingness = ?, updated_time = ?
      WHERE id = ?`,
  ).run(willingness, now, lessonId);
  return getLessonById(db, lessonId);
}

/** HEAD lessons that were last exposed in the given session (for session-end crediting). */
export function queryLessonsExposedInSession(
  db: DatabaseSync,
  sessionId: string,
  namespace = "default",
): LessonRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM lessons
        WHERE namespace = ? AND superseded_by IS NULL AND last_exposed_session_id = ?`,
    )
    .all(namespace, sessionId);
  return rows as LessonRow[];
}
