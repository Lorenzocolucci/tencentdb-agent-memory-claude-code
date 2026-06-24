/**
 * context_fingerprints writer (Context Fingerprint / Idea 1).
 *
 * Persists a situation signature {files + error signatures + task type +
 * tool sequence} together with the owner ids of the memories that were surfaced
 * in that situation — that last link is the LEARNING (this shape ↔ these
 * memories). queryRecentFingerprints reads them back newest-first, bounded and
 * namespace-scoped, for cross-session matching.
 *
 * Same access style as the other KB writers: a node:sqlite DatabaseSync handle,
 * `db.prepare(sql).run()` (never `db.exec` — node:sqlite security-hook false
 * positive). JSON columns are parsed defensively so a malformed row degrades to
 * empty arrays rather than throwing on the read path.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface FingerprintInsert {
  sessionKey: string;
  /** ISO timestamp (caller-supplied, like the other writers). */
  now: string;
  fileKeys: readonly string[];
  errorSignatures: readonly string[];
  taskType: string;
  toolNames: readonly string[];
  matchedOwnerIds: readonly string[];
  namespace?: string;
}

export interface StoredFingerprint {
  id: string;
  session_key: string;
  ts: string;
  fileKeys: string[];
  errorSignatures: string[];
  taskType: string;
  toolNames: string[];
  matchedOwnerIds: string[];
  namespace: string;
}

interface RawRow {
  id: string;
  session_key: string;
  ts: string;
  files_json: string;
  error_signatures_json: string;
  task_type: string;
  tool_sequence_json: string;
  matched_owner_ids_json: string;
  namespace: string;
}

/** Parse a JSON string array defensively → [] on any malformed input. */
function parseStrArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Persist one fingerprint row; returns the generated id. */
export function insertFingerprint(db: DatabaseSync, p: FingerprintInsert): string {
  const id = `fp_${randomUUID()}`;
  db.prepare(
    `INSERT INTO context_fingerprints
       (id, session_key, ts, files_json, error_signatures_json, task_type,
        tool_sequence_json, matched_owner_ids_json, namespace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    p.sessionKey,
    p.now,
    JSON.stringify([...p.fileKeys]),
    JSON.stringify([...p.errorSignatures]),
    p.taskType,
    JSON.stringify([...p.toolNames]),
    JSON.stringify([...p.matchedOwnerIds]),
    p.namespace ?? "default",
  );
  return id;
}

/** Read recent fingerprints for a namespace, newest-first, bounded. */
export function queryRecentFingerprints(
  db: DatabaseSync,
  namespace: string,
  limit: number,
): StoredFingerprint[] {
  const rows = db
    .prepare(
      `SELECT id, session_key, ts, files_json, error_signatures_json, task_type,
              tool_sequence_json, matched_owner_ids_json, namespace
         FROM context_fingerprints
        WHERE namespace = ?
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .all(namespace, limit) as RawRow[];

  return rows.map((r) => ({
    id: r.id,
    session_key: r.session_key,
    ts: r.ts,
    fileKeys: parseStrArray(r.files_json),
    errorSignatures: parseStrArray(r.error_signatures_json),
    taskType: r.task_type,
    toolNames: parseStrArray(r.tool_sequence_json),
    matchedOwnerIds: parseStrArray(r.matched_owner_ids_json),
    namespace: r.namespace,
  }));
}
