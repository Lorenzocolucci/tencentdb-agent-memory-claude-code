/**
 * VectorStore: SQLite-based vector storage using sqlite-vec extension.
 *
 * Manages two layers of vector-indexed data in a single SQLite database:
 *
 * **L1 (structured memories):**
 * 1. `l1_records` — relational metadata table (content, type, priority, scene, timestamps)
 * 2. `l1_vec` — vec0 virtual table for cosine similarity search
 *
 * **L0 (raw conversations):**
 * 3. `l0_conversations` — relational metadata table (session_key, role, message text, timestamps)
 * 4. `l0_vec` — vec0 virtual table for cosine similarity search on individual messages
 *
 * Dependencies: Node.js built-in `node:sqlite` (Node 22+) + `sqlite-vec` (from root workspace).
 *
 * Design:
 * - All operations are synchronous (DatabaseSync API).
 * - Writes use manual BEGIN/COMMIT transactions for atomicity (metadata + vector).
 * - vec0 virtual table does NOT support ON CONFLICT, so upsert = delete + insert.
 * - Thread-safe via WAL mode.
 */

import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { MemoryRecord } from "../record/l1-writer.js";
import { initFoundationsSchema } from "../kb/foundations-schema.js";
import { runConsolidation, type ConsolidationStats } from "../kb/consolidation-runner.js";
import {
  insertFingerprint as kbInsertFingerprint,
  queryRecentFingerprints as kbQueryRecentFingerprints,
  type StoredFingerprint,
} from "../kb/fingerprint-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type {
  IMemoryStore,
  StoreCapabilities,
  L0Record,
  L1SearchResult,
  L1FtsResult,
  L0SearchResult,
  L0FtsResult,
  KbEntity,
  KbEvent,
  KbEventInput,
  KbFact,
  KbRelation,
  KbRelationInput,
  KbVectorSearchResult,
  KbFtsSearchResult,
  KbLessonHit,
} from "./types.js";
import {
  queryHeadLessonsByFile as kbQueryHeadLessonsByFile,
  recordExposure as kbRecordExposure,
  creditAvoidance as kbCreditAvoidance,
  temperOnRecurrence as kbTemperOnRecurrence,
  queryLessonsExposedInSession as kbQueryLessonsExposedInSession,
  recordStanceFire as kbRecordStanceFire,
  creditStanceConfirmed as kbCreditStanceConfirmed,
  creditStanceRejected as kbCreditStanceRejected,
} from "../kb/lessons-writer.js";
import { phaseFor as lessonPhaseFor } from "../kb/lesson-reinforcement.js";
import { distillLessons as kbDistillLessons } from "../kb/lessons-runner.js";
import { distillUsage as kbDistillUsage } from "../kb/usage-runner.js";
import { createKbVecEmbeddingReader } from "../kb/bug-embeddings.js";
import { ensureLifecycle, confirmProvenance, rejectProvenance, markGatePending, getLifecycle, stampSalience as kbStampSalience } from "../kb/lifecycle-writer.js";
import { serializeProvenance, parseProvenance, gateStateOf, type ProvenanceStamp } from "../kb/provenance.js";
import { classifyStakes, shouldGate } from "../kb/stakes.js";
import { spreadActivation, isNoiseAttribute, type WeightedNeighbor } from "../kb/spreading-activation.js";
import type { LLMRunner } from "../types.js";
import {
  resolveOrCreateEntity as kbResolveOrCreateEntity,
  insertEvent as kbInsertEvent,
  upsertFact as kbUpsertFact,
  upsertRelation as kbUpsertRelation,
  queryHeadFacts as kbQueryHeadFacts,
  queryAllFacts as kbQueryAllFacts,
  queryEntityById as kbQueryEntityById,
  queryEntityByKey as kbQueryEntityByKey,
  queryFactById as kbQueryFactById,
  queryEventById as kbQueryEventById,
  queryEntitiesByTokens as kbQueryEntitiesByTokens,
  listEntities as kbListEntities,
  listRecentEvents as kbListRecentEvents,
  listEventsBySession as kbListEventsBySession,
  latestEventBySessionKeyType as kbLatestEventBySessionKeyType,
  queryRelationsForEntity as kbQueryRelationsForEntity,
  queryEventsForEntity as kbQueryEventsForEntity,
  kbChunkId,
} from "../kb/kb-queries.js";

// ============================
// Types
// ============================

export interface VectorSearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** Cosine similarity score (1.0 - cosine_distance) */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  /** Raw metadata JSON string (e.g., contains activity_start_time / activity_end_time for episodic) */
  metadata_json: string;
}

/** L0 single-message vector search result. */
export interface L0VectorSearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** Cosine similarity score (1.0 - cosine_distance) */
  score: number;
  recorded_at: string;
  /** Original message timestamp (epoch ms) */
  timestamp: number;
}

/** Raw row returned by L1 record queries (column names match SQLite schema). */
export interface L1RecordRow {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  session_key: string;
  session_id: string;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  created_time: string;
  updated_time: string;
  metadata_json: string;
}

export interface L0RecordRow {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
}

/** Filter options for querying L1 records from SQLite. */
export interface L1QueryFilter {
  /** If provided, only return records for this session key (conversation channel). */
  sessionKey?: string;
  /** If provided, only return records for this session ID (single conversation instance). */
  sessionId?: string;
  /** If provided, only return records with updated_time strictly after this ISO 8601 UTC timestamp. */
  updatedAfter?: string;
}

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const TAG = "[memory-tdai][sqlite]";

/** Persisted metadata about the embedding provider used to generate stored vectors. */
interface EmbeddingMeta {
  provider: string;
  model: string;
  dimensions: number;
}

/** Result of VectorStore.init() — indicates whether a re-embed is needed. */
export interface VectorStoreInitResult {
  /**
   * `true` if the embedding provider/model/dimensions changed since
   * the vectors were last written.  Callers should re-embed all texts
   * (via `reindexAll()`) after receiving this flag.
   */
  needsReindex: boolean;
  /** Human-readable reason (for logging). */
  reason?: string;
}

// Use createRequire to load the experimental node:sqlite module
const require = createRequire(import.meta.url);

function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

// ============================
// FTS5 helpers (adapted from openclaw core hybrid.ts)
// ============================

// ── Chinese word segmentation (jieba) ──
// Lazy-loaded singleton: initialised on first call to `buildFtsQuery`.
// If @node-rs/jieba is unavailable, falls back to Unicode-regex splitting.

interface JiebaInstance {
  cutForSearch(text: string, hmm: boolean): string[];
}

let _jieba: JiebaInstance | null | undefined; // undefined = not yet tried

function getJieba(): JiebaInstance | null {
  if (_jieba !== undefined) return _jieba;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Jieba } = require("@node-rs/jieba");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dict } = require("@node-rs/jieba/dict");
    _jieba = Jieba.withDict(dict) as JiebaInstance;
  } catch {
    _jieba = null; // mark as unavailable — won't retry
  }
  return _jieba;
}

/**
 * Common Chinese stop-words that add noise to FTS5 queries.
 * Kept small on purpose — only high-frequency function words.
 */
const ZH_STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那",
  "吗", "吧", "呢", "啊", "呀", "哦", "嗯",
]);

/**
 * Build an FTS5 MATCH query from raw text.
 *
 * When `@node-rs/jieba` is available, uses jieba's search-engine mode
 * (`cutForSearch`) for accurate Chinese word segmentation, producing
 * much better recall than the previous regex-only approach.
 *
 * Falls back to Unicode-regex splitting (`/[\p{L}\p{N}_]+/gu`) if
 * jieba is not installed.
 *
 * Tokens are OR-joined as quoted FTS5 phrase terms so that a document
 * matching *any* token is returned.  BM25 naturally ranks documents that
 * match more tokens higher, so precision is preserved while recall is
 * significantly improved — especially for longer queries and when running
 * in FTS-only fallback mode (no embedding available).
 *
 * Example (with jieba):
 *   "用户喜欢编程和TypeScript" → '"用户" OR "喜欢" OR "编程" OR "TypeScript"'
 * Example (fallback):
 *   "旅行计划 API" → '"旅行计划" OR "API"'
 */
export function buildFtsQuery(raw: string): string | null {
  const jieba = getJieba();

  let tokens: string[];
  if (jieba) {
    // jieba cutForSearch: splits long words further for better recall
    // e.g. "北京烤鸭" → ["北京", "烤鸭", "北京烤鸭"]
    tokens = jieba
      .cutForSearch(raw, true)
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        // Remove pure whitespace / punctuation tokens
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        // Remove common Chinese stop-words to reduce noise
        if (ZH_STOP_WORDS.has(t)) return false;
        return true;
      });
    // Deduplicate (cutForSearch may produce duplicates for sub-words)
    tokens = [...new Set(tokens)];
  } else {
    // Fallback: simple Unicode regex split
    tokens =
      raw
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((t) => t.trim())
        .filter(Boolean) ?? [];
  }

  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

/**
 * Tokenize text for FTS5 indexing (write-side).
 *
 * Uses jieba `cutForSearch()` (search-engine mode) to segment Chinese text,
 * then joins tokens with spaces. The resulting string is stored in the FTS5
 * `content` column so that `unicode61` tokenizer can split it into meaningful
 * words — including both full words and their sub-words.
 *
 * Using `cutForSearch` (instead of `cut`) ensures that the index contains
 * the same sub-word tokens that `buildFtsQuery()` produces on the query side.
 * For example, "人工智能" is indexed as "人工 智能 人工智能", so queries for
 * either the full term or sub-words will match.
 *
 * Falls back to the original text if jieba is unavailable.
 *
 * Example (with jieba):
 *   "用户五月去日本旅行" → "用户 五月 去 日本 旅行"
 *   "人工智能的分支"     → "人工 智能 人工智能 的 分支"
 * Example (fallback):
 *   "用户五月去日本旅行" → "用户五月去日本旅行" (unchanged)
 */
export function tokenizeForFts(raw: string): string {
  const jieba = getJieba();
  if (!jieba) return raw;

  // Use `cutForSearch` (search-engine mode) for indexing — it produces both
  // full words AND their sub-word components. This ensures that query-side
  // tokens (also produced by `cutForSearch` in `buildFtsQuery`) will always
  // find a match in the index.
  const tokens = jieba.cutForSearch(raw, true);

  // Join with spaces so `unicode61` tokenizer can split them.
  // Punctuation tokens are kept — unicode61 treats them as separators anyway.
  return tokens.join(" ");
}

/**
 * Reset jieba state so next call to `buildFtsQuery` re-initialises.
 * Exported for testing only.
 * @internal
 */
export function _resetJiebaForTest(): void {
  _jieba = undefined;
}

/**
 * Override jieba instance (or set to `null` to force fallback).
 * Exported for testing only.
 * @internal
 */
export function _setJiebaForTest(instance: JiebaInstance | null): void {
  _jieba = instance;
}

/**
 * Convert a BM25 rank (negative = more relevant) to a 0–1 score.
 * Mirrors the formula in openclaw core `hybrid.ts`.
 */
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

/** FTS5 search result for L1 records. */
export interface FtsSearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** BM25-derived score (0–1, higher is better) */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
}

/** FTS5 search result for L0 records. */
export interface L0FtsSearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** BM25-derived score (0–1, higher is better) */
  score: number;
  recorded_at: string;
  timestamp: number;
}

// ============================
// VectorStore class
// ============================

export class VectorStore implements IMemoryStore {
  private db: DatabaseSync;
  private readonly dimensions: number;
  private readonly logger?: Logger;

  /** @see IMemoryStore.supportsDeferredEmbedding */
  readonly supportsDeferredEmbedding = true;

  /**
   * When `true`, the store is in a degraded state (e.g. sqlite-vec failed to
   * load, or init() encountered an unrecoverable error).  All public methods
   * become safe no-ops so the plugin never blocks the main OpenClaw flow.
   */
  private degraded = false;

  /** Tracks whether close() has been called to prevent double-close errors. */
  private closed = false;

  /**
   * `true` when vec0 virtual tables (l1_vec / l0_vec) have been created and
   * their prepared statements are ready.  When `dimensions === 0` (i.e.
   * provider="none"), vec0 tables are deferred and this stays `false`.
   */
  private vecTablesReady = false;

  // Prepared statements — L1 (initialized in init())
  private stmtUpsertMeta!: StatementSync;
  private stmtDeleteVec?: StatementSync;   // optional — only set when vecTablesReady
  private stmtInsertVec?: StatementSync;   // optional — only set when vecTablesReady
  private stmtDeleteMeta!: StatementSync;
  private stmtGetMeta!: StatementSync;
  private stmtSearchVec?: StatementSync;   // optional — only set when vecTablesReady
  private stmtQueryBySessionId!: StatementSync;
  private stmtQueryBySessionIdSince!: StatementSync;
  private stmtQueryBySessionKey!: StatementSync;
  private stmtQueryBySessionKeySince!: StatementSync;
  private stmtQueryAll!: StatementSync;
  private stmtQueryAllSince!: StatementSync;

  // Prepared statements — L0 (initialized in init())
  private stmtL0UpsertMeta!: StatementSync;
  private stmtL0DeleteVec?: StatementSync;   // optional — only set when vecTablesReady
  private stmtL0InsertVec?: StatementSync;   // optional — only set when vecTablesReady
  private stmtL0DeleteMeta!: StatementSync;
  private stmtL0GetMeta!: StatementSync;
  private stmtL0SearchVec?: StatementSync;   // optional — only set when vecTablesReady
  /** L0 query for L1 runner: all messages for a session key (DESC, newest-first) */
  private stmtL0QueryAll!: StatementSync;
  /** L0 query for L1 runner: cold-start read, OLDEST-first.
   *  Used on the first-ever L1 (cursor=0) so a LIMIT-bounded read returns the
   *  OLDEST un-extracted window and never skips the oldest backlog messages. */
  private stmtL0QueryAllAsc!: StatementSync;
  /** L0 query for L1 runner: messages after a timestamp cursor */
  private stmtL0QueryAfter!: StatementSync;
  /** L0 query for L1 runner: messages after a cursor, OLDEST-first.
   *  Used for incremental reads so a partial (LIMIT-bounded) read never skips
   *  the oldest un-extracted messages — the cursor advances over them in order. */
  private stmtL0QueryAfterAsc!: StatementSync;
  /** L1 cursor-based pagination for migration (by PK) */
  private stmtL1QueryMigrationCursor!: StatementSync;
  /** L0 cursor-based pagination for migration (by PK) */
  private stmtL0QueryMigrationCursor!: StatementSync;

  // FTS5 tables availability flag (created best-effort — may be false if fts5 is not compiled in)
  private ftsAvailable = false;

  // Prepared statements — FTS5 L1 (initialized in init())
  private stmtL1FtsInsert!: StatementSync;
  private stmtL1FtsDelete!: StatementSync;
  private stmtL1FtsSearch!: StatementSync;

  // Prepared statements — FTS5 L0 (initialized in init())
  private stmtL0FtsInsert!: StatementSync;
  private stmtL0FtsDelete!: StatementSync;
  private stmtL0FtsSearch!: StatementSync;

  // ── KB (Entity-Centric Core) — Phase 1 ──
  /** `true` once entities/facts/events/relations tables exist. */
  private kbReady = false;
  /** `true` once the kb_vec vec0 table exists (requires dimensions > 0). */
  private kbVecReady = false;
  /** `true` once the kb_fts FTS5 table exists. */
  private kbFtsAvailable = false;
  private stmtKbVecDelete?: StatementSync;
  private stmtKbVecInsert?: StatementSync;
  private stmtKbVecSearch?: StatementSync;
  private stmtKbVecSearchKind?: StatementSync;
  private stmtKbFtsDelete?: StatementSync;
  private stmtKbFtsInsert?: StatementSync;
  private stmtKbFtsSearch?: StatementSync;

  /**
   * Create a VectorStore instance.
   *
   * Note: After construction, you MUST call `init()` to load the sqlite-vec
   * extension and create the schema.
   */
  constructor(dbPath: string, dimensions: number, logger?: Logger) {
    this.dimensions = dimensions;
    this.logger = logger;

    // Open database with extension support enabled
    const { DatabaseSync: DbSync } = requireNodeSqlite();
    this.db = new DbSync(dbPath, { allowExtension: true });

    // Set busy timeout so concurrent processes retry instead of failing with SQLITE_BUSY
    this.db.exec("PRAGMA busy_timeout = 5000");

    // Enable WAL mode for better concurrent read performance
    this.db.exec("PRAGMA journal_mode = WAL");

    // Cap page cache at 64 MB
    this.db.exec("PRAGMA cache_size = -65536");

    // Cap memory-mapped I/O at 128 MB to bound RSS growth
    this.db.exec("PRAGMA mmap_size = 134217728");

    // Auto-checkpoint WAL every 1000 pages (~4 MB) to keep WAL file compact
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");
  }

  /**
   * Whether the store is in degraded mode (e.g. sqlite-vec failed to load).
   * When degraded, all write/search operations become safe no-ops.
   */
  isDegraded(): boolean {
    return this.degraded;
  }


  /**
   * Load sqlite-vec extension and initialize database schema.
   * Must be called once after construction.
   *
   * @param providerInfo  Current embedding provider info. When provided,
   *   the store compares it against the persisted metadata. If the provider,
   *   model, or dimensions changed, the vector tables are dropped and
   *   re-created with the new dimensions, and `needsReindex: true` is returned
   *   so the caller can schedule a full re-embed.
   */
  init(providerInfo?: EmbeddingProviderInfo): VectorStoreInitResult {
    // Load sqlite-vec extension (same approach as root project's sqlite-vec.ts)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require("sqlite-vec");
      this.db.enableLoadExtension(true);
      sqliteVec.load(this.db);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(
        `${TAG} Failed to load sqlite-vec extension: ${message}. ` +
        `VectorStore entering degraded mode — all operations will be no-ops.`,
      );
      this.degraded = true;
      return { needsReindex: false, reason: `sqlite-vec load failed: ${message}` };
    }

    // ── Schema creation & prepared statements ──────────────────────────────
    // Wrapped in try-catch: if anything fails during schema init (e.g. the DB
    // is corrupted, disk full, etc.), we degrade gracefully instead of crashing.
    try {
      return this.initSchema(providerInfo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(
        `${TAG} Schema initialization failed: ${message}. ` +
        `VectorStore entering degraded mode.`,
      );
      this.degraded = true;
      return { needsReindex: false, reason: `schema init failed: ${message}` };
    }
  }

  /**
   * Internal schema initialization — separated from init() so we can
   * catch errors at the top level and degrade gracefully.
   */
  private initSchema(providerInfo?: EmbeddingProviderInfo): VectorStoreInitResult {
    // Tracks which provider/model/dimensions were used to generate vectors.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Detect whether re-index is needed
    let needsReindex = false;
    let reindexReason: string | undefined;

    // ── Chunk-schema migration ──────────────────────────────
    // Older DBs created the vec0 tables with `record_id TEXT PRIMARY KEY`, which
    // allows only ONE vector per record (long texts were truncated).  The new
    // schema uses `chunk_id TEXT PRIMARY KEY` + `record_id TEXT partition key`
    // so a record can own N chunk-vectors.  When we detect the legacy shape we
    // DROP the vec0 tables (metadata tables l1_records / l0_conversations are
    // preserved) and flag a reindex so vectors get rebuilt with chunking.
    if (this.dimensions > 0 && this.vecSchemaIsLegacy()) {
      this.logger?.info(
        `${TAG} Legacy vec0 schema detected (single-vector-per-record). ` +
        `Dropping vector tables to migrate to chunked schema (metadata preserved)...`,
      );
      this.dropVectorTables();
      const hasData =
        this.tableRowCount("l1_records") > 0 || this.tableRowCount("l0_conversations") > 0;
      if (hasData) {
        needsReindex = true;
        reindexReason = "vec0 schema migrated to chunked (chunk_id PK + record_id partition key)";
      }
    }

    const savedMeta = this.readEmbeddingMeta();

    if (providerInfo) {
      if (savedMeta) {
        const providerChanged = savedMeta.provider !== providerInfo.provider;
        const modelChanged = savedMeta.model !== providerInfo.model;
        const dimsChanged = savedMeta.dimensions !== this.dimensions;

        if (providerChanged || modelChanged || dimsChanged) {
          const reasons: string[] = [];
          if (providerChanged) reasons.push(`provider: ${savedMeta.provider} → ${providerInfo.provider}`);
          if (modelChanged) reasons.push(`model: ${savedMeta.model} → ${providerInfo.model}`);
          if (dimsChanged) reasons.push(`dimensions: ${savedMeta.dimensions} → ${this.dimensions}`);
          reindexReason = reasons.join(", ");

          this.logger?.info(
            `${TAG} Embedding config changed (${reindexReason}). ` +
            `Dropping vector tables for rebuild...`,
          );

          // Drop and re-create vector tables with new dimensions
          this.dropVectorTables();
          needsReindex = true;
        }
      } else {
        // No saved meta — first run or legacy DB without meta table.
        // Two cases require dropping vector tables:
        // 1. Existing data created without meta tracking (legacy DB) — need re-embed
        // 2. vec0 tables exist with wrong dimensions (e.g. previously created with
        //    provider="none" placeholder 768D, now switching to a real provider
        //    with different dimensions) — must rebuild even if data tables are empty
        const l1Count = this.tableRowCount("l1_records");
        const l0Count = this.tableRowCount("l0_conversations");
        const existingVecDims = this.getVecTableDimensions();

        if (l1Count > 0 || l0Count > 0) {
          this.logger?.info(
            `${TAG} No embedding_meta found but existing data exists ` +
            `(L1=${l1Count}, L0=${l0Count}). Dropping vector tables for safety...`,
          );
          this.dropVectorTables();
          needsReindex = true;
          reindexReason = "legacy DB without embedding_meta — cannot verify vector compatibility";
        } else if (existingVecDims !== null && existingVecDims !== this.dimensions) {
          // vec0 tables exist (from a previous provider="none" placeholder or
          // different config) but with mismatched dimensions.  Drop them so they
          // get re-created with the correct dimensions below.
          this.logger?.info(
            `${TAG} vec0 table dimension mismatch (existing=${existingVecDims}, ` +
            `required=${this.dimensions}). Dropping vector tables for rebuild...`,
          );
          this.dropVectorTables();
          // No needsReindex — there's no data to re-embed
        }
      }
    }

    // ── L1 schema ──────────────────────────────────

    // Metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_records (
        record_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        scene_name TEXT DEFAULT '',
        session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT '',
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      )
    `);

    // Indexes for common queries
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_type ON l1_records(type)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_key ON l1_records(session_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_id ON l1_records(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_scene ON l1_records(scene_name)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_ts_start ON l1_records(timestamp_start)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_ts_end ON l1_records(timestamp_end)");
    // Composite index: session_id exact match + updated_time range scan (for incremental L2 queries)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_updated ON l1_records(session_id, updated_time)");
    // Composite index: session_key exact match + updated_time range scan (for pipeline cursor queries)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_sessionkey_updated ON l1_records(session_key, updated_time)");

    // Vector virtual table (cosine distance) — only created when dimensions > 0.
    // When provider="none", dimensions=0 and vec0 tables are deferred until a
    // real embedding provider is configured.
    // Chunked vector schema: one row PER CHUNK.
    //   chunk_id     — PK, "<record_id>#<index>" (unique per chunk).
    //   record_id    — partition key, so DELETE/lookups by record touch all chunks.
    //   embedding    — the chunk vector (KEEP the `float[N]` substring intact:
    //                  getVecTableDimensions() parses N from this DDL).
    //   updated_time — metadata column, used by deleteL1Expired range deletes.
    if (this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec USING vec0(
          chunk_id TEXT PRIMARY KEY,
          record_id TEXT partition key,
          embedding float[${this.dimensions}] distance_metric=cosine,
          updated_time TEXT DEFAULT '',
          chunk_size=8
        )
      `);
    }

    // Prepare statements for reuse
    this.stmtUpsertMeta = this.db.prepare(`
      INSERT INTO l1_records (
        record_id, content, type, priority, scene_name, session_key, session_id,
        timestamp_str, timestamp_start, timestamp_end,
        created_time, updated_time, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        content=excluded.content,
        type=excluded.type,
        priority=excluded.priority,
        scene_name=excluded.scene_name,
        timestamp_str=excluded.timestamp_str,
        timestamp_start=excluded.timestamp_start,
        timestamp_end=excluded.timestamp_end,
        updated_time=excluded.updated_time,
        metadata_json=excluded.metadata_json
    `);

    if (this.dimensions > 0) {
      // DELETE by partition key removes ALL chunk rows for a record.
      this.stmtDeleteVec = this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?");
      // INSERT one chunk row (chunk_id is "<record_id>#<index>").
      this.stmtInsertVec = this.db.prepare(
        "INSERT INTO l1_vec (chunk_id, record_id, embedding, updated_time) VALUES (?, ?, ?, ?)",
      );
    }
    this.stmtDeleteMeta = this.db.prepare("DELETE FROM l1_records WHERE record_id = ?");

    this.stmtGetMeta = this.db.prepare(`
      SELECT content, type, priority, scene_name, session_key, session_id,
             timestamp_str, timestamp_start, timestamp_end, metadata_json
      FROM l1_records WHERE record_id = ?
    `);

    if (this.dimensions > 0) {
      // Return record_id (partition key) so multiple chunks of the same record
      // can be de-duped to the best-scoring chunk at recall time.
      this.stmtSearchVec = this.db.prepare(`
        SELECT chunk_id, record_id, distance
        FROM l1_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    }

    // ── L0 schema ──────────────────────────────────

    // L0 metadata table: stores individual messages for vector search
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_id TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0
      )
    `);

    // Migration: add timestamp column if missing (existing DBs pre-v3.x)
    try {
      this.db.exec("ALTER TABLE l0_conversations ADD COLUMN timestamp INTEGER DEFAULT 0");
      this.logger?.debug?.(`${TAG} Migrated l0_conversations: added timestamp column`);
    } catch {
      // Column already exists — expected on non-first run
    }

    // Indexes for L0 queries
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_session ON l0_conversations(session_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_session_id ON l0_conversations(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_recorded ON l0_conversations(recorded_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON l0_conversations(timestamp)");

    // L0 vector virtual table (cosine distance, same dimensions as L1) — deferred when dimensions=0.
    // Chunked schema: one row per chunk (chunk_id PK), record_id partition key.
    if (this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_vec USING vec0(
          chunk_id TEXT PRIMARY KEY,
          record_id TEXT partition key,
          embedding float[${this.dimensions}] distance_metric=cosine,
          recorded_at TEXT DEFAULT '',
          chunk_size=8
        )
      `);
    }

    // L0 prepared statements
    this.stmtL0UpsertMeta = this.db.prepare(`
      INSERT INTO l0_conversations (
        record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        message_text=excluded.message_text,
        recorded_at=excluded.recorded_at,
        timestamp=excluded.timestamp
    `);

    if (this.dimensions > 0) {
      // DELETE by partition key removes ALL chunk rows for a record.
      this.stmtL0DeleteVec = this.db.prepare("DELETE FROM l0_vec WHERE record_id = ?");
      this.stmtL0InsertVec = this.db.prepare(
        "INSERT INTO l0_vec (chunk_id, record_id, embedding, recorded_at) VALUES (?, ?, ?, ?)",
      );
    }
    this.stmtL0DeleteMeta = this.db.prepare("DELETE FROM l0_conversations WHERE record_id = ?");

    this.stmtL0GetMeta = this.db.prepare(`
      SELECT session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations WHERE record_id = ?
    `);

    if (this.dimensions > 0) {
      this.stmtL0SearchVec = this.db.prepare(`
        SELECT chunk_id, record_id, distance
        FROM l0_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    }

    // L0 query statements for L1 runner (newest-first + LIMIT to bound memory)
    // Sort/filter by recorded_at (write time) instead of timestamp (conversation time)
    // because L1 cursor uses recorded_at semantics. ISO 8601 string comparison preserves time order.
    this.stmtL0QueryAll = this.db.prepare(`
      SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE session_key = ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `);

    // Cold-start read, OLDEST-first. On the FIRST-EVER L1 for a session (cursor
    // = 0) we must read the OLDEST N messages, not the newest. The newest-N
    // (DESC) variant above would skip every message older than the newest N
    // forever, because the cursor then advances to the newest message read.
    // ASC returns the oldest un-extracted window first, so paging + per-window
    // cursor advancement walks the whole backlog across triggers without loss.
    this.stmtL0QueryAllAsc = this.db.prepare(`
      SELECT rowid AS _rowid, record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE session_key = ?
      ORDER BY recorded_at ASC, rowid ASC
      LIMIT ?
    `);

    this.stmtL0QueryAfter = this.db.prepare(`
      SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE session_key = ? AND recorded_at > ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `);

    // Incremental cursor read, OLDEST-first. The DESC variant above keeps the
    // NEWEST N when a backlog exceeds LIMIT — for a cursor-based reader that
    // SKIPS the oldest un-extracted messages permanently (the cursor then jumps
    // past them). ASC returns the oldest un-extracted window first, so paging +
    // cursor advancement processes the whole backlog across successive triggers.
    // Composite (recorded_at, rowid) cursor: recorded_at is primary (existing
    // cursors stay valid), rowid breaks ties. Required because the chat backfill
    // gives EVERY message in a conversation the SAME recorded_at — a strict
    // `recorded_at > ?` cursor then can't page past the first window (44/94 msgs
    // lost). rowid is unique, monotonic, and preserves conversation order.
    this.stmtL0QueryAfterAsc = this.db.prepare(`
      SELECT rowid AS _rowid, record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE session_key = ? AND (recorded_at > ? OR (recorded_at = ? AND rowid > ?))
      ORDER BY recorded_at ASC, rowid ASC
      LIMIT ?
    `);

    this.stmtL0QueryMigrationCursor = this.db.prepare(`
      SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE record_id > ?
      ORDER BY record_id ASC
      LIMIT ?
    `);

    // ── FTS5 tables (best-effort — gracefully degrade if fts5 is not compiled in) ──
    // Schema v2: `content` column stores jieba-segmented text (for indexing),
    // `content_original` (UNINDEXED) stores the raw text (for display).
    // If old v1 tables exist (no content_original column), drop + recreate.
    try {
      // ── Migrate old FTS5 tables (v1 → v2) ──
      // v1 tables stored raw text in the `content` column. v2 stores segmented
      // text in `content` and raw text in `content_original` / `message_text_original`.
      // FTS5 virtual tables don't support ALTER TABLE ADD COLUMN, so we must
      // drop and recreate. The data will be repopulated by `rebuildFtsIndex()`.
      const needsFtsRebuild = this.migrateFtsTablesIfNeeded();

      // L1 FTS5 virtual table (v2 schema)
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
          content,
          content_original UNINDEXED,
          record_id UNINDEXED,
          type UNINDEXED,
          priority UNINDEXED,
          scene_name UNINDEXED,
          session_key UNINDEXED,
          session_id UNINDEXED,
          timestamp_str UNINDEXED,
          timestamp_start UNINDEXED,
          timestamp_end UNINDEXED,
          metadata_json UNINDEXED
        )
      `);

      // L0 FTS5 virtual table (v2 schema)
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(
          message_text,
          message_text_original UNINDEXED,
          record_id UNINDEXED,
          session_key UNINDEXED,
          session_id UNINDEXED,
          role UNINDEXED,
          recorded_at UNINDEXED,
          timestamp UNINDEXED
        )
      `);

      // L1 FTS prepared statements
      this.stmtL1FtsInsert = this.db.prepare(`
        INSERT INTO l1_fts (content, content_original, record_id, type, priority, scene_name,
          session_key, session_id, timestamp_str, timestamp_start, timestamp_end, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.stmtL1FtsDelete = this.db.prepare("DELETE FROM l1_fts WHERE record_id = ?");

      this.stmtL1FtsSearch = this.db.prepare(`
        SELECT record_id, content_original AS content, type, priority, scene_name,
               session_key, session_id, timestamp_str, timestamp_start, timestamp_end,
               metadata_json,
               bm25(l1_fts) AS rank
        FROM l1_fts
        WHERE l1_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);

      // L0 FTS prepared statements
      this.stmtL0FtsInsert = this.db.prepare(`
        INSERT INTO l0_fts (message_text, message_text_original, record_id, session_key, session_id, role, recorded_at, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.stmtL0FtsDelete = this.db.prepare("DELETE FROM l0_fts WHERE record_id = ?");

      this.stmtL0FtsSearch = this.db.prepare(`
        SELECT record_id, message_text_original AS message_text, session_key, session_id, role, recorded_at, timestamp,
               bm25(l0_fts) AS rank
        FROM l0_fts
        WHERE l0_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);

      this.ftsAvailable = true;
      this.logger?.debug?.(`${TAG} FTS5 tables initialized (l1_fts, l0_fts) [schema v2 — jieba segmented]`);

      // Rebuild FTS index if migrated from v1 or tables were freshly created
      if (needsFtsRebuild) {
        this.rebuildFtsIndex();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ftsAvailable = false;
      this.logger?.warn(
        `${TAG} FTS5 tables NOT available (fts5 may not be compiled in): ${message}. ` +
        `FTS-based keyword search will be unavailable; recall will use in-memory scoring if needed.`,
      );
    }

    // ── KB (Entity-Centric Core) schema — Phase 1, ADDITIVE ──
    // Creates entities/facts/events/relations + the kb_vec/kb_fts recall
    // surfaces. Best-effort: a failure here must NOT break L0/L1 (those are the
    // live path). On any error we leave the KB tables unavailable and continue.
    this.initKbSchema();

    // Save current embedding meta (write after schema is ready)
    if (providerInfo) {
      this.writeEmbeddingMeta({
        provider: providerInfo.provider,
        model: providerInfo.model,
        dimensions: this.dimensions,
      });
    }

    // Mark vec0 tables as ready only when they were actually created
    this.vecTablesReady = this.dimensions > 0;
    // L1 query statements (for l1-reader)
    const l1QueryCols = `record_id, content, type, priority, scene_name, session_key, session_id,
      timestamp_str, timestamp_start, timestamp_end,
      created_time, updated_time, metadata_json`;

    this.stmtQueryBySessionId = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_id = ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionIdSince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_id = ? AND updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionKey = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_key = ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionKeySince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_key = ? AND updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryAll = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      ORDER BY updated_time ASC
    `);

    this.stmtQueryAllSince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtL1QueryMigrationCursor = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE record_id > ?
      ORDER BY record_id ASC
      LIMIT ?
    `);

    this.logger?.debug?.(`${TAG} Initialized (dimensions=${this.dimensions})`);

    return { needsReindex, reason: reindexReason };
  }

  // ── Embedding meta helpers ──────────────────────────────

  private readEmbeddingMeta(): EmbeddingMeta | null {
    try {
      const row = this.db
        .prepare("SELECT value FROM embedding_meta WHERE key = ?")
        .get("embedding_provider_info") as { value: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.value) as EmbeddingMeta;
    } catch {
      return null;
    }
  }

  private writeEmbeddingMeta(meta: EmbeddingMeta): void {
    this.db.prepare(
      "INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run("embedding_provider_info", JSON.stringify(meta));
  }

  /** Allowed table names for row counting (whitelist to prevent SQL injection). */
  private static readonly COUNTABLE_TABLES = new Set(["l1_records", "l0_conversations"]);

  /**
   * Extra rows to retrieve from vec0 KNN search to compensate for legacy
   * zero-vector placeholders that may still linger from older data.
   */
  private static readonly ZERO_VEC_BUFFER = 10;

  /**
   * Multiplier applied to topK when over-fetching vec0 candidates, to ensure
   * enough DISTINCT records survive de-dup after multiple chunks of the same
   * record are collapsed.  A value of 4 tolerates up to ~4 matching chunks per
   * record before distinct-record recall could be starved.
   */
  private static readonly CHUNK_RECALL_FANOUT = 4;

  /** Default result limit for FTS5 keyword searches. */
  private static readonly FTS_DEFAULT_LIMIT = 20;

  private tableRowCount(table: string): number {
    if (!VectorStore.COUNTABLE_TABLES.has(table)) {
      this.logger?.warn(`${TAG} tableRowCount: rejected unknown table name "${table}"`);
      return 0;
    }
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM ${table}`)
        .get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Detect the embedding dimension of an existing vec0 table by inspecting
   * the DDL stored in sqlite_master.  Returns `null` if the table doesn't
   * exist or the dimension cannot be determined.
   *
   * The vec0 DDL looks like:
   *   CREATE VIRTUAL TABLE l1_vec USING vec0(... embedding float[768] ...)
   * We parse the number inside `float[N]`.
   */
  private getVecTableDimensions(): number | null {
    try {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get("l1_vec") as { sql: string } | undefined;
      if (!row?.sql) return null;
      const match = row.sql.match(/float\[(\d+)\]/);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Detect whether the existing vec0 tables use the LEGACY single-vector schema
   * (`record_id TEXT PRIMARY KEY`) rather than the chunked schema
   * (`chunk_id TEXT PRIMARY KEY` + `record_id ... partition key`).
   *
   * Returns `true` only when an `l1_vec` (or `l0_vec`) table exists AND its DDL
   * lacks a `chunk_id` column.  Returns `false` when no vec table exists yet
   * (fresh DB — the chunked schema will be created directly) or when the table
   * already uses the chunked schema.
   */
  private vecSchemaIsLegacy(): boolean {
    try {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('l1_vec','l0_vec') LIMIT 1")
        .get() as { sql: string } | undefined;
      if (!row?.sql) return false; // no vec table yet → not legacy, create fresh
      // Chunked schema always declares a chunk_id column; legacy schema never does.
      return !/\bchunk_id\b/i.test(row.sql);
    } catch {
      return false;
    }
  }

  /**
   * Drop both L1 and L0 vector virtual tables.
   * Metadata tables (l1_records, l0_conversations) are preserved — only
   * the vec0 tables need to be rebuilt with the new dimensions.
   */
  private dropVectorTables(): void {
    this.db.exec("DROP TABLE IF EXISTS l1_vec");
    this.db.exec("DROP TABLE IF EXISTS l0_vec");
    // kb_vec is the recall surface for the entity-centric KB (recall.source=kb).
    // It MUST be dropped too on a dimension/model change — otherwise it survives
    // at the OLD dimension while l0/l1 move to the new one → kb semantic recall
    // silently mismatches. initKbSchema recreates it at the new dimension;
    // reindexKb() refills it (kb_fts, the text source, is preserved). Uses
    // prepare().run() (not db.exec) to avoid the child_process.exec lint false-positive.
    this.db.prepare("DROP TABLE IF EXISTS kb_vec").run();
    this.logger?.info(`${TAG} Dropped vector tables (l1_vec, l0_vec, kb_vec)`);
  }

  /**
   * Normalize an embedding argument into an array of NON-ZERO chunk vectors.
   *
   * Accepts the historical single-`Float32Array` form (treated as one chunk) or
   * the chunked `Float32Array[]` form (one element per chunk).  Zero vectors are
   * filtered out — they are placeholders from embedding failures and must never
   * pollute the vec0 index (they yield NULL/NaN cosine distance).
   *
   * Returns an empty array when there is nothing valid to write (caller should
   * then skip the vec write and persist metadata + FTS only).
   */
  private static toChunkVectors(
    embedding: Float32Array | Float32Array[] | undefined,
  ): Float32Array[] {
    if (!embedding) return [];
    const arr = Array.isArray(embedding) ? embedding : [embedding];
    return arr.filter((v) => v.length > 0 && !v.every((x) => x === 0));
  }

  /** Stable, unique chunk id for a given record + chunk index. */
  private static chunkId(recordId: string, index: number): string {
    return `${recordId}#${index}`;
  }

  /**
   * Write or update a memory record (metadata + vector).
   * Uses a manual transaction for atomicity.
   *
   * If `embedding` is `undefined` or a zero vector (all elements are 0), only
   * the metadata row is written — the vec0 table is left untouched.  This
   * allows callers without an EmbeddingService to still persist metadata + FTS
   * without constructing a throwaway zero-vector, and prevents placeholder
   * zero vectors (from embedding-service failures) from polluting KNN search
   * results with null / NaN distances.
   *
   * **Fault-tolerant**: catches all errors internally so that a vector store
   * failure never propagates to the caller / main OpenClaw flow.
   * Returns `true` on success, `false` on failure (logged as warning).
   */
  upsertL1(record: MemoryRecord, embedding: Float32Array | Float32Array[] | undefined): boolean {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L1-upsert] SKIPPED (degraded mode) id=${record.id}`);
      return false;
    }
    try {
      const { id: recordId, timestamps } = record;
      const tsStr = timestamps[0] ?? "";
      const tsStart =
        timestamps.length > 0
          ? timestamps.reduce((a, b) => (a < b ? a : b))
          : tsStr;
      const tsEnd =
        timestamps.length > 0
          ? timestamps.reduce((a, b) => (a > b ? a : b))
          : tsStr;

      // Normalize to N non-zero chunk vectors (single Float32Array → 1 chunk).
      const chunkVectors = VectorStore.toChunkVectors(embedding);
      const skipVec = chunkVectors.length === 0 || !this.vecTablesReady;

      this.logger?.debug?.(
        `${TAG} [L1-upsert] START id=${recordId}, type=${record.type}, ` +
        `content="${record.content.slice(0, 60)}..."` +
        (embedding
          ? `, chunks=${chunkVectors.length}` +
            `${skipVec ? " (no valid vectors or vec tables not ready — vec write will be skipped)" : ""}`
          : " (no embedding — metadata-only write)"),
      );

      this.db.exec("BEGIN");
      try {
        // Upsert metadata (INSERT OR UPDATE)
        this.stmtUpsertMeta.run(
          recordId,
          record.content,
          record.type,
          record.priority,
          record.scene_name,
          record.sessionKey,
          record.sessionId,
          tsStr,
          tsStart,
          tsEnd,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record.metadata),
        );

        if (!skipVec) {
          // vec0 has no ON CONFLICT and a record may own N chunks → delete ALL
          // chunk rows for the record (by partition key), then insert one per chunk.
          this.stmtDeleteVec!.run(recordId);
          for (let i = 0; i < chunkVectors.length; i++) {
            this.stmtInsertVec!.run(
              VectorStore.chunkId(recordId, i),
              recordId,
              Buffer.from(chunkVectors[i].buffer),
              record.updatedAt,
            );
          }
        } else {
          this.logger?.debug?.(
            `${TAG} [L1-upsert] Skipping vec write (${embedding ? "no valid vectors / vec tables not ready" : "no embedding"}) id=${recordId}`,
          );
        }

        // Sync FTS5 (delete + re-insert to handle updates)
        if (this.ftsAvailable) {
          try {
            this.stmtL1FtsDelete.run(recordId);
            this.stmtL1FtsInsert.run(
              tokenizeForFts(record.content), // content — segmented for indexing
              record.content,                 // content_original — raw for display
              recordId,
              record.type,
              record.priority,
              record.scene_name,
              record.sessionKey,
              record.sessionId,
              tsStr,
              tsStart,
              tsEnd,
              JSON.stringify(record.metadata),
            );
          } catch (ftsErr) {
            // FTS write failure is non-fatal — log and continue
            this.logger?.warn(
              `${TAG} [L1-upsert] FTS write failed (non-fatal) id=${recordId}: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
            );
          }
        }

        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
      this.logger?.debug?.(`${TAG} [L1-upsert] OK id=${recordId}${skipVec ? " (meta-only)" : ""}`);
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-upsert] FAILED (non-fatal) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Vector similarity search (cosine distance).
   * Returns top-k results sorted by similarity (highest first).
   *
   * **Fault-tolerant**: returns an empty array on any error (e.g. dimension
   * mismatch, corrupted DB) so callers can fall back to keyword search.
   */
  searchL1Vector(queryEmbedding: Float32Array, topK = 5): VectorSearchResult[] {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded) this.logger?.warn(`${TAG} [L1-search] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      // Over-retrieve because (a) legacy zero-vector placeholders may surface
      // with NULL/NaN distance and (b) a single record can now own MULTIPLE
      // chunk rows — without de-dup those would crowd out other records before
      // the topK trim.  We fetch (topK * chunk-fan-out + buffer) candidates and
      // collapse to the best (lowest-distance) chunk per record_id below.
      // NOTE: "AND distance IS NOT NULL" is NOT usable because vec0 does not
      // support that constraint — it causes an empty result set.
      const retrieveCount = topK * VectorStore.CHUNK_RECALL_FANOUT + VectorStore.ZERO_VEC_BUFFER;

      this.logger?.debug?.(
        `${TAG} [L1-search] START topK=${topK}, retrieveCount=${retrieveCount}, ` +
        `queryEmbeddingDims=${queryEmbedding.length}, ` +
        `queryNorm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
      );

      const rows = this.stmtSearchVec!.all(
        Buffer.from(queryEmbedding.buffer),
        retrieveCount,
      ) as Array<{ chunk_id: string; record_id: string; distance: number }>;

      this.logger?.debug?.(`${TAG} [L1-search] vec0 returned ${rows.length} candidate(s)`);

      if (rows.length === 0) return [];

      const results: VectorSearchResult[] = [];
      // De-dup by record_id: rows arrive ORDER BY distance ASC, so the first
      // chunk seen for a record is its best-scoring one — keep that, skip the rest.
      const seenRecords = new Set<string>();

      for (const { record_id, distance } of rows) {
        // sqlite-vec returns null distance for zero vectors (cosine undefined when ‖v‖=0).
        // Skip these — they are placeholder vectors from embedding-service-unavailable fallback.
        if (distance == null || Number.isNaN(distance)) {
          this.logger?.warn(
            `${TAG} [L1-search] record_id=${record_id} has null/NaN distance (likely zero vector) — skipping`,
          );
          continue;
        }

        // Collapse multiple chunks of the same record to a single result.
        if (seenRecords.has(record_id)) continue;
        seenRecords.add(record_id);

        const meta = this.stmtGetMeta.get(record_id) as
          | {
              content: string;
              type: string;
              priority: number;
              scene_name: string;
              session_key: string;
              session_id: string;
              timestamp_str: string;
              timestamp_start: string;
              timestamp_end: string;
              metadata_json: string;
            }
          | undefined;

        if (!meta) {
          this.logger?.warn(`${TAG} [L1-search] record_id=${record_id} has vector but NO metadata (orphan)`);
          continue;
        }

        const score = 1.0 - distance;
        this.logger?.debug?.(
          `${TAG} [L1-search] HIT id=${record_id}, distance=${distance.toFixed(4)}, score=${score.toFixed(4)}, ` +
          `type=${meta.type}, content="${meta.content.slice(0, 60)}..."`,
        );

        results.push({
          record_id,
          content: meta.content,
          type: meta.type,
          priority: meta.priority,
          scene_name: meta.scene_name,
          score,
          timestamp_str: meta.timestamp_str,
          timestamp_start: meta.timestamp_start,
          timestamp_end: meta.timestamp_end,
          session_key: meta.session_key,
          session_id: meta.session_id,
          metadata_json: meta.metadata_json,
        });
      }

      // Trim back to the caller's requested topK (we over-fetched above).
      const trimmed = results.slice(0, topK);
      this.logger?.info(
        `${TAG} [L1-search] DONE returning ${trimmed.length} result(s) (from ${results.length} valid, ${rows.length} raw)`,
      );
      return trimmed;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Delete a single record (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   */
  deleteL1(recordId: string): boolean {
    if (this.degraded) return false;
    try {
      this.db.exec("BEGIN");
      try {
        this.stmtDeleteMeta.run(recordId);
        if (this.vecTablesReady) this.stmtDeleteVec!.run(recordId);
        if (this.ftsAvailable) {
          try { this.stmtL1FtsDelete.run(recordId); } catch { /* non-fatal */ }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} delete failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Delete multiple records (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   */
  deleteL1Batch(recordIds: string[]): boolean {
    if (this.degraded) return false;
    if (recordIds.length === 0) return true;

    try {
      this.db.exec("BEGIN");
      try {
        for (const id of recordIds) {
          this.stmtDeleteMeta.run(id);
          if (this.vecTablesReady) this.stmtDeleteVec!.run(id);
          if (this.ftsAvailable) {
            try { this.stmtL1FtsDelete.run(id); } catch { /* non-fatal */ }
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteBatch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get the total number of L1 records in the store.
   *
   * **Fault-tolerant**: returns 0 on failure.
   * TTL cleanup by updated_time.
   *
   * Deletes expired rows from l1_records and matching vectors from l1_vec
   * in a single transaction to guarantee consistency.
   */
  deleteL1Expired(cutoffIso: string): number {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [deleteExpired] SKIPPED (degraded mode)`);
      return 0;
    }
    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM l1_records WHERE updated_time != '' AND updated_time < ?",
      ).get(cutoffIso) as { cnt: number } | undefined;
      const expiredCount = row?.cnt ?? 0;
      if (expiredCount <= 0) return 0;

      this.db.exec("BEGIN");
      try {
        if (this.vecTablesReady) {
          this.db.prepare(
            "DELETE FROM l1_vec WHERE updated_time != '' AND updated_time < ?",
          ).run(cutoffIso);
        }
        this.db.prepare(
          "DELETE FROM l1_records WHERE updated_time != '' AND updated_time < ?",
        ).run(cutoffIso);
        this.db.exec("COMMIT");
        return expiredCount;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL1ExpiredByUpdatedTime failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Get the total number of records in the store.
   */
  countL1(): number {
    if (this.degraded) return 0;
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM l1_records")
        .get() as { cnt: number };
      this.logger?.debug?.(`${TAG} [L1-count] total=${row.cnt}`);
      return row.cnt;
    } catch (err) {
      this.logger?.warn(
        `${TAG} count failed (non-fatal, returning 0): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Query L1 records with optional session and time filters.
   *
   * Uses the composite index `idx_l1_session_updated(session_id, updated_time)`
   * for efficient filtering. All timestamps are compared as UTC ISO 8601 strings.
   *
   * **Fault-tolerant**: returns an empty array on any error (degraded mode, DB issues).
   */
  queryL1Records(filter?: L1QueryFilter): L1RecordRow[] {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L1-query] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      const { sessionKey, sessionId, updatedAfter } = filter ?? {};

      let raw: Record<string, unknown>[];

      // Priority: sessionId > sessionKey (sessionId is more specific)
      if (sessionId && updatedAfter) {
        raw = this.stmtQueryBySessionIdSince.all(sessionId, updatedAfter) as Record<string, unknown>[];
      } else if (sessionId) {
        raw = this.stmtQueryBySessionId.all(sessionId) as Record<string, unknown>[];
      } else if (sessionKey && updatedAfter) {
        raw = this.stmtQueryBySessionKeySince.all(sessionKey, updatedAfter) as Record<string, unknown>[];
      } else if (sessionKey) {
        raw = this.stmtQueryBySessionKey.all(sessionKey) as Record<string, unknown>[];
      } else if (updatedAfter) {
        raw = this.stmtQueryAllSince.all(updatedAfter) as Record<string, unknown>[];
      } else {
        raw = this.stmtQueryAll.all() as Record<string, unknown>[];
      }

      // Runtime sanity check: verify first row has expected columns (guards against schema drift)
      if (raw.length > 0 && !("record_id" in raw[0] && "content" in raw[0])) {
        this.logger?.warn(
          `${TAG} [L1-query] Schema mismatch: first row missing expected columns. ` +
          `Got keys: [${Object.keys(raw[0]).join(", ")}]`,
        );
        return [];
      }

      const rows = raw as unknown as L1RecordRow[];

      this.logger?.info(
        `${TAG} [L1-query] filter={sessionKey=${sessionKey ?? "(all)"}, sessionId=${sessionId ?? "(all)"}, updatedAfter=${updatedAfter ?? "(none)"}}, ` +
        `returned ${rows.length} record(s)`,
      );
      return rows;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-query] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  // ── L0 operations ──────────────────────────────────

  /**
   * Write or update an L0 single-message record (metadata + vector).
   * Uses a manual transaction for atomicity.
   *
   * If `embedding` is `undefined` or a zero vector (all elements are 0), only
   * the metadata row (`l0_conversations`) is written — the vec0 table
   * (`l0_vec`) is left untouched.  This allows callers without an
   * EmbeddingService to still persist metadata + FTS without constructing a
   * throwaway zero-vector, and prevents placeholder zero vectors (from
   * embedding-service failures) from polluting KNN search results.
   *
   * **Fault-tolerant**: catches all errors internally, never throws.
   * Returns `true` on success, `false` on failure (logged as warning).
   */
  upsertL0(record: L0Record, embedding: Float32Array | Float32Array[] | undefined): boolean {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-upsert] SKIPPED (degraded mode) id=${record.id}`);
      return false;
    }
    try {
      // Normalize to N non-zero chunk vectors (single Float32Array → 1 chunk).
      const chunkVectors = VectorStore.toChunkVectors(embedding);
      const skipVec = chunkVectors.length === 0 || !this.vecTablesReady;

      this.logger?.debug?.(
        `${TAG} [L0-upsert] START id=${record.id}, session=${record.sessionKey}, role=${record.role}, ` +
        `text="${record.messageText.slice(0, 60)}..."` +
        (embedding
          ? `, chunks=${chunkVectors.length}` +
            `${skipVec ? " (no valid vectors or vec tables not ready — vec write will be skipped)" : ""}`
          : " (no embedding — metadata-only write)"),
      );

      this.db.exec("BEGIN");
      try {
        this.stmtL0UpsertMeta.run(
          record.id,
          record.sessionKey,
          record.sessionId,
          record.role,
          record.messageText,
          record.recordedAt,
          record.timestamp,
        );

        if (!skipVec) {
          // vec0 has no ON CONFLICT and a record may own N chunks → delete ALL
          // chunk rows for the record (by partition key), then insert one per chunk.
          this.stmtL0DeleteVec!.run(record.id);
          for (let i = 0; i < chunkVectors.length; i++) {
            this.stmtL0InsertVec!.run(
              VectorStore.chunkId(record.id, i),
              record.id,
              Buffer.from(chunkVectors[i].buffer),
              record.recordedAt,
            );
          }
        } else {
          this.logger?.debug?.(
            `${TAG} [L0-upsert] Skipping vec write (${embedding ? "no valid vectors / vec tables not ready" : "no embedding"}) id=${record.id}`,
          );
        }

        // Sync FTS5 (delete + re-insert to handle updates)
        if (this.ftsAvailable) {
          try {
            this.stmtL0FtsDelete.run(record.id);
            this.stmtL0FtsInsert.run(
              tokenizeForFts(record.messageText), // message_text — segmented for indexing
              record.messageText,                 // message_text_original — raw for display
              record.id,
              record.sessionKey,
              record.sessionId,
              record.role,
              record.recordedAt,
              record.timestamp,
            );
          } catch (ftsErr) {
            // FTS write failure is non-fatal — log and continue
            this.logger?.warn(
              `${TAG} [L0-upsert] FTS write failed (non-fatal) id=${record.id}: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
            );
          }
        }

        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
      this.logger?.debug?.(`${TAG} [L0-upsert] OK id=${record.id}${skipVec ? " (meta-only)" : ""}`);
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-upsert] FAILED (non-fatal) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Update ONLY the vector embedding for an existing L0 record.
   * The metadata row must already exist in l0_conversations (written by upsertL0).
   *
   * This is used by the background embedding task in auto-capture:
   *   1. upsertL0() writes metadata + FTS synchronously (no embedding)
   *   2. Background task calls embedChunks() then updateL0Embedding() for each record
   *
   * Accepts either a single Float32Array (1 chunk) or an array of chunk vectors;
   * delete-all-chunks-then-insert-N keeps the operation idempotent.
   *
   * **Fault-tolerant**: catches all errors internally, never throws.
   * Returns `true` on success, `false` on failure.
   */
  updateL0Embedding(recordId: string, embedding: Float32Array | Float32Array[]): boolean {
    if (this.degraded || !this.vecTablesReady) {
      return false;
    }
    const chunkVectors = VectorStore.toChunkVectors(embedding);
    if (chunkVectors.length === 0) {
      this.logger?.debug?.(`${TAG} [L0-update-embedding] Skipping (no valid vectors) for ${recordId}`);
      return false;
    }
    try {
      // Look up recorded_at from metadata for the vec0 row
      const meta = this.stmtL0GetMeta.get(recordId) as { recorded_at: string } | undefined;
      if (!meta) {
        this.logger?.warn(`${TAG} [L0-update-embedding] No metadata found for ${recordId}, skipping`);
        return false;
      }

      this.db.exec("BEGIN");
      try {
        this.stmtL0DeleteVec!.run(recordId);
        for (let i = 0; i < chunkVectors.length; i++) {
          this.stmtL0InsertVec!.run(
            VectorStore.chunkId(recordId, i),
            recordId,
            Buffer.from(chunkVectors[i].buffer),
            meta.recorded_at,
          );
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-update-embedding] FAILED (non-fatal) id=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Vector similarity search on L0 individual messages (cosine distance).
   * Returns top-k results sorted by similarity (highest first).
   *
   * **Fault-tolerant**: returns an empty array on any error.
   */
  searchL0Vector(queryEmbedding: Float32Array, topK = 5): L0VectorSearchResult[] {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded) this.logger?.warn(`${TAG} [L0-search] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      // Over-retrieve because (a) legacy zero-vector placeholders surface with
      // NULL/NaN distance and (b) a record can own MULTIPLE chunk rows.  We
      // fetch (topK * chunk-fan-out + buffer) and collapse to the best chunk per
      // record_id below.
      // NOTE: "AND distance IS NOT NULL" is NOT usable because vec0 does not
      // support that constraint — it causes an empty result set.
      const retrieveCount = topK * VectorStore.CHUNK_RECALL_FANOUT + VectorStore.ZERO_VEC_BUFFER;

      this.logger?.debug?.(
        `${TAG} [L0-search] START topK=${topK}, retrieveCount=${retrieveCount}, ` +
        `queryEmbeddingDims=${queryEmbedding.length}, ` +
        `queryNorm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
      );

      const rows = this.stmtL0SearchVec!.all(
        Buffer.from(queryEmbedding.buffer),
        retrieveCount,
      ) as Array<{ chunk_id: string; record_id: string; distance: number }>;

      this.logger?.debug?.(`${TAG} [L0-search] vec0 returned ${rows.length} candidate(s)`);

      if (rows.length === 0) return [];

      const results: L0VectorSearchResult[] = [];
      // De-dup by record_id: rows arrive ORDER BY distance ASC → first chunk of
      // a record is its best-scoring one; keep that, skip the rest.
      const seenRecords = new Set<string>();

      for (const { record_id, distance } of rows) {
        // sqlite-vec returns null distance for zero vectors (cosine undefined when ‖v‖=0).
        // Skip these — they are placeholder vectors from embedding-service-unavailable fallback.
        if (distance == null || Number.isNaN(distance)) {
          this.logger?.warn(
            `${TAG} [L0-search] record_id=${record_id} has null/NaN distance (likely zero vector) — skipping`,
          );
          continue;
        }

        // Collapse multiple chunks of the same record to a single result.
        if (seenRecords.has(record_id)) continue;
        seenRecords.add(record_id);

        const meta = this.stmtL0GetMeta.get(record_id) as
          | {
              session_key: string;
              session_id: string;
              role: string;
              message_text: string;
              recorded_at: string;
              timestamp: number;
            }
          | undefined;

        if (!meta) {
          this.logger?.warn(`${TAG} [L0-search] record_id=${record_id} has vector but NO metadata (orphan)`);
          continue;
        }

        const score = 1.0 - distance;
        this.logger?.debug?.(
          `${TAG} [L0-search] HIT id=${record_id}, distance=${distance.toFixed(4)}, score=${score.toFixed(4)}, ` +
          `role=${meta.role}, session=${meta.session_key}, text="${meta.message_text.slice(0, 60)}..."`,
        );

        results.push({
          record_id,
          session_key: meta.session_key,
          session_id: meta.session_id,
          role: meta.role,
          message_text: meta.message_text,
          score,
          recorded_at: meta.recorded_at,
          timestamp: meta.timestamp ?? 0,
        });
      }

      // Trim back to the caller's requested topK (we over-fetched above).
      const trimmed = results.slice(0, topK);
      this.logger?.info(
        `${TAG} [L0-search] DONE returning ${trimmed.length} result(s) (from ${results.length} valid, ${rows.length} raw)`,
      );
      return trimmed;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Delete a single L0 record (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   */
  deleteL0(recordId: string): boolean {
    if (this.degraded) return false;
    try {
      this.db.exec("BEGIN");
      try {
        this.stmtL0DeleteMeta.run(recordId);
        if (this.vecTablesReady) this.stmtL0DeleteVec!.run(recordId);
        if (this.ftsAvailable) {
          try { this.stmtL0FtsDelete.run(recordId); } catch { /* non-fatal */ }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL0 failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * TTL cleanup by recorded_at (ISO string) for L0 records.
   *
   * Deletes expired rows from l0_conversations and matching vectors from l0_vec
   * in a single transaction to guarantee consistency.
   */
  deleteL0Expired(cutoffIso: string): number {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [deleteExpiredL0] SKIPPED (degraded mode)`);
      return 0;
    }

    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM l0_conversations WHERE recorded_at != '' AND recorded_at < ?",
      ).get(cutoffIso) as { cnt: number } | undefined;
      const expiredCount = row?.cnt ?? 0;
      if (expiredCount <= 0) return 0;

      this.db.exec("BEGIN");
      try {
        if (this.vecTablesReady) {
          this.db.prepare(
            "DELETE FROM l0_vec WHERE recorded_at != '' AND recorded_at < ?",
          ).run(cutoffIso);
        }
        this.db.prepare(
          "DELETE FROM l0_conversations WHERE recorded_at != '' AND recorded_at < ?",
        ).run(cutoffIso);
        this.db.exec("COMMIT");
        return expiredCount;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL0ExpiredByRecordedAt failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Get the total number of L0 message records in the store.
   *
   * **Fault-tolerant**: returns 0 on failure.
   */
  countL0(): number {
    if (this.degraded) return 0;
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM l0_conversations")
        .get() as { cnt: number };
      this.logger?.debug?.(`${TAG} [L0-count] total=${row.cnt}`);
      return row.cnt;
    } catch (err) {
      this.logger?.warn(
        `${TAG} countL0 failed (non-fatal, returning 0): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  // ── Re-index operations ──────────────────────────────────

  /**
   * Get all L1 record texts for re-embedding.
   * Returns record_id → content pairs.
   */
  getAllL1Texts(): Array<{ record_id: string; content: string; updated_time: string }> {
    if (this.degraded) return [];
    try {
      return this.db
        .prepare("SELECT record_id, content, updated_time FROM l1_records")
        .all() as Array<{ record_id: string; content: string; updated_time: string }>;
    } catch (err) {
      this.logger?.warn(
        `${TAG} getAllL1Texts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Get all L0 message texts for re-embedding.
   * Returns record_id → message_text/recorded_at tuples.
   */
  getAllL0Texts(): Array<{ record_id: string; message_text: string; recorded_at: string }> {
    if (this.degraded) return [];
    try {
      return this.db
        .prepare("SELECT record_id, message_text, recorded_at FROM l0_conversations")
        .all() as Array<{ record_id: string; message_text: string; recorded_at: string }>;
    } catch (err) {
      this.logger?.warn(
        `${TAG} getAllL0Texts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Get all KB owner texts (entities/facts/events) for re-embedding into kb_vec.
   * Source of truth = `kb_fts.content_original` — the exact text that was indexed
   * for recall — so a kb_vec rebuild mirrors what the normal write path embedded.
   * kb_fts is dimension-independent, so it survives an embedding-provider change.
   */
  getAllKbTexts(): Array<{ owner_id: string; owner_kind: string; content: string; updated_time: string }> {
    if (this.degraded || !this.kbFtsAvailable) return [];
    try {
      return this.db
        .prepare("SELECT owner_id, owner_kind, content_original AS content, updated_time FROM kb_fts")
        .all() as Array<{ owner_id: string; owner_kind: string; content: string; updated_time: string }>;
    } catch (err) {
      this.logger?.warn(
        `${TAG} getAllKbTexts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Re-embed all existing L1 and L0 texts with a new embedding function.
   *
   * This is called after `init()` returns `needsReindex: true` — the vector
   * tables have already been dropped and re-created with the correct dimensions.
   * This method reads every text from the metadata tables and writes fresh
   * embeddings into the new vector tables.
   *
   * @param embedFn  A function that converts text → one or more chunk vectors.
   *   Returning `Float32Array[]` writes one vector per chunk against the same
   *   record id (long texts are indexed in full); a single `Float32Array` is
   *   treated as one chunk.  Delete-all-chunks-then-insert-N makes re-runs
   *   IDEMPOTENT.
   * @param onProgress  Optional callback for progress reporting.
   */
  /**
   * Stamp a memory unit's provenance at write time by creating its
   * memory_lifecycle row WITH the stamp (idempotent: if the row already exists it
   * is left untouched, so consolidation's later ensureLifecycle never clobbers it).
   * Off the critical path: failures are swallowed + logged, never thrown.
   */
  stampProvenance(
    ownerId: string,
    ownerKind: "fact" | "event",
    provenance: ProvenanceStamp,
    now: string,
    namespace = "default",
  ): void {
    try {
      ensureLifecycle(this.db, {
        ownerId,
        ownerKind,
        now,
        namespace,
        provenance: JSON.parse(serializeProvenance(provenance)),
      });
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][provenance] stamp failed for ${ownerKind} ${ownerId} (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Confirm a memory as ground truth (Lorenzo said so). Flips its provenance to
   * trusted + writes the audit trail. When a `factId` is given, raises that fact's
   * confidence; when a `supersededFactId` is given, closes that older uncertain
   * fact (sets superseded_by + valid_to so it leaves the HEAD set). One transaction
   * (BEGIN/COMMIT/ROLLBACK via prepared statements — same effect as reindexAll).
   */
  confirmMemory(params: {
    ownerId: string;
    ownerKind: "fact" | "event";
    now: string;
    factId?: string;
    confidence?: number;
    supersededFactId?: string;
  }): void {
    try {
      this.db.prepare("BEGIN").run();
      try {
        confirmProvenance(this.db, {
          ownerId: params.ownerId,
          ownerKind: params.ownerKind,
          now: params.now,
        });
        if (params.factId) {
          this.db
            .prepare("UPDATE facts SET confidence = ?, updated_time = ? WHERE id = ?")
            .run(params.confidence ?? 0.99, params.now, params.factId);
        }
        if (params.supersededFactId) {
          this.db
            .prepare(
              "UPDATE facts SET superseded_by = ?, superseded_at = ?, valid_to = ? WHERE id = ?",
            )
            .run(params.factId ?? params.ownerId, params.now, params.now, params.supersededFactId);
        }
        this.db.prepare("COMMIT").run();
      } catch (txErr) {
        try { this.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
        throw txErr;
      }
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][provenance] confirmMemory failed for ${params.ownerKind} ${params.ownerId} ` +
          `(non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Carry Idea 5's distinctiveness verdict onto a memory's lifecycle `salience`
   * (Pilastro C bridge), so distinctiveness-aware decay protects the peak.
   * Delegates to the monotonic stampSalience primitive. Off the critical path:
   * failures are logged, never thrown.
   */
  stampSalience(params: {
    ownerId: string;
    ownerKind: "fact" | "event";
    salience: number;
    now: string;
  }): void {
    try {
      kbStampSalience(this.db, {
        ownerId: params.ownerId,
        ownerKind: params.ownerKind,
        salience: params.salience,
        now: params.now,
      });
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][cornerstones] stampSalience failed for ${params.ownerKind} ${params.ownerId} ` +
          `(non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Tombstone a memory as rejected (Lorenzo said NO to the gate question). Marks
   * its provenance `rejected` (kept, never hard-deleted) + writes the audit trail.
   * When a `factId` is given, drops that fact from the HEAD set (valid_to = now) so
   * it stops driving action while the row itself survives. One transaction.
   */
  rejectMemory(params: {
    ownerId: string;
    ownerKind: "fact" | "event";
    now: string;
    factId?: string;
  }): void {
    try {
      this.db.prepare("BEGIN").run();
      try {
        rejectProvenance(this.db, {
          ownerId: params.ownerId,
          ownerKind: params.ownerKind,
          now: params.now,
        });
        if (params.factId) {
          this.db
            .prepare("UPDATE facts SET valid_to = ? WHERE id = ?")
            .run(params.now, params.factId);
        }
        this.db.prepare("COMMIT").run();
      } catch (txErr) {
        try { this.db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
        throw txErr;
      }
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][provenance] rejectMemory failed for ${params.ownerKind} ${params.ownerId} ` +
          `(non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Mark a memory as pending the ask-loop (Phase 2 gate). Off the critical path:
   * failures are swallowed + logged. Never re-gates an already pending/rejected unit.
   */
  gateMemory(params: {
    ownerId: string;
    ownerKind: "fact" | "event";
    now: string;
    stakes: "none" | "high";
    stakesDomain:
      | "payment" | "credential" | "destructive" | "prod" | "exfil" | "vision" | null;
  }): void {
    try {
      markGatePending(this.db, {
        ownerId: params.ownerId,
        ownerKind: params.ownerKind,
        now: params.now,
        stakes: params.stakes,
        stakesDomain: params.stakesDomain,
      });
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][provenance] gateMemory failed for ${params.ownerKind} ${params.ownerId} ` +
          `(non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Recall-time stakes gate (Phase 2 wiring). For each recalled unit, classify
   * stakes and — if it is unverified, high-stakes, and not yet handled — mark it
   * pending the ask-loop. This NEVER removes a unit from injection (the soul stays
   * intact: trust gates ACTION, not injection); it only writes the gate state as a
   * side effect. Best-effort: off the critical path, each unit isolated, all errors
   * swallowed + logged. `eventType`/`distinctiveness` are optional — when present
   * (future recall plumbing) the vision branch activates with no change here.
   */
  gateRecalledUnits(
    units: ReadonlyArray<{
      owner_id: string;
      owner_kind: "fact" | "event";
      text: string;
      eventType?: string;
      distinctiveness?: number;
    }>,
    now: string,
  ): void {
    for (const u of units) {
      try {
        const stakes = classifyStakes({
          content: u.text,
          eventType: u.eventType,
          distinctiveness: u.distinctiveness,
        });
        if (stakes.stakes !== "high") continue;
        const life = getLifecycle(this.db, u.owner_id, u.owner_kind);
        if (!life) continue;
        const prov = parseProvenance(life.provenance_json);
        if (!shouldGate({ trust: prov.trust, stakes: stakes.stakes, gateState: gateStateOf(prov) })) {
          continue;
        }
        this.gateMemory({
          ownerId: u.owner_id,
          ownerKind: u.owner_kind,
          now,
          stakes: stakes.stakes,
          stakesDomain: stakes.stakes_domain,
        });
      } catch (err) {
        this.logger?.warn?.(
          `[memory-tdai][provenance] gateRecalledUnits failed for ${u.owner_kind} ${u.owner_id} ` +
            `(non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Surface memories pending the ask-loop (gate_state = pending_confirmation),
   * newest first, with their display text + origin + stakes domain. The Phase 3
   * interrupt block is rendered from these. Off the critical path: on any failure
   * returns []. Fact text is rendered "attribute: value"; event text is the event.
   */
  getPendingAsks(limit = 10): Array<{
    owner_id: string;
    owner_kind: "fact" | "event";
    text: string;
    origin: import("../kb/provenance.js").ProvenanceOrigin;
    stakes_domain: import("../kb/provenance.js").StakesDomain | null;
  }> {
    try {
      const rows = this.db
        .prepare(
          `SELECT owner_id, owner_kind, provenance_json
             FROM memory_lifecycle
            WHERE json_extract(provenance_json, '$.gate_state') = 'pending_confirmation'
            ORDER BY updated_time DESC
            LIMIT ?`,
        )
        .all(Math.max(1, Math.min(limit, 50))) as Array<{
        owner_id: string;
        owner_kind: string;
        provenance_json: string;
      }>;

      const out: Array<{
        owner_id: string;
        owner_kind: "fact" | "event";
        text: string;
        origin: import("../kb/provenance.js").ProvenanceOrigin;
        stakes_domain: import("../kb/provenance.js").StakesDomain | null;
      }> = [];
      for (const r of rows) {
        const kind = r.owner_kind === "fact" ? "fact" : "event";
        const prov = parseProvenance(r.provenance_json);
        let text = "";
        if (kind === "event") {
          const ev = this.db.prepare("SELECT text FROM events WHERE id = ?").get(r.owner_id) as
            | { text: string }
            | undefined;
          text = ev?.text ?? "";
        } else {
          const f = this.db
            .prepare("SELECT attribute, value FROM facts WHERE id = ?")
            .get(r.owner_id) as { attribute: string; value: string } | undefined;
          text = f ? `${f.attribute}: ${f.value}` : "";
        }
        if (!text) continue;
        out.push({
          owner_id: r.owner_id,
          owner_kind: kind,
          text,
          origin: prov.origin,
          stakes_domain: prov.stakes_domain ?? null,
        });
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][provenance] getPendingAsks failed (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Grounded Trust Phase 4 (learning): the keys of recalled units that Lorenzo has
   * REJECTED, so the recall path can suppress them from injection — a tombstoned
   * memory must never drive action again. Keys are "ownerKind:ownerId". Best-effort:
   * on error returns an empty set (fail-open = show the memory, never break recall).
   * Facts are already dropped from HEAD by rejectMemory (valid_to); this also covers
   * append-only events, which have no validity window.
   */
  rejectedOwnerKeys(
    units: ReadonlyArray<{ owner_id: string; owner_kind: "fact" | "event" }>,
  ): Set<string> {
    const rejected = new Set<string>();
    try {
      for (const u of units) {
        const life = getLifecycle(this.db, u.owner_id, u.owner_kind);
        if (!life) continue;
        if (gateStateOf(parseProvenance(life.provenance_json)) === "rejected") {
          rejected.add(`${u.owner_kind}:${u.owner_id}`);
        }
      }
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][provenance] rejectedOwnerKeys failed (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return rejected;
  }

  /**
   * Associative recall (the beating heart): from the entities a query activated
   * (the recall seeds), let activation SPREAD over the entity graph (`relations`,
   * weighted by `support`) so memories the query never named SURFACE because they
   * are strongly connected to an active one — converging when reached from several
   * seeds. Returns one representative memory (top HEAD fact, else latest event) per
   * newly-activated entity, ordered strongest-first. Best-effort, bounded, off the
   * critical path: any failure returns [] (associative recall is purely additive).
   */
  associativeExpand(
    seedEntityIds: string[],
    opts?: { hops?: number; maxNodes?: number; namespace?: string },
  ): Array<{
    owner_id: string;
    owner_kind: "fact" | "event";
    text: string;
    entity_id: string;
    activation: number;
  }> {
    try {
      const seeds = (seedEntityIds ?? []).filter(Boolean);
      if (seeds.length === 0) return [];
      const namespace = opts?.namespace ?? "default";

      // Lazy, memoized adjacency over LIVE edges (valid_to IS NULL), weighted by support.
      const memo = new Map<string, WeightedNeighbor[]>();
      const neighborsOf = (id: string): WeightedNeighbor[] => {
        let n = memo.get(id);
        if (!n) {
          n = kbQueryRelationsForEntity(this.db, id)
            .filter((r) => r.valid_to == null && r.namespace === namespace)
            .map((r) => ({
              id: r.src_entity_id === id ? r.dst_entity_id : r.src_entity_id,
              weight: r.support > 0 ? r.support : 1,
            }))
            .filter((x) => x.id && x.id !== id);
          memo.set(id, n);
        }
        return n;
      };

      const activated = spreadActivation(
        seeds.map((id) => ({ id, activation: 1 })),
        neighborsOf,
        { hops: opts?.hops ?? 2, maxNodes: opts?.maxNodes ?? 6 },
      );

      const out: Array<{
        owner_id: string;
        owner_kind: "fact" | "event";
        text: string;
        entity_id: string;
        activation: number;
      }> = [];
      for (const [entityId, activation] of activated) {
        // Pick the SALIENT memory, not a noise metric. Internal counters
        // (line_count, action_phase, char_count, …) pollute injection — skip them and
        // take the most-confident real fact; else fall back to the latest event.
        const facts = kbQueryHeadFacts(this.db, entityId)
          .filter((f) => !isNoiseAttribute(f.attribute))
          .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
        if (facts.length > 0) {
          const f = facts[0]!;
          out.push({ owner_id: f.id, owner_kind: "fact", text: `${f.attribute}: ${f.value}`, entity_id: entityId, activation });
          continue;
        }
        const events = kbQueryEventsForEntity(this.db, entityId, namespace, 1);
        if (events.length > 0) {
          out.push({ owner_id: events[0]!.id, owner_kind: "event", text: events[0]!.text, entity_id: entityId, activation });
        }
      }
      return out;
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][assoc] associativeExpand failed (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * The dense associative edge layer (for Implicit Priming + spreading activation),
   * restricted to a candidate entity set: co-occurrence edges (entities sharing an
   * event — Hebbian "fire together, wire together", from `events.entities_json`)
   * UNIONED with explicit `relations`. Co-occurrence densifies a sparse explicit
   * graph (measured 0.35 rel/entity) so priming actually fires. Edge weight = shared
   * events (+ relation support). Bounded to the candidate set; best-effort → {} on error.
   */
  candidateAdjacency(
    entityIds: string[],
    namespace = "default",
  ): Map<string, WeightedNeighbor[]> {
    try {
      const cand = new Set((entityIds ?? []).filter(Boolean));
      if (cand.size === 0) return new Map();
      const adj = new Map<string, Map<string, number>>();
      const addEdge = (a: string, b: string, w: number): void => {
        if (a === b || !cand.has(a) || !cand.has(b)) return;
        let m = adj.get(a);
        if (!m) { m = new Map(); adj.set(a, m); }
        m.set(b, (m.get(b) ?? 0) + w);
      };

      // 1. Co-occurrence from events that mention a candidate entity.
      const ids = [...cand];
      const likeClauses = ids.map(() => "entities_json LIKE ?").join(" OR ");
      const rows = this.db
        .prepare(`SELECT entities_json FROM events WHERE namespace = ? AND (${likeClauses})`)
        .all(namespace, ...ids.map((id) => `%${id}%`)) as Array<{ entities_json: string }>;
      for (const r of rows) {
        let ents: string[] = [];
        try {
          const parsed = JSON.parse(r.entities_json);
          if (Array.isArray(parsed)) ents = parsed.filter((e): e is string => typeof e === "string");
        } catch { /* skip malformed */ }
        const inCand = ents.filter((e) => cand.has(e));
        for (let i = 0; i < inCand.length; i++) {
          for (let j = i + 1; j < inCand.length; j++) {
            addEdge(inCand[i]!, inCand[j]!, 1);
            addEdge(inCand[j]!, inCand[i]!, 1);
          }
        }
      }

      // 2. Explicit live relations (union).
      for (const id of cand) {
        for (const rel of kbQueryRelationsForEntity(this.db, id)) {
          if (rel.valid_to != null || rel.namespace !== namespace) continue;
          const other = rel.src_entity_id === id ? rel.dst_entity_id : rel.src_entity_id;
          const w = rel.support > 0 ? rel.support : 1;
          addEdge(id, other, w);
          addEdge(other, id, w);
        }
      }

      const out = new Map<string, WeightedNeighbor[]>();
      for (const [id, m] of adj) out.set(id, [...m].map(([nid, w]) => ({ id: nid, weight: w })));
      return out;
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][assoc] candidateAdjacency failed (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return new Map();
    }
  }

  async reindexAll(
    embedFn: (text: string) => Promise<Float32Array | Float32Array[]>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
    opts?: { resume?: boolean },
  ): Promise<{ l1Count: number; l0Count: number }> {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded) this.logger?.warn(`${TAG} reindexAll skipped: VectorStore is in degraded mode`);
      return { l1Count: 0, l0Count: 0 };
    }

    // Resume mode: skip records that ALREADY have ≥1 chunk vector, so a reindex
    // killed mid-run can be re-run and only embeds the still-missing tail (each
    // run advances the frontier; progress accumulates). Building the skip-set is
    // best-effort — if the DISTINCT query fails it degrades to a full reindex.
    const buildEmbeddedSet = (table: "l1_vec" | "l0_vec"): Set<string> | null => {
      if (!opts?.resume) return null;
      try {
        const rows = this.db.prepare(`SELECT DISTINCT record_id FROM ${table}`).all() as Array<{ record_id: string }>;
        const set = new Set(rows.map((r) => r.record_id));
        this.logger?.info(`${TAG} reindex resume: ${set.size} ${table} records already embedded → will be skipped`);
        return set;
      } catch (err) {
        this.logger?.warn?.(`${TAG} reindex resume: could not read embedded ${table} (full reindex): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    };

    try {
      // ── Re-embed L1 ──
      const l1Rows = this.getAllL1Texts();
      const embeddedL1 = buildEmbeddedSet("l1_vec");
      let l1Done = 0;
      for (const { record_id, content, updated_time } of l1Rows) {
        if (embeddedL1?.has(record_id)) { l1Done++; onProgress?.(l1Done, l1Rows.length, "L1"); continue; }
        try {
          const chunkVectors = VectorStore.toChunkVectors(await embedFn(content));
          // Wrap delete+insert in a transaction to prevent orphan vectors.
          // Delete-all-chunks-then-insert-N → idempotent on re-run.
          this.db.exec("BEGIN");
          try {
            this.stmtDeleteVec!.run(record_id);
            for (let i = 0; i < chunkVectors.length; i++) {
              this.stmtInsertVec!.run(
                VectorStore.chunkId(record_id, i),
                record_id,
                Buffer.from(chunkVectors[i].buffer),
                updated_time,
              );
            }
            this.db.exec("COMMIT");
          } catch (txErr) {
            try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
            throw txErr;
          }
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} reindex L1 skip ${record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        l1Done++;
        onProgress?.(l1Done, l1Rows.length, "L1");
      }

      // ── Re-embed L0 ──
      const l0Rows = this.getAllL0Texts();
      const embeddedL0 = buildEmbeddedSet("l0_vec");
      let l0Done = 0;
      for (const { record_id, message_text, recorded_at } of l0Rows) {
        if (embeddedL0?.has(record_id)) { l0Done++; onProgress?.(l0Done, l0Rows.length, "L0"); continue; }
        try {
          const chunkVectors = VectorStore.toChunkVectors(await embedFn(message_text));
          // Wrap delete+insert in a transaction to prevent orphan vectors.
          this.db.exec("BEGIN");
          try {
            this.stmtL0DeleteVec!.run(record_id);
            for (let i = 0; i < chunkVectors.length; i++) {
              this.stmtL0InsertVec!.run(
                VectorStore.chunkId(record_id, i),
                record_id,
                Buffer.from(chunkVectors[i].buffer),
                recorded_at,
              );
            }
            this.db.exec("COMMIT");
          } catch (txErr) {
            try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
            throw txErr;
          }
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} reindex L0 skip ${record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        l0Done++;
        onProgress?.(l0Done, l0Rows.length, "L0");
      }

      this.logger?.info(
        `${TAG} Reindex complete: L1=${l1Done}/${l1Rows.length}, L0=${l0Done}/${l0Rows.length}`,
      );

      return { l1Count: l1Done, l0Count: l0Done };
    } catch (err) {
      this.logger?.error(
        `${TAG} reindexAll failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { l1Count: 0, l0Count: 0 };
    }
  }

  /**
   * Re-embed the KB recall layer (`kb_vec`) from `kb_fts`, mirroring
   * {@link reindexAll} for L0/L1. Needed because a dimension/model change drops+
   * recreates `kb_vec` EMPTY ({@link dropVectorTables}), and `reindexAll` only
   * covers L0/L1 — without this, kb semantic recall (recall.source=kb) stays
   * blank after an embedding switch. Idempotent: {@link upsertKbVector} is
   * delete-then-insert per owner. Per-owner errors are swallowed so one bad row
   * never aborts the whole rebuild. Off any conversation path (offline tool).
   */
  async reindexKb(
    embedFn: (text: string) => Promise<Float32Array | Float32Array[]>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ kbCount: number }> {
    if (this.degraded || !this.kbVecReady) {
      this.logger?.warn(`${TAG} reindexKb skipped: kb_vec not ready`);
      return { kbCount: 0 };
    }
    const rows = this.getAllKbTexts();
    let done = 0;
    for (const { owner_id, owner_kind, content, updated_time } of rows) {
      try {
        if (content && content.trim().length > 0) {
          this.upsertKbVector(owner_id, owner_kind, await embedFn(content), updated_time);
        }
      } catch (err) {
        this.logger?.warn?.(
          `${TAG} reindexKb skip ${owner_kind} ${owner_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      done++;
      onProgress?.(done, rows.length);
    }
    this.logger?.info(`${TAG} KB reindex complete: ${done}/${rows.length} owners`);
    return { kbCount: done };
  }

  // ── L0 query operations (for L1 runner) ──────────────────────────────────

  /**
   * Query L0 messages for a given session key, optionally filtered by recorded_at cursor.
   * Returns messages ordered by recorded_at ASC (chronological write order).
   *
   * Used by L1 runner to read L0 data from DB instead of JSONL files.
   */
  queryL0ForL1(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
    afterRowId = 0,
  ): Array<{
    record_id: string;
    session_key: string;
    session_id: string;
    role: string;
    message_text: string;
    recorded_at: string;
    timestamp: number;
    rowid: number;
  }> {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-query] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      let rows: Array<Record<string, unknown>>;
      // BOTH paths now read OLDEST-first (ASC) so a LIMIT-bounded read always
      // returns the OLDEST un-extracted window and never skips messages:
      //  - incremental (cursor>0): rows AFTER the cursor, oldest-first;
      //  - cold-start (cursor=0/falsy): the OLDEST N for the session.
      // Why cold-start must be ASC too: the runner advances the cursor to the
      // newest message it read. A DESC (newest-N) cold-start read would skip
      // every message older than the newest N forever. ASC lets paging +
      // per-window cursor advancement walk the whole backlog across triggers.
      const incremental = Boolean(afterRecordedAtMs && afterRecordedAtMs > 0);
      if (incremental) {
        // Convert epoch ms to ISO string for recorded_at comparison. The tie
        // clause `(recorded_at = iso AND rowid > afterRowId)` pages within a
        // same-recorded_at block (the chat-backfill case).
        const afterRecordedAtIso = new Date(afterRecordedAtMs!).toISOString();
        rows = this.stmtL0QueryAfterAsc.all(sessionKey, afterRecordedAtIso, afterRecordedAtIso, afterRowId, limit) as Array<Record<string, unknown>>;
      } else {
        rows = this.stmtL0QueryAllAsc.all(sessionKey, limit) as Array<Record<string, unknown>>;
      }

      this.logger?.info(
        `${TAG} [L0-query] session=${sessionKey}, afterRecordedAtMs=${afterRecordedAtMs ?? "(all)"}, ` +
        `limit=${limit}, order=ASC, returned ${rows.length} row(s)`,
      );

      const mapped = rows.map((r) => ({
        record_id: r.record_id as string,
        session_key: r.session_key as string,
        session_id: (r.session_id as string) || "",
        role: r.role as string,
        message_text: r.message_text as string,
        recorded_at: (r.recorded_at as string) || "",
        timestamp: (r.timestamp as number) || 0,
        rowid: (r._rowid as number) || 0,
      }));
      // Both paths are already chronological (ASC) — return as-is.
      return mapped;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Query L0 messages for a given session key, grouped by session_id.
   * Each group's messages are in chronological order (recorded_at ASC).
   * Groups are sorted by earliest message timestamp.
   *
   * Used by L1 runner to replace readConversationMessagesGroupedBySessionId().
   */
  queryL0GroupedBySessionId(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
    afterRowId = 0,
  ): Array<{ sessionId: string; messages: Array<{ id: string; role: string; content: string; timestamp: number; recordedAtMs: number; rowid: number }> }> {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-query-grouped] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      const rows = this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit, afterRowId);

      // Group by session_id
      const groupMap = new Map<string, Array<{ id: string; role: string; content: string; timestamp: number; recordedAtMs: number; rowid: number }>>();
      for (const row of rows) {
        const sid = row.session_id || "";
        let group = groupMap.get(sid);
        if (!group) {
          group = [];
          groupMap.set(sid, group);
        }
        group.push({
          id: row.record_id,
          role: row.role,
          content: row.message_text,
          timestamp: row.timestamp,
          recordedAtMs: row.recorded_at ? Date.parse(row.recorded_at) || 0 : 0,
          rowid: row.rowid,
        });
      }

      // Convert to array, sorted by earliest message timestamp
      const groups: Array<{ sessionId: string; messages: Array<{ id: string; role: string; content: string; timestamp: number; recordedAtMs: number; rowid: number }> }> = [];
      for (const [sessionId, messages] of groupMap) {
        if (messages.length > 0) {
          groups.push({ sessionId, messages });
        }
      }
      groups.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);

      this.logger?.info(
        `${TAG} [L0-query-grouped] session=${sessionKey}, afterRecordedAtMs=${afterRecordedAtMs ?? "(all)"}, ` +
        `${rows.length} messages across ${groups.length} group(s)`,
      );

      return groups;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query-grouped] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── Cursor-based pagination for migration ──────────────────

  /**
   * Read a page of L1 records using primary key cursor.
   * Returns rows with `record_id > afterId`, ordered by PK, limited to `pageSize`.
   * Pass `""` as `afterId` for the first page.
   */
  queryL1RecordsCursor(afterId: string, pageSize: number): L1RecordRow[] {
    if (this.degraded) return [];
    try {
      return this.stmtL1QueryMigrationCursor.all(afterId, pageSize) as unknown as L1RecordRow[];
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-query-cursor] FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Read a page of L0 records using primary key cursor.
   * Returns rows with `record_id > afterId`, ordered by PK, limited to `pageSize`.
   * Pass `""` as `afterId` for the first page.
   */
  queryL0RecordsCursor(afterId: string, pageSize: number): L0RecordRow[] {
    if (this.degraded) return [];
    try {
      return this.stmtL0QueryMigrationCursor.all(afterId, pageSize) as unknown as L0RecordRow[];
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query-cursor] FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── FTS5 search operations ──────────────────────────────────

  /**
   * Whether FTS5 full-text search is available.
   * When `false`, callers should skip keyword-based recall entirely.
   */
  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  /**
   * FTS5 keyword search on L1 records.
   * Returns top-`limit` results sorted by BM25 relevance (highest first).
   *
   * @param ftsQuery  A pre-built FTS5 MATCH expression (from `buildFtsQuery()`).
   * @param limit     Maximum number of results to return.
   *
   * **Fault-tolerant**: returns an empty array on any error.
   */
  searchL1Fts(ftsQuery: string, limit = 20): FtsSearchResult[] {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      const rows = this.stmtL1FtsSearch.all(ftsQuery, limit) as Array<{
        record_id: string;
        content: string;
        type: string;
        priority: number;
        scene_name: string;
        session_key: string;
        session_id: string;
        timestamp_str: string;
        timestamp_start: string;
        timestamp_end: string;
        metadata_json: string;
        rank: number;
      }>;

      return rows.map((r) => ({
        record_id: r.record_id,
        content: r.content,
        type: r.type,
        priority: r.priority,
        scene_name: r.scene_name,
        score: bm25RankToScore(r.rank),
        timestamp_str: r.timestamp_str,
        timestamp_start: r.timestamp_start,
        timestamp_end: r.timestamp_end,
        session_key: r.session_key,
        session_id: r.session_id,
        metadata_json: r.metadata_json,
      }));
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-fts-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * FTS5 keyword search on L0 conversation messages.
   * Returns top-`limit` results sorted by BM25 relevance (highest first).
   *
   * @param ftsQuery  A pre-built FTS5 MATCH expression (from `buildFtsQuery()`).
   * @param limit     Maximum number of results to return.
   *
   * **Fault-tolerant**: returns an empty array on any error.
   */
  searchL0Fts(ftsQuery: string, limit = VectorStore.FTS_DEFAULT_LIMIT): L0FtsSearchResult[] {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      const rows = this.stmtL0FtsSearch.all(ftsQuery, limit) as Array<{
        record_id: string;
        message_text: string;
        session_key: string;
        session_id: string;
        role: string;
        recorded_at: string;
        timestamp: number;
        rank: number;
      }>;

      return rows.map((r) => ({
        record_id: r.record_id,
        session_key: r.session_key,
        session_id: r.session_id,
        role: r.role,
        message_text: r.message_text,
        score: bm25RankToScore(r.rank),
        recorded_at: r.recorded_at,
        timestamp: r.timestamp ?? 0,
      }));
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-fts-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── FTS5 migration & rebuild ──────────────────────────────────────────────

  /**
   * Detect old FTS5 v1 schema (no `content_original` column) and drop the
   * tables so they can be recreated with the v2 schema.
   *
   * FTS5 virtual tables do NOT support `ALTER TABLE ADD COLUMN`, so the only
   * migration path is DROP + recreate + repopulate.
   *
   * @returns `true` if migration was performed (= FTS index needs rebuilding).
   * @internal
   */
  private migrateFtsTablesIfNeeded(): boolean {
    try {
      // Check if l1_fts exists at all
      const l1Exists = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='l1_fts'")
        .get();
      if (!l1Exists) {
        // Fresh install — tables will be created with v2 schema.
        // Still need rebuild if there's existing data in l1_records.
        const hasData = this.db.prepare("SELECT 1 FROM l1_records LIMIT 1").get();
        return !!hasData;
      }

      // Check if the v2 column `content_original` exists.
      // FTS5 tables appear in pragma_table_info with their column names.
      const cols = this.db
        .prepare("SELECT name FROM pragma_table_info('l1_fts')")
        .all() as Array<{ name: string }>;
      const hasV2Col = cols.some((c) => c.name === "content_original");

      if (hasV2Col) {
        return false; // Already v2 — no migration needed
      }

      // v1 → v2: drop both FTS tables (data will be repopulated by rebuildFtsIndex)
      this.logger?.info(`${TAG} Migrating FTS5 tables from v1 to v2 (jieba segmented)`);
      this.db.exec("DROP TABLE IF EXISTS l1_fts");
      this.db.exec("DROP TABLE IF EXISTS l0_fts");
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} FTS migration check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Rebuild the FTS5 index from scratch by reading all records from the
   * metadata tables and re-inserting them with jieba-segmented text.
   *
   * Called automatically after:
   *  - Schema migration from v1 to v2
   *  - Fresh table creation when existing data exists
   *
   * Safe to call multiple times (idempotent — clears FTS tables first).
   */
  rebuildFtsIndex(): void {
    if (!this.ftsAvailable) return;

    try {
      this.logger?.info(`${TAG} Rebuilding FTS5 index with jieba segmentation…`);

      // ── Rebuild L1 FTS ──
      // Clear existing FTS data
      this.db.exec("DELETE FROM l1_fts");

      // Read all L1 records from metadata table
      const l1Rows = this.db
        .prepare(`
          SELECT record_id, content, type, priority, scene_name,
                 session_key, session_id, timestamp_str, timestamp_start, timestamp_end, metadata_json
          FROM l1_records
        `)
        .all() as Array<{
          record_id: string;
          content: string;
          type: string;
          priority: number;
          scene_name: string;
          session_key: string;
          session_id: string;
          timestamp_str: string;
          timestamp_start: string;
          timestamp_end: string;
          metadata_json: string;
        }>;

      let l1Count = 0;
      for (const r of l1Rows) {
        try {
          this.stmtL1FtsInsert.run(
            tokenizeForFts(r.content),  // content — segmented
            r.content,                   // content_original — raw
            r.record_id,
            r.type,
            r.priority,
            r.scene_name,
            r.session_key,
            r.session_id,
            r.timestamp_str,
            r.timestamp_start,
            r.timestamp_end,
            r.metadata_json,
          );
          l1Count++;
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} FTS rebuild skip L1 ${r.record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ── Rebuild L0 FTS ──
      this.db.exec("DELETE FROM l0_fts");

      const l0Rows = this.db
        .prepare(`
          SELECT record_id, message_text, session_key, session_id, role, recorded_at, timestamp
          FROM l0_conversations
        `)
        .all() as Array<{
          record_id: string;
          message_text: string;
          session_key: string;
          session_id: string;
          role: string;
          recorded_at: string;
          timestamp: number;
        }>;

      let l0Count = 0;
      for (const r of l0Rows) {
        try {
          this.stmtL0FtsInsert.run(
            tokenizeForFts(r.message_text),  // message_text — segmented
            r.message_text,                   // message_text_original — raw
            r.record_id,
            r.session_key,
            r.session_id,
            r.role,
            r.recorded_at,
            r.timestamp,
          );
          l0Count++;
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} FTS rebuild skip L0 ${r.record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.logger?.info(
        `${TAG} FTS5 rebuild complete: L1=${l1Count}/${l1Rows.length}, L0=${l0Count}/${l0Rows.length}`,
      );
    } catch (err) {
      this.logger?.warn(
        `${TAG} FTS5 rebuild failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ============================
  // KB (Entity-Centric Core) — Phase 1
  // ============================

  /**
   * Create the new entity-centric tables + recall surfaces.
   *
   * ADDITIVE & BEST-EFFORT:
   *   - All statements use `IF NOT EXISTS`, so a legacy DB (only the old l0_
   *     and l1_ tables) opens fine and simply GAINS these tables.
   *   - It does NOT alter or drop any existing l0_ or l1_ table.
   *   - The kb_vec virtual table is only created when dimensions > 0 (mirrors
   *     the l1_vec / l0_vec deferral when provider="none").
   *   - Any failure leaves the KB tables unavailable but never propagates — the
   *     live L0/L1 path must keep working.
   */
  private initKbSchema(): void {
    try {
      // ── entities ──
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          canonical_key TEXT NOT NULL,
          namespace TEXT NOT NULL DEFAULT 'default',
          project TEXT NOT NULL DEFAULT '',
          language TEXT NOT NULL DEFAULT 'und',
          aliases_json TEXT NOT NULL DEFAULT '[]',
          importance INTEGER NOT NULL DEFAULT 50,
          created_time TEXT NOT NULL,
          updated_time TEXT NOT NULL,
          UNIQUE(namespace, type, canonical_key)
        )
      `);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_ent_ns_type ON entities(namespace, type)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_ent_canonical ON entities(namespace, canonical_key)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_ent_updated ON entities(updated_time)");

      // ── facts ──
      // HEAD fact = (entity_id, attribute) WHERE superseded_by IS NULL AND valid_to IS NULL.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS facts (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          attribute TEXT NOT NULL,
          value TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'und',
          valid_from TEXT NOT NULL,
          valid_to TEXT,
          learned_at TEXT NOT NULL,
          superseded_by TEXT,
          superseded_at TEXT,
          source_event_id TEXT,
          confidence REAL NOT NULL DEFAULT 0.7,
          support INTEGER NOT NULL DEFAULT 1,
          namespace TEXT NOT NULL DEFAULT 'default',
          created_time TEXT NOT NULL
        )
      `);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_head ON facts(entity_id, attribute, superseded_by)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_ns_attr ON facts(namespace, attribute)");

      // ── events (append-only) ──
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          session_key TEXT NOT NULL,
          session_id TEXT NOT NULL DEFAULT '',
          namespace TEXT NOT NULL DEFAULT 'default',
          project TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL,
          text TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'und',
          entities_json TEXT NOT NULL DEFAULT '[]',
          source_message_ids_json TEXT NOT NULL DEFAULT '[]'
        )
      `);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_evt_session ON events(session_key, ts)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_evt_ns_ts ON events(namespace, ts)");

      // ── relations (idempotent edges) ──
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS relations (
          id TEXT PRIMARY KEY,
          src_entity_id TEXT NOT NULL,
          type TEXT NOT NULL,
          dst_entity_id TEXT NOT NULL,
          namespace TEXT NOT NULL DEFAULT 'default',
          valid_from TEXT NOT NULL,
          valid_to TEXT,
          support INTEGER NOT NULL DEFAULT 1,
          source_event_id TEXT,
          created_time TEXT NOT NULL,
          UNIQUE(namespace, src_entity_id, type, dst_entity_id)
        )
      `);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_rel_src ON relations(src_entity_id, type)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_rel_dst ON relations(dst_entity_id, type)");

      // ── session_projects: sessionKey → project-name registry. sessionKey is
      //    per-project (plugin getSessionKey(cwd)) but events/L0 don't store the
      //    project NAME. This registry lets the background extractor tag new
      //    events by project, and lets recall scope to the current project.
      //    Additive & best-effort. prepare().run() (not db.exec) dodges the
      //    child_process.exec lint false-positive on node:sqlite.
      this.db
        .prepare("CREATE TABLE IF NOT EXISTS session_projects (session_key TEXT PRIMARY KEY, project TEXT NOT NULL, updated_at TEXT)")
        .run();

      // ── Sinapsys foundations (Phases A–E): memory_lifecycle / lessons /
      //    memory_audit / context_fingerprints / relations.weight. Additive &
      //    best-effort; never blocks the base KB from becoming ready.
      initFoundationsSchema(this.db, this.logger);

      this.kbReady = true;
    } catch (err) {
      this.kbReady = false;
      this.logger?.warn(
        `${TAG} KB schema NOT available (entities/facts/events/relations): ${err instanceof Error ? err.message : String(err)}`,
      );
      return; // No point creating recall surfaces if the base tables failed.
    }

    // ── kb_vec (vec0 recall surface) — mirrors l1_vec chunked pattern ──
    // Only when dimensions > 0 (deferred under provider="none", like l1_vec).
    if (this.dimensions > 0) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS kb_vec USING vec0(
            chunk_id TEXT PRIMARY KEY,
            owner_id TEXT partition key,
            owner_kind TEXT,
            embedding float[${this.dimensions}] distance_metric=cosine,
            updated_time TEXT DEFAULT '',
            chunk_size=8
          )
        `);
        // DELETE by partition key removes ALL chunk rows for an owner.
        this.stmtKbVecDelete = this.db.prepare("DELETE FROM kb_vec WHERE owner_id = ?");
        this.stmtKbVecInsert = this.db.prepare(
          "INSERT INTO kb_vec (chunk_id, owner_id, owner_kind, embedding, updated_time) VALUES (?, ?, ?, ?, ?)",
        );
        this.stmtKbVecSearch = this.db.prepare(`
          SELECT chunk_id, owner_id, owner_kind, distance
          FROM kb_vec
          WHERE embedding MATCH ? AND k = ?
          ORDER BY distance
        `);
        // vec0 KNN cannot reliably filter by a metadata column inside the MATCH
        // query, so owner_kind filtering is applied in JS (see searchKbVector).
        this.kbVecReady = true;
      } catch (err) {
        this.kbVecReady = false;
        this.logger?.warn(
          `${TAG} kb_vec NOT available: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ── kb_fts (FTS5 recall surface) — mirrors l1_fts pattern ──
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
          content,
          content_original UNINDEXED,
          owner_id UNINDEXED,
          owner_kind UNINDEXED,
          entity_type UNINDEXED,
          namespace UNINDEXED,
          attribute UNINDEXED,
          updated_time UNINDEXED
        )
      `);
      // Upsert-by-owner = delete-then-insert (FTS5 has no ON CONFLICT).
      this.stmtKbFtsDelete = this.db.prepare("DELETE FROM kb_fts WHERE owner_id = ?");
      this.stmtKbFtsInsert = this.db.prepare(`
        INSERT INTO kb_fts (content, content_original, owner_id, owner_kind, entity_type, namespace, attribute, updated_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtKbFtsSearch = this.db.prepare(`
        SELECT owner_id, owner_kind, content_original AS content, entity_type, namespace, attribute,
               bm25(kb_fts) AS rank
        FROM kb_fts
        WHERE kb_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);
      this.kbFtsAvailable = true;
    } catch (err) {
      this.kbFtsAvailable = false;
      this.logger?.warn(
        `${TAG} kb_fts NOT available: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger?.debug?.(
      `${TAG} KB schema initialized (kbReady=${this.kbReady}, kbVec=${this.kbVecReady}, kbFts=${this.kbFtsAvailable})`,
    );
  }

  /** Whether the entity-centric (KB) base tables are available. */
  isKbReady(): boolean {
    return this.kbReady;
  }

  /** @see IMemoryStore.resolveOrCreateEntity */
  resolveOrCreateEntity(params: {
    namespace?: string;
    type: string;
    name: string;
    aliases?: string[];
    language?: string;
    project?: string;
    now: string;
  }): KbEntity {
    if (!this.kbReady) throw new Error(`${TAG} KB not ready — resolveOrCreateEntity unavailable`);
    return kbResolveOrCreateEntity(this.db, params);
  }

  /** @see IMemoryStore.insertEvent */
  insertEvent(event: KbEventInput): KbEvent {
    if (!this.kbReady) throw new Error(`${TAG} KB not ready — insertEvent unavailable`);
    return kbInsertEvent(this.db, event);
  }

  /** @see IMemoryStore.consolidateSession */
  consolidateSession(params: {
    sessionKey: string;
    now: string;
    staleAfterMs?: number;
    namespace?: string;
  }): ConsolidationStats {
    // Unlike the CRUD primitives this never throws: it runs on the session-end
    // path and must degrade to a no-op when the KB is unavailable.
    if (!this.kbReady) return { eventsReinforced: 0, factsReinforced: 0, staled: 0 };
    return runConsolidation(this.db, params);
  }

  /** @see IMemoryStore.insertContextFingerprint */
  insertContextFingerprint(params: {
    sessionKey: string;
    now: string;
    fileKeys: readonly string[];
    errorSignatures: readonly string[];
    taskType: string;
    toolNames: readonly string[];
    matchedOwnerIds: readonly string[];
    namespace?: string;
  }): string | null {
    // Best-effort on the observe/session-end path — never throws.
    if (!this.kbReady) return null;
    return kbInsertFingerprint(this.db, params);
  }

  /** @see IMemoryStore.queryContextFingerprints */
  queryContextFingerprints(namespace: string, limit: number): StoredFingerprint[] {
    if (!this.kbReady) return [];
    return kbQueryRecentFingerprints(this.db, namespace, limit);
  }

  /** @see IMemoryStore.upsertFact */
  upsertFact(params: {
    entityId: string;
    attribute: string;
    value: string;
    validFrom?: string;
    confidence?: number;
    sourceEventId?: string | null;
    language?: string;
    namespace?: string;
    now: string;
  }): KbFact {
    if (!this.kbReady) throw new Error(`${TAG} KB not ready — upsertFact unavailable`);
    return kbUpsertFact(this.db, params);
  }

  /** @see IMemoryStore.upsertRelation */
  upsertRelation(rel: KbRelationInput): KbRelation {
    if (!this.kbReady) throw new Error(`${TAG} KB not ready — upsertRelation unavailable`);
    return kbUpsertRelation(this.db, rel);
  }

  /** @see IMemoryStore.queryHeadFacts */
  queryHeadFacts(entityId: string): KbFact[] {
    if (!this.kbReady) return [];
    return kbQueryHeadFacts(this.db, entityId);
  }

  /** @see IMemoryStore.queryAllFacts */
  queryAllFacts(entityId: string): KbFact[] {
    if (!this.kbReady) return [];
    return kbQueryAllFacts(this.db, entityId);
  }

  /** @see IMemoryStore.queryEntityById */
  queryEntityById(id: string): KbEntity | null {
    if (!this.kbReady) return null;
    return kbQueryEntityById(this.db, id);
  }

  /** @see IMemoryStore.queryEntityByKey */
  queryEntityByKey(namespace: string, type: string, canonicalKeyValue: string): KbEntity | null {
    if (!this.kbReady) return null;
    return kbQueryEntityByKey(this.db, namespace, type, canonicalKeyValue);
  }

  /** @see IMemoryStore.queryFactById */
  queryFactById(id: string): KbFact | null {
    if (!this.kbReady) return null;
    return kbQueryFactById(this.db, id);
  }

  /** @see IMemoryStore.queryEventById */
  queryEventById(id: string): KbEvent | null {
    if (!this.kbReady) return null;
    return kbQueryEventById(this.db, id);
  }

  /** @see IMemoryStore.queryEntitiesByTokens */
  queryEntitiesByTokens(tokens: string[], namespace = "default", limit = 20): KbEntity[] {
    if (!this.kbReady) return [];
    return kbQueryEntitiesByTokens(this.db, tokens, namespace, limit);
  }

  /** @see IMemoryStore.listEntities */
  listEntities(namespace = "default", opts: { types?: string[]; limit?: number } = {}): KbEntity[] {
    if (!this.kbReady) return [];
    return kbListEntities(this.db, namespace, opts);
  }

  /** @see IMemoryStore.listRecentEvents */
  listRecentEvents(namespace = "default", opts: { sinceTs?: string; limit?: number } = {}): KbEvent[] {
    if (!this.kbReady) return [];
    return kbListRecentEvents(this.db, namespace, opts);
  }

  /** @see IMemoryStore.listEventsBySession */
  listEventsBySession(sessionKey: string): KbEvent[] {
    if (!this.kbReady) return [];
    return kbListEventsBySession(this.db, sessionKey);
  }

  /** @see IMemoryStore.latestEventBySessionKeyType */
  latestEventBySessionKeyType(sessionKey: string, type: string): KbEvent | undefined {
    if (!this.kbReady) return undefined;
    return kbLatestEventBySessionKeyType(this.db, sessionKey, type);
  }

  /** @see IMemoryStore.setSessionProject */
  setSessionProject(sessionKey: string, project: string): void {
    if (!this.kbReady || !sessionKey || !project) return;
    try {
      this.db
        .prepare(
          "INSERT INTO session_projects(session_key, project, updated_at) VALUES(?,?,?) " +
          "ON CONFLICT(session_key) DO UPDATE SET project=excluded.project, updated_at=excluded.updated_at",
        )
        .run(sessionKey, project, new Date().toISOString());
    } catch {
      /* best-effort registry — never break recall/capture */
    }
  }

  /** @see IMemoryStore.getSessionProject */
  getSessionProject(sessionKey: string): string | undefined {
    if (!this.kbReady || !sessionKey) return undefined;
    try {
      const row = this.db
        .prepare("SELECT project FROM session_projects WHERE session_key = ?")
        .get(sessionKey) as { project?: string } | undefined;
      return row?.project || undefined;
    } catch {
      return undefined;
    }
  }

  /** @see IMemoryStore.getEventProjects — project tag per event id (recall scoping). */
  getEventProjects(ids: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    if (!this.kbReady || ids.length === 0) return out;
    try {
      const placeholders = ids.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT id, project FROM events WHERE id IN (${placeholders})`)
        .all(...ids) as Array<{ id: string; project?: string }>;
      for (const r of rows) if (r.project) out[r.id] = r.project;
    } catch {
      /* best-effort — recall must never break */
    }
    return out;
  }

  /**
   * @see IMemoryStore.getMemoryHealth — the immune system's heartbeat.
   * Flags sessions where the raw log (L0) is growing but the extracted graph
   * (events) is NOT keeping up — the exact silent failure that let Sofia/Tutor
   * freeze for weeks unnoticed. Only ACTIVELY-USED sessions are considered
   * (recent L0); dormant ones are not "broken". Store-only, never throws.
   */
  getMemoryHealth(nowMs: number = Date.now()): {
    healthy: boolean;
    stale: Array<{ sessionKey: string; project: string; lagHours: number }>;
  } {
    const RECENT_L0_MS = 3 * 24 * 3600 * 1000; // consider only sessions used in last 3 days
    const LAG_MS = 36 * 3600 * 1000; // events >36h behind their L0 = extraction stalled
    const out = { healthy: true, stale: [] as Array<{ sessionKey: string; project: string; lagHours: number }> };
    if (!this.kbReady) return out;
    try {
      const rows = this.db
        .prepare(
          "SELECT l.session_key sk, MAX(l.recorded_at) l0, " +
          "(SELECT MAX(e.ts) FROM events e WHERE e.session_key = l.session_key) ev " +
          "FROM l0_conversations l GROUP BY l.session_key",
        )
        .all() as Array<{ sk: string; l0: string | null; ev: string | null }>;
      for (const r of rows) {
        const l0ms = Date.parse(r.l0 ?? "");
        if (!Number.isFinite(l0ms) || nowMs - l0ms > RECENT_L0_MS) continue; // dormant → skip
        const evms = r.ev ? Date.parse(r.ev) : 0;
        const lag = l0ms - (Number.isFinite(evms) ? evms : 0);
        if (lag > LAG_MS) {
          out.stale.push({
            sessionKey: r.sk,
            project: this.getSessionProject(r.sk) ?? r.sk.slice(0, 8),
            lagHours: Math.round(lag / 3_600_000),
          });
        }
      }
      out.stale.sort((a, b) => b.lagHours - a.lagHours);
      out.healthy = out.stale.length === 0;
    } catch {
      /* best-effort — health check must never break recall */
    }
    return out;
  }

  /** @see IMemoryStore.queryRelationsForEntity */
  queryRelationsForEntity(entityId: string): KbRelation[] {
    if (!this.kbReady) return [];
    return kbQueryRelationsForEntity(this.db, entityId);
  }

  /** @see IMemoryStore.queryEventsForEntity */
  queryEventsForEntity(entityId: string, namespace = "default", limit = 50): KbEvent[] {
    if (!this.kbReady) return [];
    return kbQueryEventsForEntity(this.db, entityId, namespace, limit);
  }

  /** @see IMemoryStore.queryHeadLessonsByFile */
  queryHeadLessonsByFile(fileEntityId: string, namespace = "default", limit = 3): KbLessonHit[] {
    if (!this.kbReady) return [];
    return kbQueryHeadLessonsByFile(this.db, fileEntityId, namespace, limit).map((r) => ({
      id: r.id,
      domain: r.domain,
      lessonText: r.lesson_text,
      confidence: r.confidence,
      evidenceCount: r.evidence_count,
      willingness: r.stance_willingness,
    }));
  }

  /**
   * Record that a lesson resurfaced into a matching situation this session (B3
   * exposure). Best-effort, off the critical path: failures swallowed + logged.
   */
  recordLessonExposure(lessonId: string, sessionId: string, now: string): void {
    if (!this.kbReady) return;
    try {
      kbRecordExposure(this.db, lessonId, sessionId, now);
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][lessons] recordLessonExposure failed (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * @see IMemoryStore.creditSessionAvoidances
   * Implicit (Phase A) avoidance crediting at session end: for each HEAD lesson
   * exposed this session whose avoidance_count has crossed τ (so it self-credits),
   * credit a successful avoidance UNLESS the failure relapsed — a bug event this
   * session touching the lesson's trigger files — in which case temper its confidence.
   * Phase-B lessons (still young) are skipped here; they wait for explicit confirmation.
   * Off the critical path: any failure returns zero counts.
   */
  creditLessonAvoidance(lessonId: string, now: string): boolean {
    if (!this.kbReady) return false;
    try {
      return kbCreditAvoidance(this.db, lessonId, now) !== null;
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][lessons] creditLessonAvoidance failed (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Pilastro B — record that a stance fired a hard interrupt (bumps its fire
   * count). Best-effort, off the critical path: failures swallowed + logged.
   */
  recordStanceFire(lessonId: string, now: string): void {
    if (!this.kbReady) return;
    try {
      kbRecordStanceFire(this.db, lessonId, now);
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][lessons] recordStanceFire failed (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Pilastro B — Lorenzo confirmed a stance interrupt mattered (willingness rises). */
  creditStanceConfirmed(lessonId: string, now: string): boolean {
    if (!this.kbReady) return false;
    try {
      return kbCreditStanceConfirmed(this.db, lessonId, now) !== null;
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][lessons] creditStanceConfirmed failed (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** Pilastro B — Lorenzo rejected a stance interrupt as a false alarm (willingness falls). */
  creditStanceRejected(lessonId: string, now: string): boolean {
    if (!this.kbReady) return false;
    try {
      return kbCreditStanceRejected(this.db, lessonId, now) !== null;
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][lessons] creditStanceRejected failed (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  creditSessionAvoidances(sessionId: string, now: string): { credited: number; tempered: number } {
    if (!this.kbReady) return { credited: 0, tempered: 0 };
    try {
      const exposed = kbQueryLessonsExposedInSession(this.db, sessionId);
      if (exposed.length === 0) return { credited: 0, tempered: 0 };

      // Entity ids touched by this session's bug events (the relapse signal).
      const bugRows = this.db
        .prepare("SELECT entities_json FROM events WHERE session_key = ? AND type = 'bug'")
        .all(sessionId) as Array<{ entities_json: string }>;
      const bugEntities = new Set<string>();
      for (const r of bugRows) {
        try {
          const arr = JSON.parse(r.entities_json);
          if (Array.isArray(arr)) for (const e of arr) if (typeof e === "string") bugEntities.add(e);
        } catch { /* skip malformed */ }
      }

      let credited = 0;
      let tempered = 0;
      for (const l of exposed) {
        if (lessonPhaseFor(l.avoidance_count) !== "implicit") continue; // Phase B → explicit only
        let files: string[] = [];
        try {
          const t = JSON.parse(l.trigger_pattern);
          if (t && Array.isArray(t.files)) files = t.files.filter((f: unknown): f is string => typeof f === "string");
        } catch { /* trigger not JSON → no file relapse signal */ }
        const relapsed = files.some((f) => bugEntities.has(f));
        if (relapsed) {
          kbTemperOnRecurrence(this.db, l.id, now);
          tempered++;
        } else {
          kbCreditAvoidance(this.db, l.id, now);
          credited++;
        }
      }
      return { credited, tempered };
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][lessons] creditSessionAvoidances failed (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return { credited: 0, tempered: 0 };
    }
  }

  /** @see IMemoryStore.runLessonDistillation */
  async runLessonDistillation(
    llmRunner: LLMRunner,
    opts: { now: string; namespace?: string; maxClusters?: number },
  ): Promise<{ candidates: number; inserted: number; superseded: number; skippedDuplicate: number }> {
    if (this.degraded || !this.kbReady || !this.kbVecReady) {
      return { candidates: 0, inserted: 0, superseded: 0, skippedDuplicate: 0 };
    }
    // distillLessons reads kb_vec (bug clustering) via this.db (sqlite-vec loaded)
    // and writes the `lessons` table on the SAME connection — no extra writer.
    const stats = await kbDistillLessons(this.db, llmRunner, {
      now: opts.now,
      namespace: opts.namespace,
      maxClusters: opts.maxClusters,
    });
    return {
      candidates: stats.candidates,
      inserted: stats.inserted,
      superseded: stats.superseded,
      skippedDuplicate: stats.skippedDuplicate,
    };
  }

  /** @see IMemoryStore.runUsageDistillation */
  async runUsageDistillation(
    llmRunner: LLMRunner,
    opts: { now: string; namespace?: string; maxClusters?: number },
  ): Promise<{ candidates: number; confirmed: number; inserted: number; skippedDuplicate: number; skippedRejected: number }> {
    if (this.degraded || !this.kbReady || !this.kbVecReady) {
      return { candidates: 0, confirmed: 0, inserted: 0, skippedDuplicate: 0, skippedRejected: 0 };
    }
    // Usage clustering is SEMANTIC → it needs vectors (unlike per-entity
    // principles). The reader reads this.db's kb_vec; events are read and the
    // usage atom is written on the SAME store/connection. The LLM is the A3
    // precision gate that rejects noise clusters (recall from clustering,
    // precision from the judge).
    const reader = createKbVecEmbeddingReader(this.db, this.dimensions);
    return kbDistillUsage(this, reader, llmRunner, {
      now: opts.now,
      namespace: opts.namespace,
      maxClusters: opts.maxClusters,
      // Surface the pairwise-cap notice in the gateway log (never a silent cap).
      logger: this.logger,
    });
  }

  /**
   * Write the kb_vec chunk vectors for an owner (entity/fact/event).
   * Delete-all-then-insert-N (idempotent), mirroring the l1_vec write.
   * Zero / empty vectors are filtered out (placeholders must never pollute KNN).
   */
  upsertKbVector(
    ownerId: string,
    ownerKind: string,
    chunks: Float32Array | Float32Array[],
    updatedTime = "",
  ): boolean {
    if (this.degraded || !this.kbVecReady) return false;
    const chunkVectors = VectorStore.toChunkVectors(chunks);
    if (chunkVectors.length === 0) return false;
    try {
      this.db.exec("BEGIN");
      try {
        this.stmtKbVecDelete!.run(ownerId);
        for (let i = 0; i < chunkVectors.length; i++) {
          this.stmtKbVecInsert!.run(
            kbChunkId(ownerKind, ownerId, i),
            ownerId,
            ownerKind,
            Buffer.from(chunkVectors[i].buffer),
            updatedTime,
          );
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [kb-vec-upsert] FAILED (non-fatal) owner=${ownerId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** Write the kb_fts row for an owner (delete-then-insert; jieba-segmented content). */
  upsertKbFts(params: {
    ownerId: string;
    ownerKind: string;
    content: string;
    entityType?: string;
    namespace?: string;
    attribute?: string;
    updatedTime?: string;
  }): boolean {
    if (this.degraded || !this.kbFtsAvailable) return false;
    try {
      this.stmtKbFtsDelete!.run(params.ownerId);
      this.stmtKbFtsInsert!.run(
        tokenizeForFts(params.content), // content — segmented for indexing
        params.content,                 // content_original — raw for display
        params.ownerId,
        params.ownerKind,
        params.entityType ?? "",
        params.namespace ?? "default",
        params.attribute ?? "",
        params.updatedTime ?? "",
      );
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [kb-fts-upsert] FAILED (non-fatal) owner=${params.ownerId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * kb_vec cosine similarity search. Mirrors searchL1Vector: over-fetch, skip
   * null/NaN distances (zero-vector placeholders), de-dup to the best chunk per
   * owner, trim to topK. Optional `ownerKindFilter` keeps only that kind.
   */
  searchKbVector(queryEmbedding: Float32Array, topK = 5, ownerKindFilter?: string): KbVectorSearchResult[] {
    if (this.degraded || !this.kbVecReady) return [];
    try {
      const retrieveCount = topK * VectorStore.CHUNK_RECALL_FANOUT + VectorStore.ZERO_VEC_BUFFER;
      const rows = this.stmtKbVecSearch!.all(
        Buffer.from(queryEmbedding.buffer),
        retrieveCount,
      ) as Array<{ chunk_id: string; owner_id: string; owner_kind: string; distance: number }>;

      if (rows.length === 0) return [];

      const results: KbVectorSearchResult[] = [];
      const seenOwners = new Set<string>();
      for (const { owner_id, owner_kind, distance } of rows) {
        if (distance == null || Number.isNaN(distance)) continue; // zero-vector placeholder
        if (ownerKindFilter && owner_kind !== ownerKindFilter) continue;
        if (seenOwners.has(owner_id)) continue; // best chunk per owner (rows are distance-sorted)
        seenOwners.add(owner_id);
        results.push({ owner_id, owner_kind, score: 1.0 - distance });
      }
      return results.slice(0, topK);
    } catch (err) {
      this.logger?.warn(
        `${TAG} [kb-vec-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /** kb_fts keyword search. Mirrors searchL1Fts (BM25 → 0–1 score). */
  searchKbFts(ftsQuery: string, limit = 20): KbFtsSearchResult[] {
    if (this.degraded || !this.kbFtsAvailable) return [];
    try {
      const rows = this.stmtKbFtsSearch!.all(ftsQuery, limit) as Array<{
        owner_id: string;
        owner_kind: string;
        content: string;
        entity_type: string;
        namespace: string;
        attribute: string;
        rank: number;
      }>;
      return rows.map((r) => ({
        owner_id: r.owner_id,
        owner_kind: r.owner_kind,
        content: r.content,
        entity_type: r.entity_type,
        namespace: r.namespace,
        attribute: r.attribute,
        score: bm25RankToScore(r.rank),
      }));
    } catch (err) {
      this.logger?.warn(
        `${TAG} [kb-fts-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ============================
  // IMemoryStore interface implementation
  // ============================

  /** Query the store's search capabilities. */
  getCapabilities(): StoreCapabilities {
    return {
      vectorSearch: this.vecTablesReady,
      ftsSearch: this.ftsAvailable,
      nativeHybridSearch: false,
      sparseVectors: false,
    };
  }

  /**
   * Close the database connection.
   * Should be called on shutdown. Idempotent — safe to call multiple times.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} Error closing database: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
