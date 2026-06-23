/**
 * memory_audit writer — the append-only trail of every automatic mutation.
 *
 * This is what makes Sinapsys's self-evolution SAFE (sellable angle #1): A-MEM
 * rewrites memories with no audit trail; here every consolidation/promotion/
 * decay/supersession leaves a reversible, inspectable record.
 *
 * APPEND-ONLY: this module only INSERTs. Nothing ever updates or deletes audit
 * rows.
 */

import type { DatabaseSync } from "node:sqlite";
import { ulidLike } from "./kb-queries.js";

/** One automatic mutation to record. `before`/`after` are JSON-serialized. */
export interface AuditEntry {
  ownerId: string;
  ownerKind: string;
  /** reinforce | promote | demote | decay | supersede | evolve | merge | lesson_distilled */
  operation: string;
  /** consolidation | extraction | user */
  actor: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  namespace?: string;
}

/** Append one audit row. Returns the generated audit id. Never throws on shape. */
export function recordAudit(db: DatabaseSync, entry: AuditEntry, now: string): string {
  const id = ulidLike("aud", Date.parse(now) || 0);
  db.prepare(
    `INSERT INTO memory_audit
       (id, ts, owner_id, owner_kind, operation, actor, before_json, after_json, reason, namespace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    now,
    entry.ownerId,
    entry.ownerKind,
    entry.operation,
    entry.actor,
    entry.before !== undefined ? JSON.stringify(entry.before) : null,
    entry.after !== undefined ? JSON.stringify(entry.after) : null,
    entry.reason ?? null,
    entry.namespace ?? "default",
  );
  return id;
}
