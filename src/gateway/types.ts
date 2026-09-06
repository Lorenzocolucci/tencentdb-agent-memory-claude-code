/**
 * TDAI Gateway — Request/Response types for the HTTP API.
 */

// ============================
// Common
// ============================

export interface GatewayErrorResponse {
  error: string;
  code?: string;
}

// ============================
// /health
// ============================

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
  /**
   * Real embedding liveness: "ok" when a tiny embed("ping") (or the circuit
   * breaker) reports the embedding path works, "failing" when it does not.
   * The result is cached (see HEALTH_EMBEDDING_TTL_MS) so /health stays cheap.
   */
  embedding: "ok" | "failing";
  /**
   * ISO timestamp of the newest captured message, or null when unknown/empty.
   *
   * NO SILENT FAILURE: "the gateway answers" and "the gateway is still being
   * fed" are different questions. From 2026-08-13 to 08-22 the first was true
   * and the second false, and nothing in /health could tell them apart.
   */
  last_capture_at?: string | null;
  /**
   * Durable capture inbox (2026-09-06): how many accepted captures still wait
   * to be written, the age of the oldest one, and how many were parked after
   * repeated failures. "Accepted" is not "written": this is where the gap shows.
   */
  capture_backlog?: number;
  capture_oldest_pending_s?: number | null;
  capture_failed?: number;
}

// ============================
// /recall
// ============================

export interface RecallRequest {
  query: string;
  session_key: string;
  user_id?: string;
  /** Project the session is in (basename of cwd) — selects per-project principles. */
  project?: string;
  /** cc session id (changes per session) — session-open banner once-per-session key. */
  session_id?: string;
}

export interface RecallResponse {
  context: string;
  strategy?: string;
  memory_count?: number;
}

// ============================
// /observe (PostToolUse — proactive injection by situation)
// ============================

export interface ObserveRequest {
  session_key: string;
  tool_name: string;
  tool_input?: unknown;
  tool_output_is_error?: boolean;
  /**
   * Raw tool output when the call FAILED (friction capture: the failure becomes
   * a `bug` event), OR — when `tool_risk` is present — the first ~400 chars of
   * the output of a destructive command that SUCCEEDED. Otherwise ignored.
   */
  tool_output_text?: string;
  /**
   * CONTRACT point 1 (2026-09-05): the plugin flags a destructive command
   * (rm -rf, git checkout --, force push, …). A SUCCESSFUL one is recorded as an
   * `observation` event tagged destructive and becomes the session's "last
   * risky signature" so the user's next correction can be linked to it. Only
   * "destructive" is accepted for now; anything else is a 400.
   */
  tool_risk?: "destructive";
}

export interface ObserveResponse {
  /** Memory to inject (additionalContext), or "" for silence. */
  context: string;
}

// ============================
// /capture
// ============================

export interface CaptureRequest {
  user_content: string;
  assistant_content: string;
  session_key: string;
  session_id?: string;
  user_id?: string;
  messages?: unknown[];
}

export interface CaptureResponse {
  /**
   * Since 2026-09-06 `/capture` acknowledges as soon as the request is
   * durably written to the capture inbox; the L0 write happens afterwards.
   * `l0_recorded` therefore mirrors `accepted` (the number of messages taken
   * into custody) so clients built for the old synchronous contract keep
   * advancing their cursor on a truthful signal: accepted turns are never lost
   * (the inbox survives restarts and is replayed).
   */
  l0_recorded: number;
  scheduler_notified: boolean;
  /** Messages durably accepted into the inbox. */
  accepted: number;
  /** Always true: the write is asynchronous. */
  queued: boolean;
  /** Inbox item id (file name stem) for tracing. */
  inbox_id: string;
}

// ============================
// /search/memories
// ============================

export interface MemorySearchRequest {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface MemorySearchResponse {
  results: string;
  total: number;
  strategy: string;
}

// ============================
// /search/conversations
// ============================

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  session_key?: string;
}

export interface ConversationSearchResponse {
  results: string;
  total: number;
}

// ============================
// /session/end
// ============================

export interface SessionEndRequest {
  session_key: string;
  user_id?: string;
}

export interface SessionEndResponse {
  flushed: boolean;
}

// ============================
// /memory/confirm + /memory/reject (Grounded Trust ask-loop, Phase 3)
// ============================

/**
 * Body of `POST /memory/confirm` and `POST /memory/reject`: Lorenzo's answer to
 * a gated (pending_confirmation) memory, re-bound by the Claude Code skills
 * `/memory-confirm <owner_id>` / `/memory-reject <owner_id>`. Same Bearer auth
 * as every other route.
 */
export interface GatedMemoryRequest {
  owner_id: string;
  owner_kind: "fact" | "event";
}

/** 200 `{ok:true}` when applied; 409 `{ok:false}` when the store could not apply it. */
export interface GatedMemoryResponse {
  ok: boolean;
  text: string;
}

// ============================
// /seed
// ============================

/**
 * Request body for `POST /seed`.
 *
 * Accepts the same input formats as the CLI `seed` command:
 * - Format A: `{ sessions: [{ sessionKey, conversations: [[...msgs]] }] }`
 * - Format B: `[{ sessionKey, conversations: [[...msgs]] }]`
 *
 * Wrapped in an envelope with optional control fields.
 */
export interface SeedRequest {
  /**
   * Seed input data — either Format A object or Format B array.
   * This is the same structure accepted by `openclaw memory-tdai seed --input`.
   */
  data: unknown;
  /** Fallback session key when input sessions lack one. */
  session_key?: string;
  /** Require each round to have both user and assistant messages. */
  strict_round_role?: boolean;
  /** Auto-fill missing timestamps (default: true). */
  auto_fill_timestamps?: boolean;
  /** Plugin config overrides (deep-merged on top of gateway memory config). */
  config_override?: Record<string, unknown>;
}

export interface SeedResponse {
  sessions_processed: number;
  rounds_processed: number;
  messages_processed: number;
  l0_recorded: number;
  duration_ms: number;
  output_dir: string;
}

// ============================
// /kb/write (deterministic external fact ingestion)
// ============================

/**
 * One flat fact in the simplified `/kb/write` form. `entity_type` may be any
 * string — out-of-vocabulary types are coerced to "concept" by
 * normalizeRawKbDelta; `attribute` is coerced to snake_case. A group of facts
 * sharing (entity_type, entity_name) is written under one entity.
 */
export interface KbWriteFact {
  entity_type: string;
  entity_name: string;
  attribute: string;
  value: string;
  confidence?: number;
}

/**
 * Request body for `POST /kb/write` — the deterministic external write path.
 * Provide EITHER the simplified `facts` array (converted to a KbDelta
 * server-side) OR a full pre-built `delta` (validated as-is). `facts` takes
 * precedence: when it is present and non-empty the handler uses it and ignores
 * `delta`; `delta` is used only when `facts` is absent or empty.
 */
export interface KbWriteRequest {
  /** Simplified flat facts — the ergonomic form. */
  facts?: KbWriteFact[];
  /** OR a full KbDelta object (power form) — validated by parseKbDelta. */
  delta?: unknown;
  /**
   * Namespace to write under. Default "default" — the namespace proactive
   * recall reads (see tdai-core NAMESPACE); override only for isolated corpora.
   */
  namespace?: string;
  /** Project tag stored on entities/events (provenance; cross-project recall). */
  project?: string;
  /** Session key stamped on inserted events (default "external:kb-write"). */
  session_key?: string;
  /** Language tag for the delta (default "und"). */
  language?: string;
}

export interface KbWriteResponse {
  ok: boolean;
  entities_written: number;
  facts_written: number;
  events_written: number;
  relations_written: number;
  embedded: number;
}
