/**
 * Compact vec0 layout for `kb_vec` and `l0_vec` (plan item 6.2).
 *
 * WHY: both tables used `<owner> TEXT partition key`. sqlite-vec gives every
 * distinct partition value its OWN chunk, so one-vector-per-owner data turned
 * into one chunk per vector (kb_vec: 72,507 vectors in 72,507 chunks, ~2.3 GB
 * for ~0.3 GB of floats). That made single-row writes, brute-force KNN, the
 * boot-time full read and the cold first recall take seconds to minutes.
 *
 * COMPACT LAYOUT: no partition key; the owner id is a plain metadata column
 * (so `SELECT owner_id ... FROM kb_vec` and KNN output are unchanged) and
 * delete-by-owner goes through a normal side table
 * `<table>_owner(<owner>, chunk_id) WITHOUT ROWID` whose PK serves the lookup.
 * Delete = look up chunk ids, delete each by primary key, drop the side rows.
 *
 * SCHEMA VERSION: there is no flag to drift out of sync with the data — the
 * layout is read from the vec0 DDL itself (`partition key` present = legacy).
 * A non-migrated DB therefore keeps the legacy write path until
 * `tools/vec-compact.mts` swaps the tables; fresh DBs get the compact layout.
 *
 * Pure helpers over a DatabaseSync that already has sqlite-vec loaded.
 */

import type { DatabaseSync } from "node:sqlite";

/** Vectors per vec0 chunk in the compact layout (1 MB/chunk at 1024-d float). */
export const COMPACT_CHUNK_SIZE = 256;

export interface VecTableSpec {
  /** vec0 table name (also the final name after migration). */
  readonly table: "kb_vec" | "l0_vec";
  /** Owner column: kb_vec.owner_id / l0_vec.record_id. */
  readonly ownerCol: "owner_id" | "record_id";
  /** Non-vector, non-key columns in vec0 declaration order. */
  readonly metaCols: readonly string[];
  /** Per-column DDL for the compact vec0 (after chunk_id). */
  readonly ddlCols: (dims: number) => string;
}

export const KB_VEC_SPEC: VecTableSpec = {
  table: "kb_vec",
  ownerCol: "owner_id",
  metaCols: ["owner_id", "owner_kind", "updated_time"],
  ddlCols: (dims) =>
    `owner_id TEXT, owner_kind TEXT, embedding float[${dims}] distance_metric=cosine, updated_time TEXT DEFAULT ''`,
};

export const L0_VEC_SPEC: VecTableSpec = {
  table: "l0_vec",
  ownerCol: "record_id",
  metaCols: ["record_id", "recorded_at"],
  ddlCols: (dims) =>
    `record_id TEXT, embedding float[${dims}] distance_metric=cosine, recorded_at TEXT DEFAULT ''`,
};

export const VEC_SPECS: readonly VecTableSpec[] = [KB_VEC_SPEC, L0_VEC_SPEC];

export type VecParam = string | number | bigint | Uint8Array | null;
/** Minimal statement surface used by VectorStore for owner-keyed vec writes. */
export interface VecWriteStmt {
  run(...params: VecParam[]): unknown;
}

/** Name of the owner side table for a vec table (or a staging name). */
export function ownerTableName(vecTable: string): string {
  return `${vecTable}_owner`;
}

/** DDL text of a vec0 table from sqlite_master (undefined if absent). */
export function vecTableSql(db: DatabaseSync, name: string): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { sql: string | null } | undefined;
  return row?.sql ?? undefined;
}

export function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  );
}

/** Embedding dimension parsed from the vec0 DDL (`float[N]`), or null. */
export function vecDims(sql: string | undefined): number | null {
  const m = sql?.match(/float\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}

/** True when the vec0 DDL is the legacy partition-key layout. */
export function isLegacyVecSql(sql: string | undefined): boolean {
  return !!sql && /partition\s+key/i.test(sql);
}

export function compactVecDdl(name: string, spec: VecTableSpec, dims: number, ifNotExists = true): string {
  return (
    `CREATE VIRTUAL TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${name} USING vec0(` +
    `chunk_id TEXT PRIMARY KEY, ${spec.ddlCols(dims)}, chunk_size=${COMPACT_CHUNK_SIZE})`
  );
}

export function ownerTableDdl(spec: VecTableSpec, name = ownerTableName(spec.table)): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${name} (` +
    `${spec.ownerCol} TEXT NOT NULL, chunk_id TEXT NOT NULL, ` +
    `PRIMARY KEY (${spec.ownerCol}, chunk_id)) WITHOUT ROWID`
  );
}

/**
 * Ensure the vec table exists and report which layout it has.
 *  - absent            → create the COMPACT layout (+ owner table), return true
 *  - compact           → make sure the owner table exists (rebuild it from the
 *                        vec table if it is missing), return true
 *  - legacy (partition) → leave untouched, return false
 */
export function ensureVecTable(db: DatabaseSync, spec: VecTableSpec, dims: number): boolean {
  const sql = vecTableSql(db, spec.table);
  if (sql === undefined) {
    db.prepare(compactVecDdl(spec.table, spec, dims, false)).run();
    db.prepare(ownerTableDdl(spec)).run();
    return true;
  }
  if (isLegacyVecSql(sql)) return false;
  const ownerTable = ownerTableName(spec.table);
  if (!tableExists(db, ownerTable)) {
    db.prepare(ownerTableDdl(spec)).run();
    db.prepare(
      `INSERT OR IGNORE INTO ${ownerTable} (${spec.ownerCol}, chunk_id) SELECT ${spec.ownerCol}, chunk_id FROM ${spec.table}`,
    ).run();
  }
  return true;
}

/** Delete every chunk row of one owner. Layout-aware; `compact` from ensureVecTable. */
export function makeOwnerDelete(db: DatabaseSync, spec: VecTableSpec, compact: boolean): VecWriteStmt {
  if (!compact) {
    return db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.ownerCol} = ?`) as VecWriteStmt;
  }
  const ownerTable = ownerTableName(spec.table);
  const selectChunks = db.prepare(`SELECT chunk_id FROM ${ownerTable} WHERE ${spec.ownerCol} = ?`);
  const deleteChunk = db.prepare(`DELETE FROM ${spec.table} WHERE chunk_id = ?`);
  const deleteOwnerRows = db.prepare(`DELETE FROM ${ownerTable} WHERE ${spec.ownerCol} = ?`);
  return {
    run(ownerId: VecParam) {
      const rows = selectChunks.all(ownerId) as Array<{ chunk_id: string }>;
      for (const r of rows) deleteChunk.run(r.chunk_id);
      deleteOwnerRows.run(ownerId);
    },
  };
}

/**
 * Insert one chunk row. `insertSql` is the table's usual INSERT; the owner id
 * is the parameter at `ownerParamIndex` (1 for both tables). In the compact
 * layout the side-table row is written alongside.
 */
export function makeVecInsert(
  db: DatabaseSync,
  spec: VecTableSpec,
  compact: boolean,
  insertSql: string,
  ownerParamIndex = 1,
): VecWriteStmt {
  const insert = db.prepare(insertSql);
  if (!compact) return insert as VecWriteStmt;
  const insertOwner = db.prepare(
    `INSERT OR REPLACE INTO ${ownerTableName(spec.table)} (${spec.ownerCol}, chunk_id) VALUES (?, ?)`,
  );
  return {
    run(...params: VecParam[]) {
      insert.run(...params);
      insertOwner.run(params[ownerParamIndex], params[0]);
    },
  };
}

/**
 * Keep the owner side table in step after a bulk metadata-range delete
 * (TTL cleanup deletes vec rows by `recorded_at`, not by owner). Removes the
 * side rows of the owners selected by `expiredOwnersSql` (a subquery that
 * returns owner ids). Call it BEFORE the metadata rows it selects from are
 * deleted. Orphan side rows would be harmless (delete-by-owner is a no-op
 * for a missing chunk) but are not left behind.
 */
export function pruneOwnerRows(db: DatabaseSync, spec: VecTableSpec, expiredOwnersSql: string, ...params: VecParam[]): void {
  db.prepare(
    `DELETE FROM ${ownerTableName(spec.table)} WHERE ${spec.ownerCol} IN (${expiredOwnersSql})`,
  ).run(...params);
}
