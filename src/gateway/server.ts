/**
 * TDAI Gateway — HTTP server for the Hermes sidecar.
 *
 * Exposes TDAI Core capabilities as HTTP endpoints:
 *   GET  /health              — Health check
 *   POST /recall              — Memory recall (prefetch)
 *   POST /capture             — Conversation capture (sync_turn)
 *   POST /search/memories     — L1 memory search
 *   POST /search/conversations — L0 conversation search
 *   POST /session/end         — Session end + flush
 *   POST /seed               — Batch seed historical conversations (L0 → L1)
 *
 * Built with Node.js native `http` module — no Express/Fastify dependency.
 * Designed to run as a managed sidecar alongside Hermes.
 */

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { TdaiCore } from "../core/tdai-core.js";
import { StandaloneHostAdapter } from "../adapters/standalone/host-adapter.js";
import { loadGatewayConfig } from "./config.js";
import type { GatewayConfig } from "./config.js";
import { initDataDirectories } from "../utils/pipeline-factory.js";
import { SessionFilter } from "../utils/session-filter.js";
import { composeRecallContext } from "./recall-context.js";
import type {
  HealthResponse,
  RecallRequest,
  RecallResponse,
  ObserveRequest,
  ObserveResponse,
  CaptureRequest,
  CaptureResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  SessionEndRequest,
  SessionEndResponse,
  SeedRequest,
  SeedResponse,
  GatewayErrorResponse,
} from "./types.js";
import type { Logger } from "../core/types.js";
import { validateAndNormalizeRaw, fillTimestamps, SeedValidationError } from "../core/seed/input.js";
import { executeSeed } from "../core/seed/seed-runtime.js";
import type { SeedProgress } from "../core/seed/types.js";

const TAG = "[tdai-gateway]";
const VERSION = "0.1.0";

// ── HTTP server timeouts ──────────────────────────────────
// A wedged handler must not hold a connection forever. /seed can legitimately
// run for minutes, so requestTimeout is generous (10 min) rather than 0, while
// headers/idle are short so half-open or idle sockets are reaped quickly.
const HTTP_REQUEST_TIMEOUT_MS = 600_000; // 10 min — accommodates long /seed
const HTTP_HEADERS_TIMEOUT_MS = 30_000; // time to receive request headers
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 60_000; // idle keep-alive socket lifetime

// ── /health embedding liveness cache ──────────────────────
// /health is polled frequently (hooks, daemon, start-gateway.ps1). A real
// embed("ping") on every call would add latency + cost, so we cache the result.
const HEALTH_EMBEDDING_TTL_MS = 45_000; // re-probe embedding at most every 45s
/** Tiny input used for the liveness probe — cheap, deterministic. */
const HEALTH_EMBEDDING_PROBE = "ping";

// ============================
// Console logger (for standalone gateway — no OpenClaw logger available)
// ============================

function createConsoleLogger(): Logger {
  return {
    debug: (msg: string) => console.debug(`${TAG} ${msg}`),
    info: (msg: string) => console.info(`${TAG} ${msg}`),
    warn: (msg: string) => console.warn(`${TAG} ${msg}`),
    error: (msg: string) => console.error(`${TAG} ${msg}`),
  };
}

// ============================
// Request body parser
// ============================

async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(body) as T);
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message } satisfies GatewayErrorResponse);
}

// ============================
// Config-override sanitization (security)
// ============================

/** Credential / endpoint keys that an external caller must NEVER be able to set
 *  via /seed's `config_override`. Allowing `baseUrl` would let an authenticated
 *  caller redirect our LLM/embedding traffic (and the bundled API key) to an
 *  attacker-controlled server (key exfiltration / SSRF); allowing `apiKey`
 *  would let them swap in their own key or read ours back indirectly. */
const FORBIDDEN_OVERRIDE_KEYS = ["apiKey", "baseUrl", "proxyUrl"] as const;
/** Sub-objects of the plugin config that carry credentials/endpoints. */
const CREDENTIAL_SECTIONS = ["llm", "embedding"] as const;

/**
 * Return a NEW, sanitized copy of a `config_override` object with credential and
 * endpoint keys (apiKey / baseUrl / proxyUrl) stripped from its `llm` and
 * `embedding` sub-objects. The original is never mutated. Everything else
 * (tuning knobs like model, maxTokens, temperature, timeoutMs, dimensions, …)
 * is preserved so legitimate overrides keep working.
 *
 * `stripped` lists the dotted paths that were removed, so the caller can log a
 * security-relevant event when an override tries to set forbidden keys.
 */
export function sanitizeConfigOverride(
  override: Record<string, unknown> | undefined | null,
): { sanitized: Record<string, unknown>; stripped: string[] } {
  const stripped: string[] = [];
  if (!override || typeof override !== "object") {
    return { sanitized: {}, stripped };
  }

  // Shallow copy of the top level (immutability — never touch the input).
  const sanitized: Record<string, unknown> = { ...override };

  for (const section of CREDENTIAL_SECTIONS) {
    const sub = sanitized[section];
    if (sub && typeof sub === "object" && !Array.isArray(sub)) {
      // Copy the sub-object and delete forbidden keys from the COPY only.
      const subCopy: Record<string, unknown> = { ...(sub as Record<string, unknown>) };
      for (const key of FORBIDDEN_OVERRIDE_KEYS) {
        if (key in subCopy) {
          delete subCopy[key];
          stripped.push(`${section}.${key}`);
        }
      }
      sanitized[section] = subCopy;
    }
  }

  return { sanitized, stripped };
}

// ============================
// Gateway Server
// ============================

export class TdaiGateway {
  private config: GatewayConfig;
  private logger: Logger;
  private core: TdaiCore;
  private server: http.Server | null = null;
  private startTime = Date.now();

  // Cached embedding-liveness result (see HEALTH_EMBEDDING_TTL_MS). null = not
  // probed yet. We never let a probe failure throw out of /health.
  private embeddingHealthCache: { ok: boolean; at: number } | null = null;
  /** In-flight probe promise, so concurrent /health calls share one probe. */
  private embeddingProbeInFlight: Promise<boolean> | null = null;

  constructor(configOverrides?: Partial<GatewayConfig>) {
    this.config = loadGatewayConfig(configOverrides);
    this.logger = createConsoleLogger();

    // Create host adapter
    const adapter = new StandaloneHostAdapter({
      dataDir: this.config.data.baseDir,
      llmConfig: this.config.llm,
      logger: this.logger,
      platform: "gateway",
    });

    // Create core
    this.core = new TdaiCore({
      hostAdapter: adapter,
      config: this.config.memory,
      sessionFilter: new SessionFilter(this.config.memory.capture.excludeAgents),
    });
  }

  /**
   * Start the Gateway HTTP server.
   */
  async start(): Promise<void> {
    // Initialize data directories
    initDataDirectories(this.config.data.baseDir);

    // Initialize core
    await this.core.initialize();

    // Create HTTP server
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    // Server-side timeouts so a wedged handler (e.g. a hung embedding call)
    // cannot hold a client connection open forever. requestTimeout bounds the
    // whole request; headersTimeout bounds time-to-headers; keepAliveTimeout
    // retires idle keep-alive client connections. All are deliberately longer
    // than the slowest legitimate request (seed can take minutes) EXCEPT we
    // disable requestTimeout (0) for that reason and rely on the per-call
    // timeouts inside the handlers instead, while still bounding headers/idle.
    this.server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
    this.server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;

    const { port, host } = this.config.server;

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.startTime = Date.now();
        this.logger.info(`Gateway listening on http://${host}:${port}`);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  /**
   * Gracefully stop the Gateway.
   */
  async stop(): Promise<void> {
    this.logger.info("Shutting down gateway...");

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    await this.core.destroy();
    this.logger.info("Gateway stopped");
  }

  // ============================
  // Request router
  // ============================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = url.pathname;

    // CORS headers (for development)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this.authorize(req, res)) return;

    try {
      switch (`${method} ${pathname}`) {
        case "GET /health":
          return await this.handleHealth(res);
        case "POST /recall":
          return await this.handleRecall(req, res);
        case "POST /capture":
          return await this.handleCapture(req, res);
        case "POST /search/memories":
          return await this.handleSearchMemories(req, res);
        case "POST /search/conversations":
          return await this.handleSearchConversations(req, res);
        case "POST /observe":
          return await this.handleObserve(req, res);
        case "POST /session/end":
          return await this.handleSessionEnd(req, res);
        case "POST /seed":
          return await this.handleSeed(req, res);
        default:
          sendError(res, 404, `Not found: ${method} ${pathname}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Request error [${method} ${pathname}]: ${msg}`);
      sendError(res, 500, msg);
    }
  }

  /**
   * Optional Bearer-token gate. When TDAI_GATEWAY_TOKEN (or a token file
   * pointed to by TDAI_TOKEN_PATH, loaded by cli.ts into process.env) is set,
   * every non-OPTIONS request must carry a matching `Authorization: Bearer
   * <token>` header. Comparison is timing-safe and case-insensitive on the
   * "Bearer" scheme keyword per RFC 6750 §2.1.
   *
   * Returns true if the request is authorized, false if a 401 has been sent.
   */
  private authorize(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const expectedToken = process.env.TDAI_GATEWAY_TOKEN;
    if (!expectedToken) return true;

    const authHeader = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
    const provided = match?.[1] ?? "";
    const expectedBuf = Buffer.from(expectedToken, "utf-8");
    const providedBuf = Buffer.from(provided, "utf-8");
    const ok =
      expectedBuf.length > 0 &&
      providedBuf.length === expectedBuf.length &&
      timingSafeEqual(providedBuf, expectedBuf);
    if (ok) return true;

    res.setHeader("WWW-Authenticate", 'Bearer realm="tdai-gateway"');
    sendError(res, 401, "Unauthorized");
    return false;
  }

  // ============================
  // Route handlers
  // ============================

  private async handleHealth(res: http.ServerResponse): Promise<void> {
    const embeddingOk = await this.checkEmbeddingLiveness();

    // Honest status: degraded if the vector store is missing OR the embedding
    // path is failing (recall is useless without working query embeddings).
    const storeOk = !!this.core.getVectorStore();
    const healthy = storeOk && embeddingOk;

    const response: HealthResponse = {
      status: healthy ? "ok" : "degraded",
      version: VERSION,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      stores: {
        vectorStore: storeOk,
        embeddingService: !!this.core.getEmbeddingService(),
      },
      embedding: embeddingOk ? "ok" : "failing",
    };

    // Return 503 when degraded so EVERY existing probe — daemon.ts, the cc
    // hook client, and start-gateway.ps1 (all of which gate on HTTP 200) —
    // treats a degraded embedding path as unhealthy, without changing them.
    sendJson(res, healthy ? 200 : 503, response);
  }

  /**
   * Real, CACHED embedding liveness check.
   *
   * - If the embedding service exposes a circuit breaker (getHealth) and it is
   *   currently OPEN, report failing immediately (no probe needed).
   * - Otherwise probe with a tiny embed("ping"), but at most once per
   *   HEALTH_EMBEDDING_TTL_MS so /health stays cheap. Concurrent callers share
   *   one in-flight probe. Any error → failing (never throws).
   */
  private async checkEmbeddingLiveness(): Promise<boolean> {
    const svc = this.core.getEmbeddingService();
    // No embedding service configured at all → recall can't work → failing.
    if (!svc) return false;

    // Fast path: an OPEN circuit breaker is authoritative and free.
    const breaker = svc.getHealth?.();
    if (breaker && !breaker.healthy) {
      this.embeddingHealthCache = { ok: false, at: Date.now() };
      return false;
    }

    // Serve a fresh cached result.
    const now = Date.now();
    if (this.embeddingHealthCache && now - this.embeddingHealthCache.at < HEALTH_EMBEDDING_TTL_MS) {
      return this.embeddingHealthCache.ok;
    }

    // Coalesce concurrent probes into one.
    if (!this.embeddingProbeInFlight) {
      this.embeddingProbeInFlight = (async () => {
        try {
          const vec = await svc.embed(HEALTH_EMBEDDING_PROBE, { timeoutMs: 5_000 });
          // A zero-length vector is the NoopEmbeddingService (server-side
          // embedding) — treat as ok; otherwise require a real vector.
          const ok = vec.length === 0 || vec.length > 0;
          this.embeddingHealthCache = { ok, at: Date.now() };
          return ok;
        } catch (err) {
          this.logger.warn(
            `Health embedding probe failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.embeddingHealthCache = { ok: false, at: Date.now() };
          return false;
        } finally {
          this.embeddingProbeInFlight = null;
        }
      })();
    }
    return this.embeddingProbeInFlight;
  }

  private async handleRecall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<RecallRequest>(req);

    if (!body.query || !body.session_key) {
      sendError(res, 400, "Missing required fields: query, session_key");
      return;
    }

    const startMs = Date.now();
    const result = await this.core.handleBeforeRecall(body.query, body.session_key);
    const elapsed = Date.now() - startMs;

    // Deliver BOTH the stable context (persona/scene/guide) AND the dynamic
    // situation-relevant memories. Returning only appendSystemContext silently
    // dropped the per-prompt <relevant-memories> — proactive injection OFF.
    const context = composeRecallContext({
      appendSystemContext: result.appendSystemContext,
      prependContext: result.prependContext,
    });

    this.logger.info(
      `Recall completed in ${elapsed}ms: context=${context.length} chars ` +
      `(stable=${result.appendSystemContext?.length ?? 0}, memories=${result.prependContext?.length ?? 0})`,
    );

    const response: RecallResponse = {
      context,
      strategy: result.recallStrategy,
      memory_count: result.recalledL1Memories?.length ?? 0,
    };
    sendJson(res, 200, response);
  }

  private async handleCapture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<CaptureRequest>(req);

    if (!body.user_content || !body.assistant_content || !body.session_key) {
      sendError(res, 400, "Missing required fields: user_content, assistant_content, session_key");
      return;
    }

    const startMs = Date.now();
    const result = await this.core.handleTurnCommitted({
      userText: body.user_content,
      assistantText: body.assistant_content,
      messages: body.messages ?? [
        { role: "user", content: body.user_content },
        { role: "assistant", content: body.assistant_content },
      ],
      sessionKey: body.session_key,
      sessionId: body.session_id,
    });
    const elapsed = Date.now() - startMs;

    this.logger.info(`Capture completed in ${elapsed}ms: l0=${result.l0RecordedCount}`);

    const response: CaptureResponse = {
      l0_recorded: result.l0RecordedCount,
      scheduler_notified: result.schedulerNotified,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchMemories(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<MemorySearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const result = await this.core.searchMemories({
      query: body.query,
      limit: body.limit,
      type: body.type,
      scene: body.scene,
    });

    const response: MemorySearchResponse = {
      results: result.text,
      total: result.total,
      strategy: result.strategy,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchConversations(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<ConversationSearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const result = await this.core.searchConversations({
      query: body.query,
      limit: body.limit,
      sessionKey: body.session_key,
    });

    const response: ConversationSearchResponse = {
      results: result.text,
      total: result.total,
    };
    sendJson(res, 200, response);
  }

  private async handleObserve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<ObserveRequest>(req);

    if (!body.session_key || !body.tool_name) {
      sendError(res, 400, "Missing required fields: session_key, tool_name");
      return;
    }

    const result = await this.core.handleToolObservation({
      sessionKey: body.session_key,
      toolName: body.tool_name,
      toolInput: body.tool_input,
      toolOutputIsError: body.tool_output_is_error,
    });

    const response: ObserveResponse = { context: result.inject ?? "" };
    sendJson(res, 200, response);
  }

  private async handleSessionEnd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SessionEndRequest>(req);

    if (!body.session_key) {
      sendError(res, 400, "Missing required field: session_key");
      return;
    }

    await this.core.handleSessionEnd(body.session_key);

    const response: SessionEndResponse = { flushed: true };
    sendJson(res, 200, response);
  }

  private async handleSeed(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SeedRequest>(req);

    if (!body.data) {
      sendError(res, 400, "Missing required field: data");
      return;
    }

    // Validate and normalize input (reuses seed CLI's validation layers 2-6)
    let input;
    try {
      input = validateAndNormalizeRaw(body.data, {
        sessionKey: body.session_key,
        strictRoundRole: body.strict_round_role,
        autoFillTimestamps: body.auto_fill_timestamps ?? true,
      });
    } catch (err) {
      if (err instanceof SeedValidationError) {
        sendJson(res, 400, {
          error: err.message,
          validation_errors: err.errors,
        });
        return;
      }
      throw err;
    }

    this.logger.info(
      `Seed request: ${input.sessions.length} session(s), ` +
      `${input.totalRounds} round(s), ${input.totalMessages} message(s)`,
    );

    // Resolve output directory: use gateway's data dir with a timestamped subfolder
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const outputDir = `${this.config.data.baseDir}/seed-${ts}`;

    // Merge config overrides if provided
    // Start with the base memory config + inject llm config from gateway settings
    const baseConfig = this.config.memory as unknown as Record<string, unknown>;
    let pluginConfig: Record<string, unknown> = {
      ...baseConfig,
      llm: {
        enabled: true,
        baseUrl: this.config.llm.baseUrl,
        apiKey: this.config.llm.apiKey,
        model: this.config.llm.model,
        maxTokens: this.config.llm.maxTokens,
        // RC5: honor configured temperature (Kimi/Moonshot requires exactly 1).
        temperature: this.config.llm.temperature,
        timeoutMs: this.config.llm.timeoutMs,
      },
    };
    if (body.config_override) {
      // SECURITY: strip credential/endpoint keys (apiKey / baseUrl / proxyUrl)
      // from the llm + embedding sections BEFORE merging. Without this, an
      // authenticated caller could redirect baseUrl to an attacker-controlled
      // server and exfiltrate the bundled API key (key exfil / SSRF).
      const { sanitized: safeOverride, stripped } = sanitizeConfigOverride(body.config_override);
      if (stripped.length > 0) {
        this.logger.warn(
          `Seed config_override attempted to set forbidden credential/endpoint key(s): ` +
          `${stripped.join(", ")} — ignored`,
        );
      }
      for (const key of Object.keys(safeOverride)) {
        const baseVal = pluginConfig[key];
        const overVal = safeOverride[key];
        if (baseVal && typeof baseVal === "object" && !Array.isArray(baseVal) &&
            overVal && typeof overVal === "object" && !Array.isArray(overVal)) {
          pluginConfig[key] = { ...(baseVal as Record<string, unknown>), ...(overVal as Record<string, unknown>) };
        } else {
          pluginConfig[key] = overVal;
        }
      }
    }

    // Execute seed pipeline (blocking — this may take minutes for large inputs)
    const summary = await executeSeed(input, {
      outputDir,
      openclawConfig: {},
      pluginConfig,
      logger: this.logger as import("../utils/pipeline-factory.js").PipelineLogger,
      onProgress: (progress: SeedProgress) => {
        this.logger.debug?.(
          `Seed progress: [${progress.currentRound}/${progress.totalRounds}] ` +
          `session=${progress.sessionKey} stage=${progress.stage}`,
        );
      },
    });

    this.logger.info(
      `Seed complete: sessions=${summary.sessionsProcessed}, rounds=${summary.roundsProcessed}, ` +
      `l0=${summary.l0RecordedCount}, duration=${(summary.durationMs / 1000).toFixed(1)}s`,
    );

    const response: SeedResponse = {
      sessions_processed: summary.sessionsProcessed,
      rounds_processed: summary.roundsProcessed,
      messages_processed: summary.messagesProcessed,
      l0_recorded: summary.l0RecordedCount,
      duration_ms: summary.durationMs,
      output_dir: summary.outputDir,
    };
    sendJson(res, 200, response);
  }
}

// ============================
// CLI entry point
// ============================

/**
 * Start the gateway from the command line.
 * Usage: node --import tsx src/gateway/server.ts
 */
async function main(): Promise<void> {
  const gateway = new TdaiGateway();

  // Graceful shutdown
  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.start();
}

// Auto-start when run directly
const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  main().catch((err) => {
    console.error("Gateway startup failed:", err);
    process.exit(1);
  });
}
