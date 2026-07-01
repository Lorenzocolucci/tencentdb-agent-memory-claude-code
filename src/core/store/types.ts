/**
 * Memory Store Abstraction Layer — Core Types & Interfaces.
 *
 * This module defines the storage contracts that all backend implementations
 * (SQLite local, Tencent Cloud VectorDB, etc.) must satisfy.
 *
 * Design principles:
 * 1. **Backend-agnostic**: Upper-layer modules (hooks, tools, pipeline, record)
 *    depend only on these interfaces — never on concrete implementations.
 * 2. **Capability-based**: Features like vector search, FTS, and hybrid search
 *    are expressed as capability flags so callers can gracefully degrade.
 * 3. **Fault-tolerant**: All methods return empty results or `false` on
 *    failure rather than throwing, unless explicitly documented otherwise.
 * 4. **Sync-first**: Matches current SQLite DatabaseSync usage. TCVDB backend
 *    adapts internally without changing these signatures.
 */

import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type { StoredFingerprint } from "../kb/fingerprint-writer.js";

// Re-export so consumers can import everything from types.ts
export type { MemoryRecord, EmbeddingProviderInfo };

// ============================
// Common Types
// ============================

/** Minimal logger interface accepted by store implementations. */
export interface StoreLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// ============================
// L1 Types (Structured Memories)
// ============================

/** Result from an L1 vector similarity search. */
export interface L1SearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** Similarity score (0–1, higher is better). */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
}

/** Result from an L1 FTS keyword search. */
export interface L1FtsResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** BM25-derived score (0–1, higher is better). */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
}

/** Filter options for querying L1 records. */
export interface L1QueryFilter {
  sessionKey?: string;
  sessionId?: string;
  /** Only return records with updated_time strictly after this ISO 8601 UTC timestamp. */
  updatedAfter?: string;
}

/** Row shape returned by L1 query methods. */
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

// ============================
// L0 Types (Raw Conversations)
// ============================

/** An L0 conversation message record for vector indexing. */
export interface L0Record {
  id: string;
  sessionKey: string;
  sessionId: string;
  role: string;
  messageText: string;
  recordedAt: string;
  /** Original message timestamp (epoch ms). */
  timestamp: number;
}

/** Result from an L0 vector similarity search. */
export interface L0SearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** Similarity score (0–1, higher is better). */
  score: number;
  recorded_at: string;
  timestamp: number;
}

/** Result from an L0 FTS keyword search. */
export interface L0FtsResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** BM25-derived score (0–1, higher is better). */
  score: number;
  recorded_at: string;
  timestamp: number;
}

/** Raw L0 row returned by query methods (used by L1 runner). */
export interface L0QueryRow {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
}

/** L0 messages grouped by session ID (for L1 runner). */
export interface L0SessionGroup {
  sessionId: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: number;
    /** Epoch ms when this message was recorded into L0 (used by L1 cursor). */
    recordedAtMs: number;
  }>;
}

// ============================
// KB Types (Entity-Centric Core — Phase 1)
// ============================
//
// These are the new entity-centric tables introduced by the redesign
// (see docs/ENTITY_CORE_BLUEPRINT.md). They are ADDITIVE: they live in the
// SAME SQLite DB alongside the existing l0_*/l1_* tables and do NOT change
// any capture/recall behavior in Phase 1.

/** Allowed entity types (open-ended, but these are the canonical ones). */
export type KbEntityType =
  | "person"
  | "project"
  | "library"
  | "file"
  | "decision"
  | "bug"
  | "preference"
  | "concept"
  | string;

/** A row in the `entities` table (1 row per distinct real-world thing). */
export interface KbEntity {
  /** "ent_"+sha1(namespace|type|canonical_key)[:16] — deterministic. */
  id: string;
  type: string;
  /** Display name, in the source language. */
  name: string;
  /** Normalized dedup key (NFKC, lowercased, type-normalized). */
  canonical_key: string;
  namespace: string;
  /** Tag (cross-project recall by default). */
  project: string;
  language: string;
  /** Parsed alias list (stored as JSON in aliases_json). */
  aliases: string[];
  importance: number;
  created_time: string;
  updated_time: string;
}

/** A row in the `facts` table (bi-temporal attribute/value about an entity). */
export interface KbFact {
  /** "fact_"+ulid (time-sortable). */
  id: string;
  entity_id: string;
  /** snake_case, language-neutral key. */
  attribute: string;
  /** Source-language value. */
  value: string;
  language: string;
  /** World-time the fact became true. */
  valid_from: string;
  /** World-time the fact stopped being true; NULL = still current. */
  valid_to: string | null;
  /** Learn-time the fact was recorded. */
  learned_at: string;
  /** Newer fact id that replaced this one; NULL = HEAD. */
  superseded_by: string | null;
  superseded_at: string | null;
  source_event_id: string | null;
  confidence: number;
  /** How many times this exact value was observed (corroboration count). */
  support: number;
  namespace: string;
  created_time: string;
}

/** A row in the `events` table (append-only episodic record). */
export interface KbEvent {
  /** "evt_"+ulid (time-sortable). */
  id: string;
  /** World-time of the event. */
  ts: string;
  recorded_at: string;
  session_key: string;
  session_id: string;
  namespace: string;
  project: string;
  type: string;
  text: string;
  language: string;
  /** Entity ids referenced by this event (stored as JSON). */
  entities: string[];
  /** Provenance: raw message ids this event was derived from (stored as JSON). */
  source_message_ids: string[];
}

/** A row in the `relations` table (typed edge between two entities). */
export interface KbRelation {
  /** "rel_"+sha1(namespace|src|type|dst)[:16] — deterministic. */
  id: string;
  src_entity_id: string;
  type: string;
  dst_entity_id: string;
  namespace: string;
  valid_from: string;
  valid_to: string | null;
  support: number;
  source_event_id: string | null;
  created_time: string;
}

/** Owner kind for a kb_vec / kb_fts row (what the embedded text describes). */
export type KbOwnerKind = "entity" | "fact" | "event" | string;

/** Result from a kb_vec vector similarity search. */
export interface KbVectorSearchResult {
  owner_id: string;
  owner_kind: string;
  /** Similarity score (0–1, higher is better). */
  score: number;
}

/** Result from a kb_fts keyword search. */
export interface KbFtsSearchResult {
  owner_id: string;
  owner_kind: string;
  /** Display text (the original, un-segmented content). */
  content: string;
  entity_type: string;
  namespace: string;
  attribute: string;
  /** BM25-derived score (0–1, higher is better). */
  score: number;
}

/**
 * A lesson surfaced for a touched file (Mistake Notebook B2b read shape).
 * Lean projection of a `lessons` HEAD row — only what Proactive Injection needs.
 */
export interface KbLessonHit {
  /** Lesson id — lets the caller credit exposure/avoidance (B3). */
  id: string;
  domain: string;
  lessonText: string;
  /** 0–1; higher = better-attested across recurrences. */
  confidence: number;
  /** How many failure events back this lesson. */
  evidenceCount: number;
  /**
   * Pilastro B willingness-to-fire ∈ [0,1] from the stance's own hit/miss record.
   * The live sqlite mapping always populates it (legacy rows default to
   * WILLINGNESS_DEFAULT); optional so non-KB backends / older fixtures omitting it
   * are treated as trusted by classifyStanceSeverity (undefined → trusted).
   */
  willingness?: number;
}

/** Input payload for inserting an event (append-only). */
export interface KbEventInput {
  /** Optional caller-supplied id; when absent a ULID-like id is generated. */
  id?: string;
  ts: string;
  recordedAt?: string;
  sessionKey: string;
  sessionId?: string;
  namespace?: string;
  project?: string;
  type: string;
  text: string;
  language?: string;
  entities?: string[];
  sourceMessageIds?: string[];
}

/** Input payload for upserting a relation (idempotent by unique edge). */
export interface KbRelationInput {
  srcEntityId: string;
  type: string;
  dstEntityId: string;
  namespace?: string;
  validFrom?: string;
  sourceEventId?: string | null;
  now: string;
}

// ============================
// Store Init Result
// ============================

/** Result of store initialization. */
export interface StoreInitResult {
  /** Whether embeddings need to be regenerated (provider/model change). */
  needsReindex: boolean;
  /** Human-readable reason (for logging). */
  reason?: string;
}

// ============================
// Capability Flags
// ============================

/**
 * Describes what search capabilities a store backend supports.
 * Callers use this to select search strategies and degrade gracefully.
 */
export interface StoreCapabilities {
  /** Whether vector (embedding) search is available. */
  vectorSearch: boolean;
  /** Whether FTS (full-text keyword) search is available. */
  ftsSearch: boolean;
  /** Whether native hybrid search is supported (e.g., TCVDB hybridSearch). */
  nativeHybridSearch: boolean;
  /** Whether the store supports sparse vectors (BM25 encoding). */
  sparseVectors: boolean;
}

// ============================
// L2/L3 Profile Sync Types
// ============================

/** Canonical L2/L3 profile row shared between local cache and remote store. */
export interface ProfileRecord {
  /** Stable ID: `profile:v1:${sha256(scope + "\0" + type + "\0" + filename)}`. */
  id: string;
  type: "l2" | "l3";
  filename: string;
  content: string;
  contentMd5: string;
  agentId?: string;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Profile upsert payload with optimistic-lock baseline from the last pull. */
export interface ProfileSyncRecord extends ProfileRecord {
  baselineVersion?: number;
}

// ============================
// IMemoryStore — The Core Abstraction
// ============================

/**
 * Unified memory store interface.
 *
 * Implementations:
 * - `SqliteMemoryStore` (sqlite.ts) — local SQLite + sqlite-vec + FTS5
 * - `TcvdbMemoryStore` (tcvdb.ts) — Tencent Cloud VectorDB (future)
 *
 * All methods are fault-tolerant: they return empty results or `false` on
 * failure rather than throwing, unless explicitly documented otherwise.
 */
/**
 * Helper type: a value that may be sync or async.
 * Callers should always `await` the result — it's safe for both sync and async values.
 */
export type MaybePromise<T> = T | Promise<T>;

export interface IMemoryStore {
  // ── Capabilities ───────────────────────────────────────────

  /**
   * Whether this store supports deferred (background) embedding updates.
   *
   * When `true`, auto-capture writes metadata-only via `upsertL0(record, undefined)`
   * and later calls `updateL0Embedding()` in a fire-and-forget background task.
   * When `false` or absent, embedding is computed inline and passed to `upsertL0()`.
   */
  readonly supportsDeferredEmbedding?: boolean;

  // ── Lifecycle (always sync) ──────────────────────────────

  init(providerInfo?: EmbeddingProviderInfo): MaybePromise<StoreInitResult>;
  isDegraded(): boolean;
  getCapabilities(): StoreCapabilities;
  close(): void;

  // ── L1 Write ─────────────────────────────────────────────

  /**
   * Persist an L1 record's vector(s).  `embedding` may be a single Float32Array
   * (one vector) or an array of chunk vectors (one per chunk of a long text);
   * all chunks are stored against the same record id.
   */
  upsertL1(record: MemoryRecord, embedding?: Float32Array | Float32Array[]): MaybePromise<boolean>;
  deleteL1(recordId: string): MaybePromise<boolean>;
  deleteL1Batch(recordIds: string[]): MaybePromise<boolean>;
  deleteL1Expired(cutoffIso: string): MaybePromise<number>;

  // ── L1 Read ──────────────────────────────────────────────

  countL1(): MaybePromise<number>;
  queryL1Records(filter?: L1QueryFilter): MaybePromise<L1RecordRow[]>;
  getAllL1Texts(): MaybePromise<Array<{ record_id: string; content: string; updated_time: string }>>;

  // ── L1 Search ────────────────────────────────────────────

  searchL1Vector(queryEmbedding: Float32Array, topK?: number, queryText?: string): MaybePromise<L1SearchResult[]>;
  searchL1Fts(ftsQuery: string, limit?: number): MaybePromise<L1FtsResult[]>;
  searchL1Hybrid?(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: Array<[number, number]>;
    topK?: number;
  }): MaybePromise<L1SearchResult[]>;

  // ── L0 Write ─────────────────────────────────────────────

  upsertL0(record: L0Record, embedding?: Float32Array | Float32Array[]): MaybePromise<boolean>;
  /**
   * Update only the vector embedding for an existing L0 record (sqlite background path).
   * Accepts a single vector or an array of chunk vectors.
   */
  updateL0Embedding?(recordId: string, embedding: Float32Array | Float32Array[]): MaybePromise<boolean>;
  deleteL0(recordId: string): MaybePromise<boolean>;
  deleteL0Expired(cutoffIso: string): MaybePromise<number>;

  // ── L0 Read ──────────────────────────────────────────────

  countL0(): MaybePromise<number>;
  queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit?: number): MaybePromise<L0QueryRow[]>;
  queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit?: number): MaybePromise<L0SessionGroup[]>;
  getAllL0Texts(): MaybePromise<Array<{ record_id: string; message_text: string; recorded_at: string }>>;

  // ── L0 Search ────────────────────────────────────────────

  searchL0Vector(queryEmbedding: Float32Array, topK?: number, queryText?: string): MaybePromise<L0SearchResult[]>;
  searchL0Fts(ftsQuery: string, limit?: number): MaybePromise<L0FtsResult[]>;

  pullProfiles?(): Promise<ProfileRecord[]>;
  syncProfiles?(records: ProfileSyncRecord[]): Promise<void>;
  deleteProfiles?(recordIds: string[]): Promise<void>;

  // ── Re-index ─────────────────────────────────────────────

  reindexAll(
    embedFn: (text: string) => Promise<Float32Array | Float32Array[]>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
    opts?: { resume?: boolean },
  ): Promise<{ l1Count: number; l0Count: number }>;

  // ── FTS (always sync — cached flag) ──────────────────────

  isFtsAvailable(): boolean;

  // ── KB: Entity-Centric Core (Phase 1 — additive, not yet wired) ──
  //
  // These methods operate on the new entities/facts/events/relations tables
  // and the kb_vec/kb_fts recall surfaces. They are OPTIONAL on the interface
  // so non-sqlite backends (TCVDB) can adopt them incrementally.

  /**
   * Resolve an entity by deterministic canonical key, or create it.
   * Resolution order: exact (ns,type,canonical_key) → alias match (merge name
   * into aliases) → create with id `ent_`+sha1(ns|type|key)[:16].
   */
  resolveOrCreateEntity?(params: {
    namespace?: string;
    type: string;
    name: string;
    aliases?: string[];
    language?: string;
    project?: string;
    now: string;
  }): KbEntity;

  /** Append-only event insert. Never updates or deletes existing events. */
  insertEvent?(event: KbEventInput): KbEvent;

  /**
   * Carry Idea 5's distinctiveness verdict onto a memory's lifecycle `salience`
   * (Pilastro C bridge), so distinctiveness-aware decay protects the peak.
   * Monotonic (only raises). Off the critical path: never throws. Optional so
   * non-sqlite backends (TCVDB) can omit it and the cornerstone runner no-ops.
   */
  stampSalience?(params: {
    ownerId: string;
    ownerKind: "fact" | "event";
    salience: number;
    now: string;
  }): void;

  /**
   * Run one deterministic consolidation pass for a finished session: reinforce
   * the session's events + derived facts, then decay stale memories. Sync, NO
   * LLM. Returns zeroed stats when KB is not ready; never throws (it runs on
   * the session-end path). Optional so non-sqlite backends (TCVDB) can omit it
   * and the scheduler no-ops.
   */
  consolidateSession?(params: {
    sessionKey: string;
    now: string;
    staleAfterMs?: number;
    namespace?: string;
  }): { eventsReinforced: number; factsReinforced: number; staled: number };

  /**
   * Context Fingerprint (Idea 1) — persist one situation signature
   * {files + error signatures + task type + tool sequence → surfaced owner ids}.
   * Best-effort, no-op when KB off. Returns the generated id (or null).
   */
  insertContextFingerprint?(params: {
    sessionKey: string;
    now: string;
    fileKeys: readonly string[];
    errorSignatures: readonly string[];
    taskType: string;
    toolNames: readonly string[];
    matchedOwnerIds: readonly string[];
    namespace?: string;
  }): string | null;
  /** Read recent fingerprints for a namespace, newest-first, bounded. [] when KB off. */
  queryContextFingerprints?(namespace: string, limit: number): StoredFingerprint[];

  /**
   * Bi-temporal supersession upsert of a single (entity, attribute) fact.
   * NEVER hard-deletes. See kb-queries.ts for the full algorithm.
   */
  upsertFact?(params: {
    entityId: string;
    attribute: string;
    value: string;
    validFrom?: string;
    confidence?: number;
    sourceEventId?: string | null;
    language?: string;
    namespace?: string;
    now: string;
  }): KbFact;

  /** Idempotent relation upsert (support++ on conflict by unique edge). */
  upsertRelation?(rel: KbRelationInput): KbRelation;

  /** Current (HEAD) facts for an entity: superseded_by IS NULL AND valid_to IS NULL. */
  queryHeadFacts?(entityId: string): KbFact[];
  /**
   * ALL facts for an entity (HEAD + superseded/historical), ordered by attribute
   * then valid_from. Phase-5 entity-page projection uses this for the
   * Current-facts + History sections. Returns [] when KB off.
   */
  queryAllFacts?(entityId: string): KbFact[];
  queryEntityById?(id: string): KbEntity | null;
  queryEntityByKey?(namespace: string, type: string, canonicalKey: string): KbEntity | null;

  /**
   * Fetch a single fact by id (any version — HEAD or historical). Phase-4
   * retrieval uses this to verify a fact hit is still the HEAD before showing
   * it and to render its display text. Returns null when not found / KB off.
   */
  queryFactById?(id: string): KbFact | null;
  /** Fetch a single (immutable) event by id. Returns null when not found / KB off. */
  queryEventById?(id: string): KbEvent | null;
  /**
   * Entity-name match for retrieval (candidate source C): normalized query
   * tokens → entities whose name / alias / canonical_key contains a token,
   * ranked by token coverage. Deterministic, NO LLM. Empty/none → [].
   */
  queryEntitiesByTokens?(tokens: string[], namespace?: string, limit?: number): KbEntity[];

  // ── Phase-5 projection read primitives (deterministic persona/scene/page) ──
  //
  // These feed the deterministic projections (projections.ts). All are pure,
  // namespace-scoped, bounded reads; NO LLM, NO mutation. Optional so non-sqlite
  // backends can adopt them incrementally. Return [] when KB off.

  /**
   * List entities in a namespace, optionally filtered to `types`, ordered by
   * importance DESC then updated_time DESC. `limit` bounds the result.
   */
  listEntities?(namespace?: string, opts?: { types?: string[]; limit?: number }): KbEntity[];
  /**
   * Recent events in a namespace (newest world-time first), optionally only
   * those with `ts` strictly after `sinceTs`. `limit` bounds the result.
   */
  listRecentEvents?(namespace?: string, opts?: { sinceTs?: string; limit?: number }): KbEvent[];

  /** All events for a session (chronological). Optional — backends may omit. */
  listEventsBySession?(sessionKey: string): KbEvent[];

  /**
   * Most recent event of a given type for a session_key, or undefined. Optional.
   * session_key is the verified-stable per-project join (the `project` column is
   * empty on captured events).
   */
  latestEventBySessionKeyType?(sessionKey: string, type: string): KbEvent | undefined;
  /**
   * All relation edges touching an entity (as src OR dst), within its namespace.
   * Powers the entity-page "Related [[entity]]" links.
   */
  queryRelationsForEntity?(entityId: string): KbRelation[];
  /**
   * Events referencing an entity (its id is in entities_json), newest first.
   * Powers the entity-page "Timeline".
   */
  queryEventsForEntity?(entityId: string, namespace?: string, limit?: number): KbEvent[];

  /**
   * HEAD lessons (Mistake Notebook) whose trigger pattern involves `fileEntityId`.
   * Powers Track B's proactive injection: a recurring-failure lesson resurfaces
   * when the agent touches a file in its trigger. Returns [] when KB/lessons off.
   */
  queryHeadLessonsByFile?(fileEntityId: string, namespace?: string, limit?: number): KbLessonHit[];

  /**
   * B3: record that a lesson resurfaced into a matching situation this session.
   * Best-effort, off the critical path. Absent on non-KB backends → caller no-ops.
   */
  recordLessonExposure?(lessonId: string, sessionId: string, now: string): void;

  /**
   * B3: explicit (Phase B) avoidance credit — the agent confirmed it followed a
   * lesson. Returns whether a row was updated. Best-effort. Absent → caller no-ops.
   */
  creditLessonAvoidance?(lessonId: string, now: string): boolean;

  /**
   * Pilastro B: record that a stance FIRED a hard interrupt (bumps its fire count).
   * Best-effort, off the critical path. Absent on non-KB backends → caller no-ops.
   */
  recordStanceFire?(lessonId: string, now: string): void;

  /**
   * Pilastro B: Lorenzo CONFIRMED a stance interrupt mattered → willingness rises.
   * Returns whether a row was updated. Best-effort. Absent → caller no-ops.
   */
  creditStanceConfirmed?(lessonId: string, now: string): boolean;

  /**
   * Pilastro B: Lorenzo REJECTED a stance interrupt as a false alarm → willingness
   * falls (cry-wolf). Returns whether a row was updated. Best-effort. Absent → no-op.
   */
  creditStanceRejected?(lessonId: string, now: string): boolean;

  /**
   * B3: credit successful avoidances for lessons exposed this session that did not
   * relapse (implicit, Phase A), and temper those that did. Returns counts.
   * Off the critical path; caller fires it on session end. Absent → caller no-ops.
   */
  creditSessionAvoidances?(sessionId: string, now: string): { credited: number; tempered: number };

  /**
   * Track B write side: distill recurring-failure clusters into `lessons` (LLM).
   * Idempotent (clusters already turned into a lesson are skipped). Off the
   * critical path; callers fire-and-forget it on session end. Returns run stats.
   * Absent on backends without KB write + clustering support → caller no-ops.
   */
  runLessonDistillation?(
    llmRunner: import("../types.js").LLMRunner,
    opts: { now: string; namespace?: string; maxClusters?: number },
  ): Promise<{ candidates: number; inserted: number; superseded: number; skippedDuplicate: number }>;

  /**
   * Percorso B (behavioral notebook) write side: distill recurring cross-session
   * BEHAVIORAL tendencies into `usage` atoms via SEMANTIC clustering (no LLM —
   * deterministic wiring). Idempotent (clusters already covered are skipped).
   * Off the critical path; fire-and-forget. Absent on backends without KB write
   * + vector support → caller no-ops.
   */
  runUsageDistillation?(
    llmRunner: import("../types.js").LLMRunner,
    opts: { now: string; namespace?: string; maxClusters?: number },
  ): Promise<{ candidates: number; confirmed: number; inserted: number; skippedDuplicate: number; skippedRejected: number }>;

  /** kb_vec / kb_fts recall primitives (mirror searchL1Vector / searchL1Fts). */
  searchKbVector?(queryEmbedding: Float32Array, topK?: number, ownerKindFilter?: string): KbVectorSearchResult[];
  searchKbFts?(ftsQuery: string, limit?: number): KbFtsSearchResult[];

  /** kb_vec / kb_fts chunked write (mirror the l1 chunked write). */
  upsertKbVector?(
    ownerId: string,
    ownerKind: string,
    chunks: Float32Array | Float32Array[],
    updatedTime?: string,
  ): boolean;
  upsertKbFts?(params: {
    ownerId: string;
    ownerKind: string;
    content: string;
    entityType?: string;
    namespace?: string;
    attribute?: string;
    updatedTime?: string;
  }): boolean;
}

// ============================
// IEmbeddingService — re-exported from embedding.ts for convenience
// ============================

/**
 * Re-export EmbeddingService as IEmbeddingService for backward compatibility.
 * The canonical definition lives in `./embedding.ts`. All concrete implementations
 * (LocalEmbeddingService, OpenAIEmbeddingService, NoopEmbeddingService) implement
 * the EmbeddingService interface from embedding.ts.
 */
export type { EmbeddingService as IEmbeddingService } from "./embedding.js";
