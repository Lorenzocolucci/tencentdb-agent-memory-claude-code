/**
 * pretool-queries.ts — small read-only queries feeding the PreToolUse matcher.
 *
 * WHY a separate file: the recall hot path (kb-queries.ts / sqlite.ts) is being
 * rewritten by another change. The proactive layer reads lessons and bug events
 * through its own narrow queries so the two never collide. Every query here runs
 * from the matcher's BACKGROUND refresh, never on a request path.
 */

import type { DatabaseSync } from "node:sqlite";

const NAMESPACE = "default";

export interface PretoolLessonRow {
  id: string;
  project: string;
  domain: string;
  trigger_pattern: string;
  lesson_text: string;
  evidence_count: number;
  confidence: number;
  stance_willingness: number;
  stance_confirmed_count: number;
  /** JSON array of the bug event ids the lesson was distilled from. */
  evidence_event_ids_json?: string;
}

export interface PretoolEntityRow {
  id: string;
  canonical_key: string;
  project: string;
}

export interface PretoolBugRow {
  id: string;
  project: string;
  text: string;
  entities_json: string;
}

/** What the matcher needs from storage. Injectable so tests need no SQLite. */
export interface PretoolSource {
  /** HEAD (not superseded) lessons. */
  listHeadLessons(): PretoolLessonRow[];
  /** File entities among `ids` (non-file ids are simply absent). */
  listFileEntities(ids: readonly string[]): PretoolEntityRow[];
  /** One page of `bug` events with id > afterId, ascending by id. */
  listBugEvents(afterId: string, limit: number): PretoolBugRow[];
}

/** Max ids per `IN (...)` — well under SQLite's variable limit. */
export const ENTITY_CHUNK = 400;

export function createPretoolSource(db: DatabaseSync): PretoolSource {
  return {
    listHeadLessons(): PretoolLessonRow[] {
      return db
        .prepare(
          `SELECT id, project, domain, trigger_pattern, lesson_text, evidence_count,
                  confidence, stance_willingness, stance_confirmed_count, evidence_event_ids_json
             FROM lessons
            WHERE namespace = ? AND superseded_by IS NULL`,
        )
        .all(NAMESPACE) as unknown as PretoolLessonRow[];
    },

    listFileEntities(ids: readonly string[]): PretoolEntityRow[] {
      if (ids.length === 0) return [];
      const out: PretoolEntityRow[] = [];
      for (let i = 0; i < ids.length; i += ENTITY_CHUNK) {
        const chunk = ids.slice(i, i + ENTITY_CHUNK);
        const marks = chunk.map(() => "?").join(", ");
        const rows = db
          .prepare(
            `SELECT id, canonical_key, project FROM entities
              WHERE type = 'file' AND id IN (${marks})`,
          )
          .all(...chunk) as unknown as PretoolEntityRow[];
        out.push(...rows);
      }
      return out;
    },

    listBugEvents(afterId: string, limit: number): PretoolBugRow[] {
      return db
        .prepare(
          `SELECT id, project, text, entities_json FROM events
            WHERE type = 'bug' AND namespace = ? AND id > ?
            ORDER BY id ASC LIMIT ?`,
        )
        .all(NAMESPACE, afterId, limit) as unknown as PretoolBugRow[];
    },
  };
}

/**
 * The raw SQLite handle of a store, or undefined when it has none (non-SQLite
 * backend, not initialised). The store keeps it in a private field and has no
 * public accessor; this structural read is the single place that knows that.
 */
export function getStoreDb(store: unknown): DatabaseSync | undefined {
  const db = (store as { db?: DatabaseSync } | null | undefined)?.db;
  return db && typeof (db as { prepare?: unknown }).prepare === "function" ? db : undefined;
}
