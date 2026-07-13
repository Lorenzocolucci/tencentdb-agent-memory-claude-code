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
  l0_recorded: number;
  scheduler_notified: boolean;
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
