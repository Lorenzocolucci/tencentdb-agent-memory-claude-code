/**
 * Legacy → compact vec0 migration engine (plan item 6.2). CLI: tools/vec-compact.mts.
 *
 * Flow per table (kb_vec, l0_vec):
 *   1. stats        — rows / chunks / estimated bytes / fill ratio (read-only)
 *   2. buildStaging — create `<t>_new` (compact vec0) + `<t>_new_owner`, copy every
 *                     row in batches of small transactions. Resumable: rows already
 *                     present in staging are skipped, so a re-run continues.
 *   3. verify       — row counts equal (old, new, owner side table) AND a random
 *                     sample of N rows byte-identical (embedding + metadata)
 *   4. swapTable    — ONE transaction: old vec0 (+ its shadow tables) → `<t>_old_<suffix>`,
 *                     staging → `<t>`, owner table → `<t>_owner`.
 *
 * WHY the shadow tables are renamed by hand: in sqlite-vec 0.1.7-alpha.2 an
 * `ALTER TABLE <vec0> RENAME` renames only the virtual table; its shadow tables
 * (`<t>_chunks`, `<t>_rowids`, `<t>_vector_chunks00`, ...) keep the old name and
 * the table becomes unreadable ("no such table: <new>_rowids"). Renaming the
 * shadows too, inside one transaction, yields a consistent table (verified on
 * the ARM64 build; any failure rolls the whole swap back).
 *
 * Nothing here DROPs old data: the legacy table stays as `<t>_old_<suffix>` until
 * cleanupTable() is called explicitly.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  compactVecDdl,
  isLegacyVecSql,
  ownerTableDdl,
  ownerTableName,
  tableExists,
  vecDims,
  vecTableSql,
  type VecTableSpec,
} from "./vec-compact.js";

export type Log = (msg: string) => void;
const noLog: Log = () => {};

function sql(db: DatabaseSync, text: string): void {
  db.prepare(text).run();
}
function scalar(db: DatabaseSync, text: string): number {
  const row = db.prepare(text).get() as Record<string, number> | undefined;
  return row ? Number(Object.values(row)[0]) : 0;
}

/** Names of the vec0 shadow tables that belong to exactly `vecName`. */
export function shadowTables(db: DatabaseSync, vecName: string): string[] {
  const escaped = vecName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}_(info|chunks|rowids|auxiliary|vector_chunks\\d+|metadatachunks\\d+|metadatatext\\d+)$`);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((n) => re.test(n));
}

export type Layout = "absent" | "legacy" | "compact";

export interface TableStats {
  table: string;
  layout: Layout;
  dims: number | null;
  rows: number;
  chunks: number;
  chunkSize: number | null;
  /** rows / (chunks * chunkSize): 1.0 = packed, small = wasted slots. */
  fillRatio: number | null;
  /** chunks * chunkSize * dims * 4 — vector payload allocated by vec0. */
  estVectorBytes: number | null;
  /** Exact bytes from dbstat (vec table + its shadows), only when requested + available. */
  pageBytes: number | null;
}

export function tableStats(db: DatabaseSync, spec: VecTableSpec, opts: { pages?: boolean } = {}): TableStats {
  const ddl = vecTableSql(db, spec.table);
  if (ddl === undefined) {
    return { table: spec.table, layout: "absent", dims: null, rows: 0, chunks: 0, chunkSize: null, fillRatio: null, estVectorBytes: null, pageBytes: null };
  }
  const dims = vecDims(ddl);
  const rows = scalar(db, `SELECT count(*) FROM ${spec.table}`);
  const chunks = scalar(db, `SELECT count(*) FROM ${spec.table}_chunks`);
  const sizeRow = db.prepare(`SELECT size FROM ${spec.table}_chunks LIMIT 1`).get() as { size: number } | undefined;
  const chunkSize = sizeRow ? Number(sizeRow.size) : null;
  let pageBytes: number | null = null;
  if (opts.pages) {
    try {
      const names = [spec.table, ...shadowTables(db, spec.table)].map((n) => `'${n}'`).join(",");
      pageBytes = scalar(db, `SELECT coalesce(sum(pgsize),0) FROM dbstat WHERE name IN (${names})`);
    } catch {
      pageBytes = null; // dbstat not compiled in
    }
  }
  return {
    table: spec.table,
    layout: isLegacyVecSql(ddl) ? "legacy" : "compact",
    dims,
    rows,
    chunks,
    chunkSize,
    fillRatio: chunkSize && chunks ? rows / (chunks * chunkSize) : null,
    estVectorBytes: chunkSize && dims ? chunks * chunkSize * dims * 4 : null,
    pageBytes,
  };
}

function stagingName(spec: VecTableSpec): string {
  return `${spec.table}_new`;
}
export function oldName(spec: VecTableSpec, suffix: string): string {
  return `${spec.table}_old_${suffix}`;
}
export function compactBackupName(spec: VecTableSpec, suffix: string): string {
  return `${spec.table}_compact_${suffix}`;
}

/** Drop the half-built staging tables (the only DROP in this module besides cleanup). */
export function dropStaging(db: DatabaseSync, spec: VecTableSpec): void {
  const name = stagingName(spec);
  if (tableExists(db, name)) sql(db, `DROP TABLE ${name}`);
  sql(db, `DROP TABLE IF EXISTS ${ownerTableName(name)}`);
}

export interface BuildResult {
  copied: number;
  skippedExisting: number;
  oldRows: number;
  newRows: number;
  ownerRows: number;
  chunksAfter: number;
  /** chunk ids of the legacy table (for sampling). */
  chunkIds: string[];
}

/**
 * Copy the legacy table into compact staging tables (resumable, batched).
 * Throws if the source is not a legacy-layout table.
 */
export function buildStaging(db: DatabaseSync, spec: VecTableSpec, opts: { batchSize?: number; log?: Log } = {}): BuildResult {
  const log = opts.log ?? noLog;
  const batchSize = opts.batchSize ?? 1000;
  const src = spec.table;
  const srcSql = vecTableSql(db, src);
  if (!srcSql) throw new Error(`${src}: table not found`);
  if (!isLegacyVecSql(srcSql)) throw new Error(`${src}: already compact — nothing to build`);
  const dims = vecDims(srcSql);
  if (!dims) throw new Error(`${src}: cannot parse dimensions from DDL`);

  const dst = stagingName(spec);
  const dstOwner = ownerTableName(dst);
  sql(db, compactVecDdl(dst, spec, dims, true));
  sql(db, ownerTableDdl(spec, dstOwner));

  const existing = new Set<string>(
    (db.prepare(`SELECT chunk_id FROM ${dst}`).all() as Array<{ chunk_id: string }>).map((r) => r.chunk_id),
  );
  if (existing.size > 0) log(`${src}: resuming — ${existing.size} rows already in staging`);

  const cols = ["chunk_id", ...spec.metaCols, "embedding"];
  const read = db.prepare(`SELECT ${cols.join(", ")} FROM ${src}`);
  const insert = db.prepare(`INSERT INTO ${dst} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  const insertOwner = db.prepare(`INSERT OR REPLACE INTO ${dstOwner} (${spec.ownerCol}, chunk_id) VALUES (?, ?)`);

  const chunkIds: string[] = [];
  let copied = 0;
  let skipped = 0;
  let inBatch = 0;
  sql(db, "BEGIN");
  try {
    for (const row of read.iterate() as IterableIterator<Record<string, unknown>>) {
      const chunkId = row.chunk_id as string;
      chunkIds.push(chunkId);
      if (existing.has(chunkId)) {
        skipped++;
        continue;
      }
      insert.run(...cols.map((c) => row[c] as string | Uint8Array | null));
      insertOwner.run(row[spec.ownerCol] as string, chunkId);
      copied++;
      if (++inBatch >= batchSize) {
        sql(db, "COMMIT");
        sql(db, "BEGIN");
        inBatch = 0;
        if (copied % (batchSize * 10) === 0) log(`${src}: copied ${copied}`);
      }
    }
    sql(db, "COMMIT");
  } catch (err) {
    try { sql(db, "ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }

  return {
    copied,
    skippedExisting: skipped,
    oldRows: scalar(db, `SELECT count(*) FROM ${src}`),
    newRows: scalar(db, `SELECT count(*) FROM ${dst}`),
    ownerRows: scalar(db, `SELECT count(*) FROM ${dstOwner}`),
    chunksAfter: scalar(db, `SELECT count(*) FROM ${dst}_chunks`),
    chunkIds,
  };
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  sampled: number;
}

/** Deterministic-friendly random sample without replacement. */
export function sampleIds(ids: readonly string[], n: number, rng: () => number = Math.random): string[] {
  if (ids.length <= n) return [...ids];
  const pool = [...ids];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/**
 * Compare two vec0 tables of the same logical content: row counts and a sample of
 * rows byte-identical (embedding blob + every metadata column). `ownerTable`, when
 * given, must hold exactly one row per vec row.
 */
export function verifyTables(
  db: DatabaseSync,
  spec: VecTableSpec,
  a: string,
  b: string,
  chunkIds: readonly string[],
  opts: { sampleSize?: number; rng?: () => number; ownerTable?: string } = {},
): VerifyResult {
  const problems: string[] = [];
  const countA = scalar(db, `SELECT count(*) FROM ${a}`);
  const countB = scalar(db, `SELECT count(*) FROM ${b}`);
  if (countA !== countB) problems.push(`row count differs: ${a}=${countA} ${b}=${countB}`);
  if (opts.ownerTable) {
    const owners = scalar(db, `SELECT count(*) FROM ${opts.ownerTable}`);
    if (owners !== countB) problems.push(`owner side table rows ${owners} != vec rows ${countB}`);
    const distinctA = scalar(db, `SELECT count(DISTINCT ${spec.ownerCol}) FROM ${a}`);
    const distinctOwners = scalar(db, `SELECT count(DISTINCT ${spec.ownerCol}) FROM ${opts.ownerTable}`);
    if (distinctA !== distinctOwners) problems.push(`distinct owners differ: ${a}=${distinctA} owner-table=${distinctOwners}`);
  }
  const cols = ["chunk_id", ...spec.metaCols, "embedding"];
  const readA = db.prepare(`SELECT ${cols.join(", ")} FROM ${a} WHERE chunk_id = ?`);
  const readB = db.prepare(`SELECT ${cols.join(", ")} FROM ${b} WHERE chunk_id = ?`);
  const sample = sampleIds(chunkIds, opts.sampleSize ?? 500, opts.rng);
  for (const id of sample) {
    const ra = readA.get(id) as Record<string, unknown> | undefined;
    const rb = readB.get(id) as Record<string, unknown> | undefined;
    if (!ra || !rb) {
      problems.push(`chunk ${id}: missing in ${!ra ? a : b}`);
      continue;
    }
    for (const c of cols) {
      if (c === "embedding") {
        const ba = Buffer.from(ra[c] as Uint8Array);
        const bb = Buffer.from(rb[c] as Uint8Array);
        if (Buffer.compare(ba, bb) !== 0) problems.push(`chunk ${id}: embedding bytes differ`);
      } else if (ra[c] !== rb[c]) {
        problems.push(`chunk ${id}: column ${c} differs`);
      }
    }
    if (problems.length > 20) break;
  }
  return { ok: problems.length === 0, problems, sampled: sample.length };
}

/** Rename a vec0 table together with its shadow tables (see module header). */
function renameVec(db: DatabaseSync, from: string, to: string): void {
  for (const shadow of shadowTables(db, from)) {
    sql(db, `ALTER TABLE ${shadow} RENAME TO ${to}${shadow.slice(from.length)}`);
  }
  sql(db, `ALTER TABLE ${from} RENAME TO ${to}`);
}

function assertAbsent(db: DatabaseSync, names: string[]): void {
  for (const n of names) {
    if (tableExists(db, n)) throw new Error(`refusing to continue: table ${n} already exists`);
  }
}

/** Atomically make the verified staging tables the live `<t>` and park the legacy ones. */
export function swapTable(db: DatabaseSync, spec: VecTableSpec, suffix: string): void {
  const stage = stagingName(spec);
  const old = oldName(spec, suffix);
  const finalOwner = ownerTableName(spec.table);
  if (!tableExists(db, stage) || !tableExists(db, ownerTableName(stage))) throw new Error(`${spec.table}: staging tables missing`);
  assertAbsent(db, [old, ownerTableName(old), ...shadowTables(db, spec.table).map((s) => `${old}${s.slice(spec.table.length)}`)]);
  assertAbsent(db, [finalOwner]);
  sql(db, "BEGIN IMMEDIATE");
  try {
    renameVec(db, spec.table, old);
    renameVec(db, stage, spec.table);
    sql(db, `ALTER TABLE ${ownerTableName(stage)} RENAME TO ${finalOwner}`);
    sql(db, "COMMIT");
  } catch (err) {
    try { sql(db, "ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Put the legacy table back. The compact tables are PARKED as
 * `<t>_compact_<suffix>` (+ `_owner`), not dropped. Vectors written after the
 * migration live only in the parked compact tables.
 */
export function rollbackTable(db: DatabaseSync, spec: VecTableSpec, suffix: string): void {
  const old = oldName(spec, suffix);
  const parked = compactBackupName(spec, suffix);
  if (!tableExists(db, old)) throw new Error(`${spec.table}: ${old} not found — nothing to roll back to`);
  assertAbsent(db, [parked, ownerTableName(parked)]);
  sql(db, "BEGIN IMMEDIATE");
  try {
    renameVec(db, spec.table, parked);
    if (tableExists(db, ownerTableName(spec.table))) {
      sql(db, `ALTER TABLE ${ownerTableName(spec.table)} RENAME TO ${ownerTableName(parked)}`);
    }
    renameVec(db, old, spec.table);
    sql(db, "COMMIT");
  } catch (err) {
    try { sql(db, "ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
}

/** DROP the parked legacy table (frees its pages for VACUUM). Never called by migrate. */
export function cleanupTable(db: DatabaseSync, spec: VecTableSpec, suffix: string): boolean {
  const old = oldName(spec, suffix);
  if (!tableExists(db, old)) return false;
  sql(db, `DROP TABLE ${old}`);
  return true;
}

/**
 * Compare KNN top-k ids of two vec0 tables for each query vector. A mismatch
 * counts as a TIE (benign) when the two result lists have identical distances.
 */
export function knnEquivalence(
  db: DatabaseSync,
  a: string,
  b: string,
  queries: readonly Float32Array[],
  k = 10,
): { queries: number; identical: number; tieOnly: number; different: number; msA: number; msB: number } {
  const q = (t: string) =>
    db.prepare(`SELECT chunk_id, distance FROM ${t} WHERE embedding MATCH ? AND k = ? ORDER BY distance`);
  const sa = q(a);
  const sb = q(b);
  let identical = 0;
  let tieOnly = 0;
  let different = 0;
  let msA = 0;
  let msB = 0;
  for (const v of queries) {
    const blob = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    let t = performance.now();
    const ra = sa.all(blob, k) as Array<{ chunk_id: string; distance: number }>;
    msA += performance.now() - t;
    t = performance.now();
    const rb = sb.all(blob, k) as Array<{ chunk_id: string; distance: number }>;
    msB += performance.now() - t;
    const sameIds = ra.length === rb.length && ra.every((r, i) => r.chunk_id === rb[i].chunk_id);
    if (sameIds) identical++;
    else if (ra.length === rb.length && ra.every((r, i) => r.distance === rb[i].distance)) tieOnly++;
    else different++;
  }
  return { queries: queries.length, identical, tieOnly, different, msA, msB };
}
