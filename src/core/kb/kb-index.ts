/**
 * KB hot-path indexes (Sinapsys fix plan, Phase 2.1 + 2.2).
 *
 * Recall used to answer two questions with full scans on every turn:
 *   1. "which entities match these words?"  -> `SELECT * FROM entities` + JS substring match
 *   2. "which events mention this entity?"  -> `events.entities_json LIKE '%id%'`
 * Both are O(data) on a single synchronous SQLite connection, so they starve the
 * event loop. This module owns the two index structures that replace them:
 *
 *   - `entities_fts`  FTS5 over (name, canonical_key, aliases) — whole-word match.
 *   - `event_entities` join table + covering index.
 *
 * KEPT IN SYNC BY TRIGGERS (not by call sites): entities are written by the store,
 * by Cura #2 merges and by the standalone reconcile CLI; events are inserted by
 * `insertEvent` and RE-KEYED by `mergeEntities` (entities_json UPDATE). A trigger
 * covers every writer, including a process that runs older code.
 *
 * READINESS GATE: the triggers are created at store init (cheap, additive), but a
 * pre-existing database has rows the triggers never saw. The reader therefore
 * only trusts an index once its `*_ready` flag is set in `kb_index_state`, which
 * happens only when the one-time backfill ({@link runKbIndexBackfill}) finishes.
 * Until then callers fall back to the old scan path. The backfill is opt-in
 * (env {@link KB_INDEX_BACKFILL_ENV}), batched, yields to the event loop between
 * batches and is resumable (cursor persisted in `kb_index_state`).
 *
 * NOTE: DDL goes through prepare().run() on purpose (project convention for
 * node:sqlite, see initKbSchema).
 */

import type { DatabaseSync } from "node:sqlite";

export const KB_INDEX_BACKFILL_ENV = "TDAI_KB_INDEX_BACKFILL";

export type KbIndexName = "entities_fts" | "event_entities";

/** Max rows a single token may contribute to the entity match (bounds the work). */
const ENTITY_TOKEN_ROW_CAP = 1000;
/** Max ids per IN (...) list (SQLite variable limit safety). */
const IN_CHUNK = 400;

interface Logger {
  info?: (m: string) => void;
  warn?: (m: string) => void;
  debug?: (m: string) => void;
}

/** True when the operator opted in to the one-time index backfill. Default OFF. */
export function isKbIndexBackfillEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[KB_INDEX_BACKFILL_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

// ============================================================================
// Schema (idempotent)
// ============================================================================

const INSERT_EVENT_ENTITIES_FROM_NEW =
  `INSERT OR IGNORE INTO event_entities(event_id, entity_id, namespace, ts)
     SELECT new.id, j.value, new.namespace, new.ts
       FROM json_each(CASE WHEN json_valid(new.entities_json) THEN new.entities_json ELSE '[]' END) AS j
      WHERE j.type = 'text'`;

const INSERT_ENTITY_FTS_FROM_NEW =
  `INSERT INTO entities_fts(rowid, name, canonical_key, aliases, entity_id, namespace)
     SELECT new.rowid, new.name, new.canonical_key, new.aliases_json, new.id, new.namespace
      WHERE new.merged_into IS NULL`;

/**
 * Create the index tables + sync triggers. Idempotent, additive, safe on every
 * store init. Requires the `entities`/`events` tables (and `entities.merged_into`)
 * to exist. Does NOT backfill and does NOT flip readiness.
 */
export function ensureKbIndexSchema(db: DatabaseSync): void {
  const ddl = (sql: string): void => {
    db.prepare(sql).run();
  };
  ddl("CREATE TABLE IF NOT EXISTS kb_index_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)");

  ddl(
    `CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
       name, canonical_key, aliases,
       entity_id UNINDEXED, namespace UNINDEXED
     )`,
  );
  ddl(
    `CREATE TRIGGER IF NOT EXISTS trg_kb_entities_fts_ai AFTER INSERT ON entities BEGIN
       ${INSERT_ENTITY_FTS_FROM_NEW};
     END`,
  );
  ddl(
    `CREATE TRIGGER IF NOT EXISTS trg_kb_entities_fts_au
       AFTER UPDATE OF name, canonical_key, aliases_json, merged_into, namespace ON entities BEGIN
       DELETE FROM entities_fts WHERE rowid = old.rowid;
       ${INSERT_ENTITY_FTS_FROM_NEW};
     END`,
  );
  ddl(
    `CREATE TRIGGER IF NOT EXISTS trg_kb_entities_fts_ad AFTER DELETE ON entities BEGIN
       DELETE FROM entities_fts WHERE rowid = old.rowid;
     END`,
  );

  ddl(
    `CREATE TABLE IF NOT EXISTS event_entities (
       event_id TEXT NOT NULL,
       entity_id TEXT NOT NULL,
       namespace TEXT NOT NULL,
       ts TEXT NOT NULL,
       PRIMARY KEY (event_id, entity_id)
     ) WITHOUT ROWID`,
  );
  // namespace + ts are denormalized from `events` (immutable columns of an append-only
  // table) so both readers are answered from this covering index alone: measured on the
  // 4.6 GB copy, the JOIN to events cost 135-190 ms per recall vs 3-6 ms index-only.
  ddl("CREATE INDEX IF NOT EXISTS idx_event_entities_entity ON event_entities(entity_id, namespace, ts, event_id)");
  ddl(
    `CREATE TRIGGER IF NOT EXISTS trg_kb_event_entities_ai AFTER INSERT ON events BEGIN
       ${INSERT_EVENT_ENTITIES_FROM_NEW};
     END`,
  );
  ddl(
    `CREATE TRIGGER IF NOT EXISTS trg_kb_event_entities_au AFTER UPDATE OF entities_json ON events BEGIN
       DELETE FROM event_entities WHERE event_id = old.id;
       ${INSERT_EVENT_ENTITIES_FROM_NEW};
     END`,
  );
  ddl(
    `CREATE TRIGGER IF NOT EXISTS trg_kb_event_entities_ad AFTER DELETE ON events BEGIN
       DELETE FROM event_entities WHERE event_id = old.id;
     END`,
  );

  markEmptySourcesReady(db);
}

/**
 * A database whose source table is EMPTY when the triggers appear has nothing to
 * backfill: the triggers see every row from now on, so that index is complete by
 * construction. (A fresh install / test DB gets the fast path immediately; a
 * database that already holds rows must go through the opt-in backfill.)
 */
function markEmptySourcesReady(db: DatabaseSync): void {
  const pairs: Array<[KbIndexName, string]> = [
    ["entities_fts", "entities"],
    ["event_entities", "events"],
  ];
  for (const [name, source] of pairs) {
    if (readState(db, stateKey(name, "ready")) === "1") continue;
    const any = db.prepare(`SELECT 1 AS x FROM ${source} LIMIT 1`).get();
    if (!any) writeState(db, stateKey(name, "ready"), "1");
  }
}

// ============================================================================
// Readiness + backfill state
// ============================================================================

const readyCache = new WeakMap<DatabaseSync, Set<KbIndexName>>();

function stateKey(name: KbIndexName, what: "ready" | "cursor"): string {
  return `${name}_${what}`;
}

function readState(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kb_index_state WHERE name = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function writeState(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO kb_index_state(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Is this index complete (backfill finished)? Cheap (one PK lookup); a positive
 * answer is cached per connection. Any error (state table missing, DB closed)
 * reads as "not ready" so callers use the safe old path.
 */
export function isKbIndexReady(db: DatabaseSync, name: KbIndexName): boolean {
  const cached = readyCache.get(db);
  if (cached?.has(name)) return true;
  try {
    if (readState(db, stateKey(name, "ready")) !== "1") return false;
  } catch {
    return false;
  }
  const set = cached ?? new Set<KbIndexName>();
  set.add(name);
  readyCache.set(db, set);
  return true;
}

/** Forget cached readiness (tests / after a manual reset of kb_index_state). */
export function resetKbIndexReadyCache(db: DatabaseSync): void {
  readyCache.delete(db);
}

// ============================================================================
// Backfill (batched, yielding, resumable)
// ============================================================================

export interface KbIndexBackfillOptions {
  /** Max wall-clock ms of synchronous work per batch before yielding. Default 40. */
  batchMs?: number;
  /** Max rows read per SELECT. Default 200. */
  chunkRows?: number;
  /** Return true to abort (store closed). */
  isClosed?: () => boolean;
  /** Yield to the event loop. Default: setImmediate. */
  yieldFn?: () => Promise<void>;
  logger?: Logger;
}

export interface KbIndexBackfillResult {
  entitiesIndexed: number;
  eventsIndexed: number;
  /** Both indexes are now marked ready. */
  done: boolean;
  /** Number of batches executed (each followed by a yield). */
  batches: number;
  /** Longest synchronous batch (work + COMMIT), ms. */
  maxBatchMs: number;
  /** Longest synchronous work part of a batch (excluding COMMIT), ms. */
  maxWorkMs: number;
  /** Longest COMMIT, ms (disk-bound, not controlled by batchMs). */
  maxCommitMs: number;
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface BatchOutcome {
  processed: number;
  finished: boolean;
}

function parseEntityIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string");
  } catch {
    return [];
  }
}

/** One bounded batch of the entity FTS backfill. Caller wraps it in a transaction. */
function entitiesBatch(db: DatabaseSync, chunkRows: number, deadline: number): BatchOutcome {
  const cursor = Number(readState(db, stateKey("entities_fts", "cursor")) ?? "0");
  const rows = db
    .prepare(
      `SELECT rowid AS rid, id, name, canonical_key, aliases_json, namespace, merged_into
         FROM entities WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    )
    .all(cursor, chunkRows) as Array<{
    rid: number;
    id: string;
    name: string;
    canonical_key: string;
    aliases_json: string;
    namespace: string;
    merged_into: string | null;
  }>;
  if (rows.length === 0) return { processed: 0, finished: true };
  const del = db.prepare("DELETE FROM entities_fts WHERE rowid = ?");
  const ins = db.prepare(
    "INSERT INTO entities_fts(rowid, name, canonical_key, aliases, entity_id, namespace) VALUES(?, ?, ?, ?, ?, ?)",
  );
  let last = cursor;
  let processed = 0;
  for (const r of rows) {
    del.run(r.rid);
    if (r.merged_into == null) ins.run(r.rid, r.name, r.canonical_key, r.aliases_json, r.id, r.namespace);
    last = r.rid;
    processed++;
    if (performance.now() > deadline) break;
  }
  writeState(db, stateKey("entities_fts", "cursor"), String(last));
  return { processed, finished: false };
}

/** One bounded batch of the event_entities backfill. Caller wraps it in a transaction. */
function eventsBatch(db: DatabaseSync, chunkRows: number, deadline: number): BatchOutcome {
  const cursor = Number(readState(db, stateKey("event_entities", "cursor")) ?? "0");
  const rows = db
    .prepare(
      "SELECT rowid AS rid, id, entities_json, namespace, ts FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?",
    )
    .all(cursor, chunkRows) as Array<{ rid: number; id: string; entities_json: string; namespace: string; ts: string }>;
  if (rows.length === 0) return { processed: 0, finished: true };
  const ins = db.prepare(
    "INSERT OR IGNORE INTO event_entities(event_id, entity_id, namespace, ts) VALUES(?, ?, ?, ?)",
  );
  let last = cursor;
  let processed = 0;
  for (const r of rows) {
    for (const entityId of parseEntityIds(r.entities_json)) ins.run(r.id, entityId, r.namespace, r.ts);
    last = r.rid;
    processed++;
    if (performance.now() > deadline) break;
  }
  writeState(db, stateKey("event_entities", "cursor"), String(last));
  return { processed, finished: false };
}

/**
 * Backfill one index to completion: bounded batches, each in its own transaction,
 * `await yield` between batches. Resumable: the cursor is committed with each
 * batch, so a restart continues where it stopped. Marks the index ready only
 * when a SELECT past the cursor returns nothing.
 */
async function backfillOne(
  db: DatabaseSync,
  name: KbIndexName,
  batch: (db: DatabaseSync, chunkRows: number, deadline: number) => BatchOutcome,
  opts: Required<Pick<KbIndexBackfillOptions, "batchMs" | "chunkRows" | "isClosed" | "yieldFn">>,
  acc: KbIndexBackfillResult,
): Promise<number> {
  if (readState(db, stateKey(name, "ready")) === "1") return 0;
  let total = 0;
  let beginFailures = 0;
  for (;;) {
    if (opts.isClosed()) return total;
    const t0 = performance.now();
    let outcome: BatchOutcome;
    let workEnd = t0;
    try {
      db.prepare("BEGIN IMMEDIATE").run();
    } catch {
      // Someone else holds a transaction on this connection or the file: retry after a yield.
      if (++beginFailures > 100) throw new Error(`kb-index backfill (${name}): cannot begin a transaction`);
      await opts.yieldFn();
      continue;
    }
    beginFailures = 0;
    try {
      outcome = batch(db, opts.chunkRows, t0 + opts.batchMs);
      if (outcome.finished) writeState(db, stateKey(name, "ready"), "1");
      workEnd = performance.now();
      db.prepare("COMMIT").run();
    } catch (err) {
      try {
        db.prepare("ROLLBACK").run();
      } catch {
        /* keep the original error */
      }
      throw err;
    }
    const end = performance.now();
    const took = end - t0;
    acc.batches++;
    if (took > acc.maxBatchMs) acc.maxBatchMs = took;
    if (workEnd - t0 > acc.maxWorkMs) acc.maxWorkMs = workEnd - t0;
    if (end - workEnd > acc.maxCommitMs) acc.maxCommitMs = end - workEnd;
    total += outcome.processed;
    if (outcome.finished) return total;
    await opts.yieldFn();
  }
}

/**
 * Run the one-time backfill of both indexes. Safe to call repeatedly (a finished
 * index is skipped, an unfinished one resumes). Throws on a hard SQL error —
 * callers log it; the readiness flag stays unset so the old path keeps serving.
 */
export async function runKbIndexBackfill(
  db: DatabaseSync,
  options: KbIndexBackfillOptions = {},
): Promise<KbIndexBackfillResult> {
  const opts = {
    batchMs: options.batchMs ?? 40,
    chunkRows: options.chunkRows ?? 200,
    isClosed: options.isClosed ?? ((): boolean => false),
    yieldFn: options.yieldFn ?? defaultYield,
  };
  const acc: KbIndexBackfillResult = {
    entitiesIndexed: 0,
    eventsIndexed: 0,
    done: false,
    batches: 0,
    maxBatchMs: 0,
    maxWorkMs: 0,
    maxCommitMs: 0,
  };
  acc.entitiesIndexed = await backfillOne(db, "entities_fts", entitiesBatch, opts, acc);
  acc.eventsIndexed = await backfillOne(db, "event_entities", eventsBatch, opts, acc);
  acc.done =
    readState(db, stateKey("entities_fts", "ready")) === "1" &&
    readState(db, stateKey("event_entities", "ready")) === "1";
  resetKbIndexReadyCache(db);
  options.logger?.info?.(
    `[memory-tdai][kb-index] backfill ${acc.done ? "complete" : "incomplete"}: ` +
      `entities=${acc.entitiesIndexed} events=${acc.eventsIndexed} batches=${acc.batches} ` +
      `maxBatch=${acc.maxBatchMs.toFixed(0)}ms (work ${acc.maxWorkMs.toFixed(0)}ms, commit ${acc.maxCommitMs.toFixed(0)}ms)`,
  );
  return acc;
}

// ============================================================================
// Readers (return null = "index unavailable, use the old path")
// ============================================================================

function ftsPhrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Whole-word entity match via `entities_fts`. For each (already normalized)
 * token, collect entities containing it as a whole word in name / canonical_key
 * / aliases; rank by number of distinct tokens matched (ties: lowest rowid
 * first, i.e. oldest entity). Returns ids only; null when the index is not ready.
 */
export function ftsEntityMatches(
  db: DatabaseSync,
  normTokens: string[],
  namespace: string,
  limit: number,
): string[] | null {
  if (!isKbIndexReady(db, "entities_fts")) return null;
  try {
    const stmt = db.prepare(
      "SELECT entity_id FROM entities_fts WHERE entities_fts MATCH ? AND namespace = ? LIMIT ?",
    );
    const matches = new Map<string, number>();
    for (const token of normTokens) {
      let rows: Array<{ entity_id: string }>;
      try {
        rows = stmt.all(ftsPhrase(token), namespace, ENTITY_TOKEN_ROW_CAP) as Array<{ entity_id: string }>;
      } catch {
        continue; // a token FTS5 cannot parse (e.g. only punctuation) matches nothing
      }
      for (const r of rows) matches.set(r.entity_id, (matches.get(r.entity_id) ?? 0) + 1);
    }
    return [...matches.entries()]
      .sort((a, b) => b[1] - a[1]) // stable: insertion order breaks ties
      .slice(0, limit)
      .map(([id]) => id);
  } catch {
    return null;
  }
}

/** Event ids (newest first) that reference an entity, in a namespace. null when not ready. */
export function ftsEventIdsForEntity(
  db: DatabaseSync,
  entityId: string,
  namespace: string,
  limit: number,
): string[] | null {
  if (!isKbIndexReady(db, "event_entities")) return null;
  try {
    const rows = db
      .prepare(
        `SELECT event_id FROM event_entities
          WHERE entity_id = ? AND namespace = ?
          ORDER BY ts DESC, event_id DESC LIMIT ?`,
      )
      .all(entityId, namespace, limit) as Array<{ event_id: string }>;
    return rows.map((r) => r.event_id);
  } catch {
    return null;
  }
}

/**
 * For candidate entities, the candidate-subset of every event that mentions at
 * least one of them (one array per event). null when the index is not ready.
 * Feeds the co-occurrence edges of `candidateAdjacency`.
 */
export function cooccurringCandidateLists(
  db: DatabaseSync,
  candidateIds: string[],
  namespace: string,
): string[][] | null {
  if (!isKbIndexReady(db, "event_entities")) return null;
  try {
    const byEvent = new Map<string, string[]>();
    for (let i = 0; i < candidateIds.length; i += IN_CHUNK) {
      const chunk = candidateIds.slice(i, i + IN_CHUNK);
      const rows = db
        .prepare(
          `SELECT event_id, entity_id FROM event_entities
            WHERE entity_id IN (${chunk.map(() => "?").join(",")}) AND namespace = ?`,
        )
        .all(...chunk, namespace) as Array<{ event_id: string; entity_id: string }>;
      for (const r of rows) {
        const list = byEvent.get(r.event_id);
        if (list) list.push(r.entity_id);
        else byEvent.set(r.event_id, [r.entity_id]);
      }
    }
    return [...byEvent.values()];
  } catch {
    return null;
  }
}
