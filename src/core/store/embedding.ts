/**
 * Embedding Service: converts text to vector embeddings.
 *
 * Supports two providers:
 * - "openai": OpenAI-compatible embedding APIs (OpenAI, Azure OpenAI, self-hosted)
 * - "local": node-llama-cpp with embeddinggemma-300m GGUF model (fully offline)
 *
 * When no remote embedding is configured, automatically falls back to local provider.
 *
 * Design:
 * - Single `embed()` for one text, `embedBatch()` for multiple.
 * - `getDimensions()` returns configured vector dimensions.
 * - Throws on failure; callers decide fallback strategy.
 */

import { request as undiciRequest, Agent as UndiciAgent } from "undici";
import type { Dispatcher } from "undici";
import {
  resolveChunkOptions,
  splitIntoChunks,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_MAX_CHUNKS_PER_TEXT,
  type ChunkOptions,
} from "./chunking.js";

// ============================
// Types
// ============================

export interface OpenAIEmbeddingConfig {
  /** Provider identifier — any value other than "local" (e.g. "openai", "deepseek", "azure", "qclaw") */
  provider: string;
  /** API base URL (required — must be specified by user, e.g. "https://api.openai.com/v1") */
  baseUrl: string;
  /** API Key (required) */
  apiKey: string;
  /** Model name (required — must be specified by user) */
  model: string;
  /** Output dimensions (required — must match the chosen model) */
  dimensions: number;
  /** Local proxy URL (only for provider="qclaw") — requests are forwarded through this proxy with Remote-URL header */
  proxyUrl?: string;
  /**
   * Legacy backstop only.  Individual embed inputs are now bounded by chunking
   * (`chunkSize`), so long texts are split into overlapping chunks instead of
   * being truncated.  When set, `maxInputChars` is treated as an upper bound on
   * the effective chunk size (the smaller of `chunkSize` and `maxInputChars`
   * wins) — it never silently drops the tail of a text any more.
   */
  maxInputChars?: number;
  /** Target chunk size in characters for long inputs (default: 2000). */
  chunkSize?: number;
  /** Overlap between consecutive chunks in characters (default: 200, must be < chunkSize). */
  chunkOverlap?: number;
  /** Maximum number of chunks produced from a single text (default: 50). */
  maxChunksPerText?: number;
  /** Timeout per API call in milliseconds (default: 10000). */
  timeoutMs?: number;
}

export interface LocalEmbeddingConfig {
  provider: "local";
  /** Custom GGUF model path (default: embeddinggemma-300m from HuggingFace) */
  modelPath?: string;
  /** Model cache directory (default: node-llama-cpp default cache) */
  modelCacheDir?: string;
}

export type EmbeddingConfig = OpenAIEmbeddingConfig | LocalEmbeddingConfig;

/** Identifies the embedding provider + model for change detection. */
export interface EmbeddingProviderInfo {
  /** Provider identifier (e.g. "local", "openai", "deepseek") */
  provider: string;
  /** Model identifier (e.g. "embeddinggemma-300m", "text-embedding-3-large") */
  model: string;
}

export interface EmbeddingCallOptions {
  /** Override the default timeout for this call (milliseconds). */
  timeoutMs?: number;
}

/**
 * Liveness/health signal for an embedding service.
 *
 * `healthy` flips to false once a provider has seen K consecutive transient
 * failures (circuit breaker open) and flips back to true on the next success.
 * It lets /health report an honest "embedding: failing" instead of a blind
 * "ok" while every query embedding is silently aborting on a dead socket.
 */
export interface EmbeddingHealth {
  /** True while the embedding path is believed to be working. */
  healthy: boolean;
  /** Number of consecutive transient failures since the last success. */
  consecutiveFailures: number;
}

export interface EmbeddingService {
  /**
   * Get embedding for a single text.
   *
   * Returns ONE vector.  For long texts (e.g. recall queries that happen to be
   * long) the text is chunked and the FIRST chunk's vector is returned, so the
   * 1-vector contract this method has always had is preserved.  To index a long
   * text in full (one vector per chunk), use {@link embedChunks}.
   */
  embed(text: string, options?: EmbeddingCallOptions): Promise<Float32Array>;
  /** Get embeddings for multiple texts (batched API call) — ONE vector per input text. */
  embedBatch(texts: string[], options?: EmbeddingCallOptions): Promise<Float32Array[]>;
  /**
   * Get embeddings for a single text split into overlapping chunks.
   *
   * Returns N vectors (N >= 1), one per chunk, so the WHOLE text is indexable —
   * the tail is never silently truncated.  Callers persist all returned vectors
   * against the same parent record id.  An empty / whitespace-only input yields
   * an empty array.
   */
  embedChunks(text: string, options?: EmbeddingCallOptions): Promise<Float32Array[]>;
  /**
   * Batched variant of {@link embedChunks} for MANY texts at once.
   *
   * Splits every input text into overlapping chunks, embeds ALL chunks across
   * ALL texts in as few batched API calls as possible (one request carries up to
   * the provider's batch limit of chunks), then regroups the vectors back per
   * input text. Returns one Float32Array[] per input text (same order), each
   * holding that text's chunk vectors.
   *
   * WHY: per-text round-trips are latency- and per-key-concurrency-bound on a
   * remote host; packing many texts' chunks into single requests collapses tens
   * of thousands of calls into hundreds — the decisive lever for a full reindex.
   * Optional: providers that can't batch (local model, noop) omit it and callers
   * fall back to per-text {@link embedChunks}.
   */
  embedManyChunked?(texts: string[], options?: EmbeddingCallOptions): Promise<Float32Array[][]>;
  /** Return the configured vector dimensions */
  getDimensions(): number;
  /** Return provider + model identifiers for change detection */
  getProviderInfo(): EmbeddingProviderInfo;
  /**
   * Whether the service is ready to serve embed requests.
   * For remote providers (OpenAI), always true (stateless HTTP).
   * For local providers, true only after model download + load completes.
   */
  isReady(): boolean;
  /**
   * Start background warmup (model download + load).
   * For remote providers, this is a no-op.
   * For local providers, triggers async initialization without blocking.
   * Safe to call multiple times (idempotent).
   */
  startWarmup(): void;
  /**
   * Optional circuit-breaker health signal.
   *
   * Remote providers (OpenAI) implement this to surface a "degraded" state
   * after K consecutive transient HTTP failures, so /health can report the
   * embedding path honestly. Providers that can't fail this way (local model,
   * noop) may omit it; callers must treat a missing implementation as healthy.
   */
  getHealth?(): EmbeddingHealth;
  /** Optional: release resources (model memory, GPU, etc.) on shutdown */
  close?(): void | Promise<void>;
}

/**
 * Error thrown when embed() / embedBatch() is called before the local
 * embedding model has finished downloading and loading.
 * Callers should catch this and fall back to keyword-only mode.
 */
export class EmbeddingNotReadyError extends Error {
  constructor(message?: string) {
    super(message ?? "Local embedding model is not ready yet (still downloading or loading)");
    this.name = "EmbeddingNotReadyError";
  }
}

// ============================
// Logger interface
// ============================

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const TAG = "[memory-tdai][embedding]";

// ============================
// Local (node-llama-cpp) implementation
// ============================

/** Default model: Google's embeddinggemma-300m, quantized Q8_0 (~300MB) */
const DEFAULT_LOCAL_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";

/** embeddinggemma-300m outputs 768-dimensional vectors */
const LOCAL_DIMENSIONS = 768;

/**
 * embeddinggemma-300m has a 256-token context window.
 * As a safe heuristic, we limit input to ~600 chars for CJK text
 * (CJK characters typically tokenize to 1-2 tokens each,
 *  so 600 chars ≈ 200-400 tokens, keeping well within 256-token limit
 *  after accounting for special tokens).
 * For Latin text, ~800 chars is a safe limit (~200 tokens).
 * We use 512 chars as a conservative universal limit.
 */
const LOCAL_MAX_INPUT_CHARS = 512;

/**
 * Sanitize NaN/Inf values and L2-normalize the vector.
 * Matches OpenClaw's own sanitizeAndNormalizeEmbedding().
 */
function sanitizeAndNormalize(vec: number[] | Float32Array): Float32Array {
  const arr = Array.from(vec).map((v) => (Number.isFinite(v) ? v : 0));
  const magnitude = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
  if (magnitude < 1e-10) {
    return new Float32Array(arr);
  }
  return new Float32Array(arr.map((v) => v / magnitude));
}

/**
 * Initialization state for LocalEmbeddingService.
 * - "idle":         not started yet
 * - "initializing": model download / load is in progress (background)
 * - "ready":        model is loaded and ready to serve
 * - "failed":       initialization failed (will retry on next startWarmup)
 */
type LocalInitState = "idle" | "initializing" | "ready" | "failed";

/** Function that dynamically imports node-llama-cpp. Overridable for testing. */
export type ImportLlamaFn = () => Promise<{
  getLlama: (opts: { logLevel: number }) => Promise<unknown>;
  resolveModelFile: (model: string, cacheDir?: string) => Promise<string>;
  LlamaLogLevel: { error: number };
}>;

const defaultImportLlama: ImportLlamaFn = () => import("node-llama-cpp") as unknown as ReturnType<ImportLlamaFn>;

export class LocalEmbeddingService implements EmbeddingService {
  private readonly modelPath: string;
  private readonly modelCacheDir?: string;
  private readonly logger?: Logger;
  private readonly importLlama: ImportLlamaFn;

  // Initialization state machine
  private initState: LocalInitState = "idle";
  private initPromise: Promise<void> | null = null;
  private initError: Error | null = null;
  private embeddingContext: {
    getEmbeddingFor: (text: string) => Promise<{ vector: Float32Array | number[] }>;
  } | null = null;

  constructor(config?: LocalEmbeddingConfig, logger?: Logger, importLlama?: ImportLlamaFn) {
    this.modelPath = config?.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
    this.modelCacheDir = config?.modelCacheDir?.trim();
    this.logger = logger;
    this.importLlama = importLlama ?? defaultImportLlama;
  }

  getDimensions(): number {
    return LOCAL_DIMENSIONS;
  }

  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: "local", model: this.modelPath };
  }

  /**
   * Whether the local model is fully loaded and ready to serve requests.
   */
  isReady(): boolean {
    return this.initState === "ready" && this.embeddingContext !== null;
  }

  /**
   * Start background warmup: download model (if needed) and load into memory.
   * Does NOT block the caller — returns immediately.
   * Safe to call multiple times (idempotent); re-triggers on "failed" state.
   */
  startWarmup(): void {
    if (this.initState === "initializing" || this.initState === "ready") {
      return; // already in progress or done
    }
    this.logger?.info(`${TAG} Starting background warmup for local embedding model...`);
    this.initState = "initializing";
    this.initError = null;

    this.initPromise = this._doInitialize()
      .then(() => {
        this.initState = "ready";
        this.logger?.info(`${TAG} Background warmup complete — local embedding ready`);
      })
      .catch((err) => {
        this.initState = "failed";
        this.initError = err instanceof Error ? err : new Error(String(err));
        this.logger?.error(
          `${TAG} Background warmup failed: ${this.initError.message}. ` +
          `embed() calls will throw EmbeddingNotReadyError until retried.`,
        );
      });
  }

  /**
   * Get embedding for a single text.
   * @throws {EmbeddingNotReadyError} if model is not yet ready.
   */
  async embed(text: string, _options?: EmbeddingCallOptions): Promise<Float32Array> {
    this.assertReady();
    const truncated = this.truncateInput(text);
    const embedding = await this.embeddingContext!.getEmbeddingFor(truncated);
    return sanitizeAndNormalize(embedding.vector);
  }

  /**
   * Get embeddings for multiple texts.
   * @throws {EmbeddingNotReadyError} if model is not yet ready.
   */
  async embedBatch(texts: string[], _options?: EmbeddingCallOptions): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    this.assertReady();

    const results: Float32Array[] = [];
    for (const text of texts) {
      const truncated = this.truncateInput(text);
      const embedding = await this.embeddingContext!.getEmbeddingFor(truncated);
      results.push(sanitizeAndNormalize(embedding.vector));
    }
    return results;
  }

  /**
   * Get embeddings for a single text split into overlapping chunks.
   *
   * The local model has a tiny 256-token context window, so we chunk on
   * LOCAL_MAX_INPUT_CHARS instead of silently truncating — every part of the
   * text gets its own vector.
   */
  async embedChunks(text: string, _options?: EmbeddingCallOptions): Promise<Float32Array[]> {
    this.assertReady();
    const opts: ChunkOptions = resolveChunkOptions({
      chunkSize: LOCAL_MAX_INPUT_CHARS,
      chunkOverlap: Math.min(DEFAULT_CHUNK_OVERLAP, Math.floor(LOCAL_MAX_INPUT_CHARS / 4)),
      maxChunks: DEFAULT_MAX_CHUNKS_PER_TEXT,
    });
    const { chunks, truncated, originalLength } = splitIntoChunks(text, opts);
    if (truncated) {
      this.logger?.warn(
        `${TAG} Local embedChunks: input of ${originalLength} chars hit maxChunks=${opts.maxChunks} cap ` +
        `(chunkSize=${opts.chunkSize}); tail beyond ~${opts.maxChunks * opts.chunkSize} chars NOT indexed.`,
      );
    }
    const results: Float32Array[] = [];
    for (const chunk of chunks) {
      const embedding = await this.embeddingContext!.getEmbeddingFor(chunk);
      results.push(sanitizeAndNormalize(embedding.vector));
    }
    return results;
  }

  /**
   * Release the node-llama-cpp embedding context and model resources.
   * Safe to call multiple times (idempotent).
   */
  close(): void {
    if (this.embeddingContext) {
      try {
        const ctx = this.embeddingContext as unknown as { dispose?: () => void };
        ctx.dispose?.();
      } catch {
        // best-effort cleanup
      }
      this.embeddingContext = null;
      this.initPromise = null;
      this.initState = "idle";
      this.initError = null;
      this.logger?.info(`${TAG} Local embedding resources released`);
    }
  }

  /**
   * Assert the model is ready. Throws EmbeddingNotReadyError if not.
   */
  private assertReady(): void {
    if (this.initState === "ready" && this.embeddingContext) {
      return;
    }
    if (this.initState === "failed") {
      throw new EmbeddingNotReadyError(
        `Local embedding model initialization failed: ${this.initError?.message ?? "unknown error"}. ` +
        `Call startWarmup() to retry.`,
      );
    }
    if (this.initState === "initializing") {
      throw new EmbeddingNotReadyError(
        "Local embedding model is still loading (download/initialization in progress). Please try again later.",
      );
    }
    // "idle" — startWarmup() was never called
    throw new EmbeddingNotReadyError(
      "Local embedding model warmup has not been started. Call startWarmup() first.",
    );
  }

  /**
   * Truncate input text to stay within the model's context window.
   * embeddinggemma-300m has a 256-token limit; we use a character-based
   * heuristic (LOCAL_MAX_INPUT_CHARS) as a safe proxy.
   */
  private truncateInput(text: string): string {
    if (text.length <= LOCAL_MAX_INPUT_CHARS) return text;
    this.logger?.debug?.(
      `${TAG} Input truncated from ${text.length} to ${LOCAL_MAX_INPUT_CHARS} chars (model context limit)`,
    );
    return text.slice(0, LOCAL_MAX_INPUT_CHARS);
  }

  /**
   * Internal: perform the actual model download + load.
   * Called by startWarmup(), runs in background.
   */
  private async _doInitialize(): Promise<void> {
    // Track partially-initialized resources for cleanup on failure
    let model: { createEmbeddingContext: () => Promise<unknown>; dispose?: () => void } | undefined;
    try {
      this.logger?.debug?.(`${TAG} Loading node-llama-cpp for local embedding...`);

      // Dynamic import — node-llama-cpp is a peer dependency of OpenClaw
      const { getLlama, resolveModelFile, LlamaLogLevel } = await this.importLlama();

      const llama = await getLlama({ logLevel: LlamaLogLevel.error });
      this.logger?.debug?.(`${TAG} Llama instance created`);

      const resolvedPath = await resolveModelFile(
        this.modelPath,
        this.modelCacheDir || undefined,
      );
      this.logger?.debug?.(`${TAG} Model resolved: ${resolvedPath}`);

      model = await (llama as unknown as { loadModel: (opts: { modelPath: string }) => Promise<typeof model> }).loadModel({ modelPath: resolvedPath });
      this.logger?.debug?.(`${TAG} Model loaded, creating embedding context...`);

      this.embeddingContext = await model!.createEmbeddingContext() as typeof this.embeddingContext;
      this.logger?.info(`${TAG} Local embedding ready (model=${this.modelPath}, dims=${LOCAL_DIMENSIONS})`);
    } catch (err) {
      // Clean up partially-initialized resources to prevent leaks
      if (model?.dispose) {
        try { model.dispose(); } catch { /* best-effort */ }
      }
      this.embeddingContext = null;
      throw err;
    }
  }

  /**
   * Wait for ongoing warmup to complete (used internally by tests).
   * Returns immediately if already ready or idle.
   */
  async waitForReady(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }
}

// ============================
// OpenAI-compatible implementation
// ============================

/** Max texts per batch (OpenAI limit is 2048, we use a safe value) */
const MAX_BATCH_SIZE = 256;

/**
 * Max RETRIES (additional attempts) per API call.
 *
 * Was 0 — a single failed request was a hard failure. Over a multi-hour
 * process the pooled keep-alive TLS socket to the embedding host goes stale
 * (idle reaping by a load balancer / NAT), so the FIRST attempt reuses a dead
 * socket and throws "fetch failed" / UND_ERR_SOCKET. With 0 retries recall
 * collapsed. We now retry on a FRESH dispatcher (see _callApi) so attempt 2
 * cannot inherit the zombie socket.
 */
const MAX_RETRIES = 2;
/** Default timeout per API call in milliseconds */
const DEFAULT_API_TIMEOUT_MS = 10_000;

/**
 * Bounded socket lifetime for the dedicated undici Agent.
 *
 * The whole bug class is "a pooled socket outlives the remote's idle timeout".
 * We keep keep-alive ON for throughput but retire idle sockets quickly (10s)
 * so a socket can't sit idle long enough for an upstream LB/NAT to silently
 * kill it. connect/headers/body timeouts bound how long any single phase can
 * hang. These are deliberately conservative for a query-latency-sensitive path.
 */
const AGENT_KEEP_ALIVE_TIMEOUT_MS = 10_000; // retire idle sockets after 10s
const AGENT_KEEP_ALIVE_MAX_TIMEOUT_MS = 30_000; // absolute cap on keep-alive
const AGENT_CONNECT_TIMEOUT_MS = 10_000; // TCP+TLS connect budget
const AGENT_HEADERS_TIMEOUT_MS = 15_000; // time to first response byte
const AGENT_BODY_TIMEOUT_MS = 15_000; // time to read the response body

/**
 * Circuit-breaker threshold: after this many CONSECUTIVE transient failures the
 * embedding service reports itself unhealthy (getHealth().healthy === false).
 * A single success resets the counter and closes the breaker.
 */
const CIRCUIT_OPEN_THRESHOLD = 3;

/** Substrings/names that identify a TRANSIENT network failure worth retrying. */
const TRANSIENT_ERROR_MARKERS = [
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "fetch failed",
  "socket hang up",
  "other side closed",
  "terminated",
  // undici Agent header/body deadline: a slow (not dead) upstream — retry on a
  // fresh socket rather than treating it as a permanent client error.
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "Headers Timeout Error",
  "Body Timeout Error",
] as const;

/**
 * Decide whether an error is a transient network failure (stale socket, reset,
 * timeout, abort) that is worth retrying on a fresh connection. Client errors
 * (4xx) are NOT transient and bubble up immediately via EmbeddingApiError.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof EmbeddingApiError) {
    // Only 429 / 5xx are worth retrying; 4xx client errors are permanent.
    return !err.isClientError();
  }
  if (!(err instanceof Error)) return false;
  // AbortError = our per-call timeout fired → the request hung, retry it.
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const code = (err as NodeJS.ErrnoException).code ?? "";
  const haystack = `${err.name} ${err.message} ${code}`;
  return TRANSIENT_ERROR_MARKERS.some((m) => haystack.includes(m));
}

/**
 * Custom error class for embedding API errors that carries HTTP status code.
 * Used to distinguish non-retryable client errors (4xx except 429) from
 * retryable server errors (5xx) and rate limits (429).
 */
class EmbeddingApiError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "EmbeddingApiError";
    this.httpStatus = httpStatus;
  }
  /** Returns true for 4xx errors that should NOT be retried (excluding 429). */
  isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500 && this.httpStatus !== 429;
  }
}

interface OpenAIEmbeddingResponse {
  data: Array<{
    index: number;
    embedding: number[];
  }>;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/** Factory for the embedding HTTP dispatcher — overridable in tests. */
export type EmbeddingDispatcherFactory = () => Dispatcher;

export class OpenAIEmbeddingService implements EmbeddingService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dims: number;
  private readonly providerName: string;
  private readonly proxyUrl?: string;
  private readonly maxInputChars?: number;
  private readonly chunkOptions: ChunkOptions;
  private readonly timeoutMs: number;
  private readonly logger?: Logger;

  /**
   * Dedicated undici dispatcher with bounded socket lifetime. We use our OWN
   * Agent (not Node's process-global fetch dispatcher) so we fully control
   * keep-alive/socket-age and can RECYCLE it on a transient failure — that is
   * what guarantees a retry opens a brand-new connection instead of reusing the
   * zombie socket that caused the failure.
   */
  private dispatcher: Dispatcher;
  /** Factory used to (re)create the dispatcher; kept so retries can recycle it. */
  private readonly makeDispatcher: EmbeddingDispatcherFactory;

  // ── Circuit-breaker state ────────────────────────────────
  /** Consecutive transient failures since the last success. */
  private consecutiveFailures = 0;
  /** True once the breaker has opened (>= CIRCUIT_OPEN_THRESHOLD failures). */
  private circuitOpen = false;

  constructor(
    config: OpenAIEmbeddingConfig,
    logger?: Logger,
    dispatcherFactory?: EmbeddingDispatcherFactory,
  ) {
    if (!config.apiKey) {
      throw new Error("EmbeddingService: apiKey is required for remote provider");
    }
    if (!config.baseUrl) {
      throw new Error("EmbeddingService: baseUrl is required for remote provider");
    }
    if (!config.model) {
      throw new Error("EmbeddingService: model is required for remote provider");
    }
    if (!config.dimensions || config.dimensions <= 0) {
      throw new Error("EmbeddingService: dimensions is required for remote provider (must be a positive integer)");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dims = config.dimensions;
    this.providerName = config.provider || "openai";
    this.proxyUrl = config.proxyUrl?.trim() || undefined;
    this.maxInputChars = config.maxInputChars && config.maxInputChars > 0 ? config.maxInputChars : undefined;
    // Chunk size is the real per-input bound now.  When a (legacy) maxInputChars
    // is set we treat it as an upper bound on chunk size so existing configs that
    // lowered maxInputChars keep producing chunks no larger than they asked for.
    const requestedChunkSize = config.chunkSize && config.chunkSize > 0 ? config.chunkSize : DEFAULT_CHUNK_SIZE;
    const effectiveChunkSize = this.maxInputChars
      ? Math.min(requestedChunkSize, this.maxInputChars)
      : requestedChunkSize;
    this.chunkOptions = resolveChunkOptions({
      chunkSize: effectiveChunkSize,
      chunkOverlap: config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
      maxChunks: config.maxChunksPerText ?? DEFAULT_MAX_CHUNKS_PER_TEXT,
    });
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_API_TIMEOUT_MS;
    this.logger = logger;

    // Build a dedicated undici Agent with bounded socket lifetime. Tests can
    // inject their own factory (e.g. pointing at an unreachable host) to drive
    // the retry / circuit-breaker paths deterministically.
    this.makeDispatcher = dispatcherFactory ?? OpenAIEmbeddingService.defaultDispatcherFactory;
    this.dispatcher = this.makeDispatcher();
  }

  /**
   * Default dispatcher: an undici Agent that keeps connections alive for
   * throughput but retires idle sockets aggressively so none survives long
   * enough for an upstream load balancer / NAT to silently kill it.
   */
  private static defaultDispatcherFactory(): Dispatcher {
    // Process-scoped override: a batched reindex packs many records' chunks per
    // request, so DeepInfra's time-to-first-byte can exceed the default 15s
    // headers/body cap → "Headers Timeout Error" aborts the whole batch. The
    // reindex process sets TDAI_EMBED_AGENT_TIMEOUT_MS (e.g. 60000); the live
    // gateway does NOT set it, so recall keeps the tight 15s dead-socket cap.
    // (Live per-call latency is unaffected either way — the per-request
    // AbortSignal, ~10s by default, fires first for small live embeds.)
    // Clamp to [0, 5min]: 0 → keep the tight default; an absurd value can't leave
    // a hung reindex socket open indefinitely.
    const override = Math.min(300_000, Math.max(0, Math.floor(Number(process.env.TDAI_EMBED_AGENT_TIMEOUT_MS) || 0)));
    const headersTimeout = override > 0 ? override : AGENT_HEADERS_TIMEOUT_MS;
    const bodyTimeout = override > 0 ? override : AGENT_BODY_TIMEOUT_MS;
    return new UndiciAgent({
      keepAliveTimeout: AGENT_KEEP_ALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: AGENT_KEEP_ALIVE_MAX_TIMEOUT_MS,
      connect: { timeout: AGENT_CONNECT_TIMEOUT_MS },
      headersTimeout,
      bodyTimeout,
    });
  }

  /**
   * Throw away the current dispatcher (and every socket it pools) and build a
   * fresh one. Called between retry attempts so attempt N+1 CANNOT inherit the
   * dead keep-alive socket that made attempt N fail. destroy() is best-effort
   * and fire-and-forget — we never block the retry on socket teardown.
   */
  private recycleDispatcher(): void {
    const old = this.dispatcher;
    this.dispatcher = this.makeDispatcher();
    void Promise.resolve()
      .then(() => (old as unknown as { destroy?: () => Promise<void> }).destroy?.())
      .catch(() => {
        /* best-effort: a failed teardown must not break the retry */
      });
  }

  /**
   * Circuit-breaker health signal. Healthy until CIRCUIT_OPEN_THRESHOLD
   * consecutive transient failures; one success closes the breaker again.
   */
  getHealth(): EmbeddingHealth {
    return {
      healthy: !this.circuitOpen,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /** Record a successful API call: reset failure count, close the breaker. */
  private onApiSuccess(): void {
    if (this.circuitOpen) {
      this.logger?.info(`${TAG} Embedding service recovered — circuit closed`);
    }
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
  }

  /** Record a transient failure: bump the counter, open the breaker at K. */
  private onApiFailure(): void {
    this.consecutiveFailures += 1;
    if (!this.circuitOpen && this.consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD) {
      this.circuitOpen = true;
      this.logger?.error(
        `${TAG} Embedding service degraded — ${this.consecutiveFailures} consecutive ` +
        `failures; circuit OPEN (recall will degrade until a call succeeds).`,
      );
    }
  }

  /** Release the dedicated dispatcher (and its sockets) on shutdown. */
  async close(): Promise<void> {
    try {
      await (this.dispatcher as unknown as { close?: () => Promise<void> }).close?.();
    } catch {
      /* best-effort */
    }
  }

  getDimensions(): number {
    return this.dims;
  }

  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: this.providerName, model: this.model };
  }

  /** Remote embedding is always ready (stateless HTTP). */
  isReady(): boolean {
    return true;
  }

  /** No-op for remote embedding (no local model to warm up). */
  startWarmup(): void {
    // nothing to do — remote API is stateless
  }

  async embed(text: string, options?: EmbeddingCallOptions): Promise<Float32Array> {
    const [result] = await this.embedBatch([text], options);
    return result;
  }

  async embedBatch(texts: string[], options?: EmbeddingCallOptions): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // ONE vector per input text.  For texts longer than the chunk size we embed
    // only the FIRST chunk here (preserving the historical 1:1 contract) — long
    // texts that must be indexed in full go through embedChunks() instead.
    const firstChunks = texts.map((t) => this.firstChunk(t));

    // Split into sub-batches if needed (OpenAI batch-size limit).
    if (firstChunks.length > MAX_BATCH_SIZE) {
      const results: Float32Array[] = [];
      for (let i = 0; i < firstChunks.length; i += MAX_BATCH_SIZE) {
        const sub = firstChunks.slice(i, i + MAX_BATCH_SIZE);
        const subResults = await this._callApi(sub, options?.timeoutMs);
        results.push(...subResults);
      }
      return results;
    }

    return this._callApi(firstChunks, options?.timeoutMs);
  }

  async embedChunks(text: string, options?: EmbeddingCallOptions): Promise<Float32Array[]> {
    const { chunks, truncated, originalLength } = splitIntoChunks(text, this.chunkOptions);
    if (chunks.length === 0) return [];
    if (truncated) {
      this.logger?.warn?.(
        `${TAG} embedChunks: input of ${originalLength} chars hit maxChunks=${this.chunkOptions.maxChunks} cap ` +
        `(chunkSize=${this.chunkOptions.chunkSize}, overlap=${this.chunkOptions.chunkOverlap}); ` +
        `tail beyond the cap was NOT indexed. Raise maxChunksPerText if full coverage is required.`,
      );
    }
    if (chunks.length > 1) {
      this.logger?.debug?.(
        `${TAG} embedChunks: split ${originalLength} chars into ${chunks.length} chunk(s) ` +
        `(chunkSize=${this.chunkOptions.chunkSize}, overlap=${this.chunkOptions.chunkOverlap})`,
      );
    }

    // Sub-batch the chunks through the OpenAI batch-size limit, preserving order.
    if (chunks.length > MAX_BATCH_SIZE) {
      const results: Float32Array[] = [];
      for (let i = 0; i < chunks.length; i += MAX_BATCH_SIZE) {
        const sub = chunks.slice(i, i + MAX_BATCH_SIZE);
        const subResults = await this._callApi(sub, options?.timeoutMs);
        results.push(...subResults);
      }
      return results;
    }

    return this._callApi(chunks, options?.timeoutMs);
  }

  /**
   * Batched, chunk-aware embedding for MANY texts. Splits every text into
   * chunks, flattens all chunks into one list, embeds them via embedBatch()
   * (which itself sub-batches by the provider batch limit), then regroups the
   * resulting vectors back per input text. One request can therefore carry the
   * chunks of dozens of records, collapsing per-record round-trips.
   */
  async embedManyChunked(texts: string[], options?: EmbeddingCallOptions): Promise<Float32Array[][]> {
    if (texts.length === 0) return [];
    // boundaries[i] = [startIndexInFlat, chunkCount] for text i.
    const boundaries: Array<[number, number]> = [];
    const flat: string[] = [];
    for (const t of texts) {
      const { chunks } = splitIntoChunks(t, this.chunkOptions);
      boundaries.push([flat.length, chunks.length]);
      for (const c of chunks) flat.push(c);
    }
    // A batch of only empty/whitespace texts → one empty group per input.
    if (flat.length === 0) return texts.map(() => []);
    // embedBatch first-chunks each input; a pre-split chunk (≤ chunkSize) is
    // returned unchanged, so this yields exactly one vector per flat chunk while
    // reusing the tested MAX_BATCH_SIZE sub-batching + retry/circuit-breaker path.
    const flatVecs = await this.embedBatch(flat, options);
    return boundaries.map(([start, count]) => flatVecs.slice(start, start + count));
  }

  /**
   * Return the first chunk of a text (the whole text if it fits in one chunk).
   * Used by the single-vector embed()/embedBatch() path. No silent truncation:
   * callers that need the full text indexed use embedChunks().
   */
  private firstChunk(text: string): string {
    const { chunks } = splitIntoChunks(text, this.chunkOptions);
    return chunks[0] ?? text;
  }

  private async _callApi(texts: string[], timeoutOverride?: number): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
      dimensions: this.dims,
    };

    // Determine fetch URL and headers based on proxy mode
    const useProxy = this.providerName === "qclaw" && !!this.proxyUrl;
    const fetchUrl = useProxy ? this.proxyUrl! : `${this.baseUrl}/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (useProxy) {
      headers["Remote-URL"] = `${this.baseUrl}/embeddings`;
      this.logger?.debug?.(
        `${TAG} [qclaw-proxy] Forwarding embedding request via proxy: ${fetchUrl}, Remote-URL: ${headers["Remote-URL"]}`,
      );
    }

    // Retry loop. We use undici.request() with our OWN bounded-lifetime Agent
    // (mirrors tcvdb-client.ts) instead of global fetch, so we can recycle the
    // dispatcher between attempts and never reuse a dead pooled socket.
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // CRITICAL: before any RETRY (attempt > 0), throw away the dispatcher so
      // this attempt opens a brand-new connection. Otherwise a stale keep-alive
      // socket would be reused and the retry would fail identically.
      if (attempt > 0) {
        this.recycleDispatcher();
      }
      try {
        const { statusCode, body: respBody } = await undiciRequest(fetchUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          // Per-call deadline (unchanged contract): caps total time for this
          // attempt. AbortSignal.timeout fires a TimeoutError, treated as
          // transient and retried on a fresh socket.
          signal: AbortSignal.timeout(timeoutOverride ?? this.timeoutMs),
          dispatcher: this.dispatcher,
        });

        const respText = await respBody.text();

        if (statusCode < 200 || statusCode >= 300) {
          const err = new EmbeddingApiError(
            `Embedding API error: HTTP ${statusCode} — ${respText.slice(0, 500)}`,
            statusCode,
          );
          // Don't retry on 4xx client errors (except 429 rate limit).
          if (err.isClientError()) {
            this.onApiSuccess(); // a 4xx means the SOCKET is fine — keep breaker closed
            throw err;
          }
          lastError = err;
          this.onApiFailure();
          if (attempt < MAX_RETRIES) {
            await this.backoff(attempt);
          }
          continue;
        }

        const json = JSON.parse(respText) as OpenAIEmbeddingResponse;

        if (!json.data || !Array.isArray(json.data)) {
          throw new Error("Embedding API returned unexpected format: missing 'data' array");
        }

        // Sort by index to ensure correct order, then sanitize+normalize for consistency with local provider
        const sorted = [...json.data].sort((a, b) => a.index - b.index);
        const result = sorted.map((d) => sanitizeAndNormalize(d.embedding));
        this.onApiSuccess();
        return result;
      } catch (err) {
        // Non-retryable errors (4xx client errors) — rethrow immediately.
        if (err instanceof EmbeddingApiError && err.isClientError()) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        // Only network-transient errors should retry + count toward the breaker.
        // A malformed-response Error (e.g. bad JSON) is a hard failure: still
        // count it (the call did fail) but it won't usually be marked transient.
        if (isTransientNetworkError(err)) {
          this.onApiFailure();
          if (attempt < MAX_RETRIES) {
            await this.backoff(attempt);
            continue;
          }
        } else {
          // Non-transient, non-client error (e.g. unexpected response shape):
          // count it once and stop retrying.
          this.onApiFailure();
          break;
        }
      }
    }

    throw lastError ?? new Error("Embedding API call failed after retries");
  }

  /** Exponential backoff between retry attempts: 500ms, 1000ms, … */
  private async backoff(attempt: number): Promise<void> {
    const delay = 500 * (attempt + 1);
    await new Promise((r) => setTimeout(r, delay));
  }
}

// ============================
// Factory
// ============================

/**
 * Create an EmbeddingService from config.
 *
 * Strategy:
 * - If config has provider != "local" with valid apiKey, model, and dimensions → use remote OpenAI-compatible embedding
 * - If config has provider="local" → use node-llama-cpp local embedding
 * - If config is undefined or missing required fields → fall back to local embedding
 *
 * NOTE: For local providers, `startWarmup()` is NOT called here.
 * The caller is responsible for calling `startWarmup()` at the right time
 * (e.g. on first conversation) to avoid triggering model download during
 * short-lived CLI commands like `gateway stop` or `agents list`.
 */
export function createEmbeddingService(
  config: EmbeddingConfig | undefined,
  logger?: Logger,
): EmbeddingService {
  // Remote OpenAI-compatible provider: any provider value other than "local"
  if (config && config.provider !== "local" && "apiKey" in config && config.apiKey) {
    logger?.debug?.(`${TAG} Using remote embedding (provider=${config.provider}, model=${config.model})`);
    return new OpenAIEmbeddingService(config as OpenAIEmbeddingConfig, logger);
  }

  // Explicit local config
  if (config && config.provider === "local") {
    const localConfig = config as LocalEmbeddingConfig;
    logger?.debug?.(`${TAG} Using local embedding (node-llama-cpp, model=${localConfig.modelPath ?? DEFAULT_LOCAL_MODEL})`);
    return new LocalEmbeddingService(localConfig, logger);
  }

  // Fallback: no config or empty apiKey → use local
  logger?.debug?.(`${TAG} No remote embedding configured, falling back to local embedding (node-llama-cpp)`);
  return new LocalEmbeddingService(undefined, logger);
}

// ============================
// NoopEmbeddingService (for server-side embedding backends)
// ============================

/**
 * No-op embedding service for backends with built-in server-side embedding
 * (e.g., TCVDB with Collection-level embedding config).
 *
 * All embed() calls return an empty Float32Array because the server generates
 * vectors automatically from the text field during upsert/search.
 */
export class NoopEmbeddingService implements EmbeddingService {
  embed(_text: string): Promise<Float32Array> {
    return Promise.resolve(new Float32Array(0));
  }

  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map(() => new Float32Array(0)));
  }

  embedChunks(text: string): Promise<Float32Array[]> {
    // Server-side embedding generates vectors from text during upsert; emit a
    // single empty placeholder for non-empty input to keep the 1+ contract.
    return Promise.resolve(text.trim().length === 0 ? [] : [new Float32Array(0)]);
  }

  getDimensions(): number {
    return 0;
  }

  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: "noop", model: "server-side" };
  }

  isReady(): boolean {
    return true;
  }

  startWarmup(): void {
    // no-op
  }
}
