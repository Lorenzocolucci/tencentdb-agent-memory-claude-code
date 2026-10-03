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
 *   POST /memory/confirm      — Grounded Trust: Lorenzo confirmed a gated memory
 *   POST /memory/reject       — Grounded Trust: Lorenzo rejected a gated memory
 *   POST /seed               — Batch seed historical conversations (L0 → L1)
 *   POST /kb/write            - Deterministic external fact write (KbDelta)
 *
 * Built with Node.js native `http` module — no Express/Fastify dependency.
 * Designed to run as a managed sidecar alongside Hermes.
 */

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import os from "node:os";
import { URL } from "node:url";
import { TdaiCore } from "../core/tdai-core.js";
import { CaptureInbox } from "../core/capture-inbox.js";
import { StandaloneHostAdapter } from "../adapters/standalone/host-adapter.js";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGatewayConfig } from "./config.js";
import type { GatewayConfig } from "./config.js";
import { initDataDirectories } from "../utils/pipeline-factory.js";
import { SessionFilter } from "../utils/session-filter.js";
import { composeRecallContext } from "./recall-context.js";
import { PretoolService } from "../core/kb/pretool-service.js";
import type {
  HealthResponse,
  RecallRequest,
  RecallResponse,
  ObserveRequest,
  ObserveResponse,
  PretoolRequestBody,
  PretoolResponse,
  CaptureRequest,
  CaptureResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  SessionEndRequest,
  SessionEndResponse,
  GatedMemoryRequest,
  GatedMemoryResponse,
  SeedRequest,
  SeedResponse,
  KbWriteRequest,
  KbWriteResponse,
  GatewayErrorResponse,
} from "./types.js";
import { parseKbDelta } from "../core/kb/extraction-schema.js";
import { buildRawDeltaFromFacts } from "./kb-write-delta.js";
import type { Logger } from "../core/types.js";
import { fillTimestamps } from "../core/seed/input.js";
import { SeedValidationError } from "../core/seed/input.js";
import { runSeedRequest, sanitizeConfigOverride as sanitizeOverride } from "./seed-service.js";
import { createCaptureProcessor } from "./capture-processor.js";
import { WorkerSupervisor, WorkerRemoteError, type WorkerStatus } from "../worker/worker-supervisor.js";
import { WorkerUnavailableError } from "../core/heavy-delegate.js";
import type { WorkerEvent } from "../worker/protocol.js";
import { startEventLoopMonitor, readEventLoopLag } from "../core/diagnostics/event-loop-monitor.js";
import { beginHeavyTask, endHeavyTask } from "../core/diagnostics/inflight-registry.js";
import { acquireGatewayLock, type GatewayLock } from "./gateway-lock.js";
import { DEADLINE_HEADER, resolveRecallTimeoutMs } from "./recall-deadline.js";
import { isSlowRecall, composeSlowRecallBreadcrumb } from "../core/diagnostics/slow-recall.js";

const TAG = "[tdai-gateway]";
const VERSION = "0.1.0";

// ── HTTP server timeouts ──────────────────────────────────
// A wedged handler must not hold a connection forever. /seed and /digest can
// legitimately run for many minutes (backfill fully drains a session's L0 while
// sharing the serial L1 queue with live work), so requestTimeout is generous
// (60 min) rather than 0, while headers/idle are short so half-open or idle
// sockets are reaped quickly.
const HTTP_REQUEST_TIMEOUT_MS = 3_600_000; // 60 min — accommodates long /seed and /digest backfill
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

/** Every gateway log line starts with an ISO timestamp (logs are matched to hook.log by time). */
export function stampLogLine(msg: string, now: Date = new Date()): string {
  return `${now.toISOString()} ${TAG} ${msg}`;
}

function createConsoleLogger(): Logger {
  return {
    debug: (msg: string) => console.debug(stampLogLine(msg)),
    info: (msg: string) => console.info(stampLogLine(msg)),
    warn: (msg: string) => console.warn(stampLogLine(msg)),
    error: (msg: string) => console.error(stampLogLine(msg)),
  };
}

/** Run a handler body as a registered heavy task so a slow recall can name it. */
async function withHeavyTask<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const token = beginHeavyTask(name);
  try {
    return await fn();
  } finally {
    endHeavyTask(token);
  }
}

/** Process + machine memory for /health: paging (low free RAM) turned 1 s of work into 60 s. */
function readMemoryStats(): NonNullable<HealthResponse["memory"]> {
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    external: m.external,
    machineFree: os.freemem(),
    machineTotal: os.totalmem(),
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

/** Re-exported from seed-service.ts (kept here: tests and callers import it from the server module). */
export const sanitizeConfigOverride = sanitizeOverride;

// ============================
// Gateway Server
// ============================

/** How heavy work is executed (Phase 5). */
export interface GatewayOptions {
  /**
   * `process` (the daemon default, see cli.ts): a supervised worker process owns every heavy
   * job and this process only serves HTTP. `inline` (default for library/test use, and
   * `TDAI_WORKER=inline` as a rollback switch): everything runs in this process, as before.
   */
  workerMode?: "process" | "inline";
  /** Worker entry file; defaults to the sibling `../worker/worker-main.mjs` of the built bundle. */
  workerEntry?: string;
  /** Node flags for the worker child (tests pass the tsx loader). */
  workerExecArgv?: string[];
  workerEnv?: NodeJS.ProcessEnv;
}

/** Heap cap of the worker process (it holds its own nav index + extraction state). */
const WORKER_MAX_OLD_SPACE_MB = 3072;

export class TdaiGateway {
  private config: GatewayConfig;
  private logger: Logger;
  private core: TdaiCore;
  private server: http.Server | null = null;
  private startTime = Date.now();
  /** Durable inbox behind POST /capture (sign first, unpack later — see capture-inbox.ts). */
  private captureInbox: CaptureInbox<CaptureRequest>;
  /** Exclusive `<dataDir>/gateway.lock`; non-null = this process owns the data dir. */
  private lock: GatewayLock | null = null;
  /** False while core.initialize() runs: the port is open but every route answers 503 "starting". */
  private ready = false;
  /** Phase 4 proactive layer (PreToolUse matcher); built lazily from the live store. */
  private pretool: PretoolService | undefined;
  /** Phase 5: supervised worker process (null in inline mode). */
  private supervisor: WorkerSupervisor | null = null;
  private navReloadRunning = false;
  private navReloadPending = false;

  // Cached embedding-liveness result (see HEALTH_EMBEDDING_TTL_MS). null = not
  // probed yet. We never let a probe failure throw out of /health.
  private embeddingHealthCache: { ok: boolean; at: number } | null = null;
  /** In-flight probe promise, so concurrent /health calls share one probe. */
  private embeddingProbeInFlight: Promise<boolean> | null = null;

  constructor(configOverrides?: Partial<GatewayConfig>, options: GatewayOptions = {}) {
    this.config = loadGatewayConfig(configOverrides);
    this.logger = createConsoleLogger();
    const processMode = options.workerMode === "process";

    // Create host adapter
    const adapter = new StandaloneHostAdapter({
      dataDir: this.config.data.baseDir,
      llmConfig: this.config.llm,
      logger: this.logger,
      platform: "gateway",
    });

    // Create core. In process mode this is the HTTP side only: no scheduler, nav index
    // follows the worker's snapshot, heavy work goes to the supervisor (set below).
    this.core = new TdaiCore({
      hostAdapter: adapter,
      config: this.config.memory,
      sessionFilter: new SessionFilter(this.config.memory.capture.excludeAgents),
      role: processMode ? "gateway" : "full",
    });

    if (processMode) {
      this.supervisor = new WorkerSupervisor({
        entry: options.workerEntry ?? defaultWorkerEntry(),
        execArgv: options.workerExecArgv ?? [`--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`, ...inheritedLoaderArgs()],
        env: options.workerEnv,
        logger: this.logger,
        onEvent: (event) => this.onWorkerEvent(event),
      });
      this.core.setHeavyDelegate(this.supervisor);
    }

    this.captureInbox = new CaptureInbox<CaptureRequest>({
      dir: joinPath(this.config.data.baseDir, "capture-inbox"),
      logger: this.logger,
      // Only the lock owner may drain (a second drainer writes every capture twice).
      isOwner: () => this.lock !== null,
      // Process mode: the gateway only enqueues (durable file); the worker drains.
      drain: !processMode,
      process: createCaptureProcessor(this.core, this.logger),
    });
  }

  /**
   * Start the Gateway HTTP server.
   *
   * Order matters (2026-10-03): lock -> listen -> initialize. The port is bound
   * BEFORE the slow core initialize (boot loads ~70k vectors), so a second
   * launcher sees a busy port at once instead of racing a half-booted store,
   * and every route answers 503 {status:"starting"} until initialize is done.
   * Throws GatewayLockHeldError when another live gateway owns the data dir.
   */
  async start(): Promise<void> {
    // Diagnostics: start the passive event-loop lag monitor as EARLY as possible
    // so it captures boot-time stalls (resumeExtraction, first cornerstone build)
    // as well as live starvation. Paired with the in-flight registry, a slow
    // recall then names its own culprit instead of being guessed at.
    startEventLoopMonitor();

    // Initialize data directories
    initDataDirectories(this.config.data.baseDir);

    this.lock = await acquireGatewayLock(this.config.data.baseDir);
    try {
      await this.listen();
      await this.core.initialize();

      // Replay captures a previous process accepted but never wrote (crash,
      // kill, deploy). Runs in the background; boot is not delayed by a backlog.
      await this.captureInbox.start();
      this.ready = true;
      this.logger.info("Gateway ready");
      // Heavy work lives in the worker: spawn it only once this process owns the lock and
      // the store schema is initialised. Non-blocking: recall never waits for the worker.
      this.supervisor?.start();

      // Immune system: resume any extraction backlog frozen by the previous
      // shutdown (restart amnesia). Fire-and-forget so it never blocks boot —
      // recovery enqueues L1 passes that drain in the background.
      this.warmPretool();
      this.core.resumeExtraction().catch((err) => {
        this.logger.warn(
          `Extraction resume failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } catch (err) {
      await this.abortStart();
      throw err;
    }
  }

  private async listen(): Promise<void> {
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
    const server = this.server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        this.startTime = Date.now();
        this.logger.info(`Gateway listening on http://${host}:${port} (starting: initializing core)`);
        resolve();
      });
    });
  }

  /** Undo a failed start(): close the port and give the lock back. */
  private async abortStart(): Promise<void> {
    this.ready = false;
    const server = this.server;
    this.server = null;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.lock?.release().catch(() => {});
    this.lock = null;
  }

  /**
   * Gracefully stop the Gateway.
   */
  async stop(): Promise<void> {
    this.logger.info("Shutting down gateway...");
    this.ready = false;

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    // Finish the capture in flight, leave the rest on disk for the next start.
    await this.captureInbox.stop();
    // Worker: let it finish its current capture item, then exit (it also exits when this channel closes).
    await this.supervisor?.stop().catch((err) => {
      this.logger.warn(`Worker stop failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    await this.core.destroy();
    await this.lock?.release().catch((err) => {
      this.logger.warn(`Could not release gateway lock: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.lock = null;
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

    // Port is bound before core.initialize(): until ready, EVERY route (health
    // included) says "starting". Probes treat 503 as "alive, not ready yet".
    if (!this.ready) {
      sendJson(res, 503, { status: "starting" });
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
        case "POST /pretool":
          return await this.handlePretool(req, res);
        case "POST /session/end":
          return await this.handleSessionEnd(req, res);
        case "POST /memory/confirm":
          return await this.handleGatedMemory(req, res, "confirm");
        case "POST /memory/reject":
          return await this.handleGatedMemory(req, res, "reject");
        case "POST /digest":
          return await this.handleDigest(req, res);
        case "POST /seed":
          return await this.handleSeed(req, res);
        case "POST /kb/write":
          return await this.handleKbWrite(req, res);
        default:
          sendError(res, 404, `Not found: ${method} ${pathname}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof WorkerUnavailableError) {
        // Heavy operation while the worker restarts: the caller retries; recall/capture are unaffected.
        this.logger.warn(`Request [${method} ${pathname}] needs the worker, which is unavailable: ${msg}`);
        sendError(res, 503, msg);
        return;
      }
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
      memory: readMemoryStats(),
      event_loop: this.readLoopLag(),
      ...(this.supervisor ? { worker: this.workerHealth(this.supervisor.status()) } : {}),
      last_capture_at: await this.readLastCaptureAt(),
      ...(await this.captureInbox.status().then(
        (s) => ({
          capture_backlog: s.pending,
          capture_oldest_pending_s: s.oldestPendingAgeS,
          capture_failed: s.failed,
        }),
        () => ({}),
      )),
    };

    // Return 503 when degraded so EVERY existing probe — daemon.ts, the cc
    // hook client, and start-gateway.ps1 (all of which gate on HTTP 200) —
    // treats a degraded embedding path as unhealthy, without changing them.
    sendJson(res, healthy ? 200 : 503, response);
  }

  /**
   * Newest captured message, or null when the store cannot answer.
   *
   * Never throws and never fails the health check: an unknown value must read
   * as "unknown", not as "broken" — the caller decides what staleness means.
   */
  private async readLastCaptureAt(): Promise<string | null> {
    try {
      const store = this.core.getVectorStore() as
        | { lastCaptureAt?: () => string | null | Promise<string | null> }
        | null;
      if (!store || typeof store.lastCaptureAt !== "function") return null;
      return (await store.lastCaptureAt()) ?? null;
    } catch {
      return null;
    }
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

    // The plugin states how long it will wait; recall must answer inside that.
    const recallTimeoutMs = resolveRecallTimeoutMs(
      this.config.memory.recall.timeoutMs ?? 5000,
      req.headers[DEADLINE_HEADER],
    );

    const startMs = Date.now();
    const result = await withHeavyTask("recall", () =>
      this.core.handleBeforeRecall(body.query, body.session_key, body.project, body.session_id, {
        recallTimeoutMs,
      }),
    );
    const elapsed = Date.now() - startMs;

    // Diagnostics breadcrumb: a slow recall means the single event loop was
    // starved (node:sqlite is synchronous). Log WHO was hogging it — the
    // in-flight / just-finished heavy task + the event-loop lag — so the next
    // natural occurrence is attributed deterministically instead of guessed.
    // The lag is a rolling 10 s window with ISO timestamps (no reset needed).
    if (isSlowRecall(elapsed)) {
      this.logger.warn(composeSlowRecallBreadcrumb(elapsed));
    }

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
      ...(!context && result.silent === true ? { silent: true } : {}),
    };
    sendJson(res, 200, response);
  }

  private async handleCapture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<CaptureRequest>(req);

    if (!body.user_content || !body.assistant_content || !body.session_key) {
      sendError(res, 400, "Missing required fields: user_content, assistant_content, session_key");
      return;
    }

    // Sign for the parcel, unpack later (2026-09-06). The synchronous version
    // took ~29 s for a 50-turn batch while the plugin gave up at 12 s and the
    // cursor never advanced. Now the request is durable on disk before we
    // answer; the write happens in the inbox drain, one item at a time.
    const accepted = Array.isArray(body.messages) && body.messages.length > 0 ? body.messages.length : 2;
    const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : undefined;
    const { id, duplicate } = await this.captureInbox.enqueue(body, { idempotencyKey });
    if (!duplicate) this.supervisor?.notifyCapture();
    this.logger.info(
      duplicate
        ? `Capture ${id} duplicate ignored (idempotency_key already queued or written): session=${body.session_key}`
        : `Capture ${id} accepted: ${accepted} message(s) session=${body.session_key}`,
    );

    const response: CaptureResponse = {
      l0_recorded: accepted,
      scheduler_notified: false,
      accepted,
      queued: true,
      inbox_id: id,
      ...(duplicate ? { duplicate: true } : {}),
    };
    sendJson(res, 200, response);
  }

  /**
   * Deterministic external write: `POST /kb/write`. Accepts EITHER the simplified
   * `facts` array OR a full `delta`, validates it with parseKbDelta (the same
   * schema + vocab coercion the background extractor uses), and applies it
   * straight to the KB store via core.applyDelta. A written fact is immediately
   * recallable. Fail-loud on this route (400 on bad input, 5xx on store failure)
   * so the caller knows whether the write persisted — recall/capture stay
   * best-effort, but a deterministic writer must report the truth.
   */
  private async handleKbWrite(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<KbWriteRequest>(req);

    // Accept EITHER a full pre-built delta OR the simplified flat-facts form.
    let rawDelta: unknown;
    if (Array.isArray(body.facts) && body.facts.length > 0) {
      rawDelta = buildRawDeltaFromFacts(body.facts, body.language);
    } else if (body.delta !== undefined && body.delta !== null) {
      rawDelta = body.delta;
    } else {
      sendError(
        res,
        400,
        "Missing input: provide a non-empty `facts` array (simplified) or a `delta` object (full KbDelta).",
      );
      return;
    }

    const validation = parseKbDelta(rawDelta);
    if (!validation.ok) {
      sendError(res, 400, `Invalid KbDelta: ${validation.error}`);
      return;
    }

    // A structurally-valid but empty delta writes nothing — a caller that sent
    // no writable content is a client bug, not a silent success.
    const d = validation.delta;
    if (
      d.entities.length === 0 &&
      d.facts.length === 0 &&
      d.events.length === 0 &&
      d.relations.length === 0
    ) {
      sendError(res, 400, "Empty delta: nothing to write.");
      return;
    }

    const startMs = Date.now();
    const result = await this.core.applyDelta(validation.delta, {
      namespace: body.namespace,
      project: body.project,
      sessionKey: body.session_key,
    });
    const elapsed = Date.now() - startMs;

    this.logger.info(
      `KB write completed in ${elapsed}ms: entities=${result.entities.length}, ` +
      `facts=${result.facts.length}, events=${result.events.length}, ` +
      `relations=${result.relations.length}, embedded=${result.embedded}`,
    );

    const response: KbWriteResponse = {
      ok: true,
      entities_written: result.entities.length,
      facts_written: result.facts.length,
      events_written: result.events.length,
      relations_written: result.relations.length,
      embedded: result.embedded,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchMemories(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<MemorySearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const result = await withHeavyTask("search-memories", () =>
      this.core.searchMemories({
        query: body.query,
        limit: body.limit,
        type: body.type,
        scene: body.scene,
      }),
    );

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

    const result = await withHeavyTask("search-conversations", () =>
      this.core.searchConversations({
        query: body.query,
        limit: body.limit,
        sessionKey: body.session_key,
      }),
    );

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
    if (body.tool_risk !== undefined && body.tool_risk !== "destructive") {
      sendError(res, 400, 'Invalid field: tool_risk (expected "destructive")');
      return;
    }

    const result = await withHeavyTask("observe", () =>
      this.core.handleToolObservation({
        sessionKey: body.session_key,
        toolName: body.tool_name,
        toolInput: body.tool_input,
        toolOutputIsError: body.tool_output_is_error,
        toolOutputText: body.tool_output_text,
        toolRisk: body.tool_risk,
        project: body.project,
        skipFileMemory: body.skip_file_memory === true,
      }),
    );

    // Phase 4.3: friction is recorded by now; hand back the lesson / past fix that
    // matches this failure (same matcher as /pretool, in-memory, never throws).
    const pastFix = this.failureMatch(body);
    const context = [result.inject ?? "", pastFix].filter((p) => p !== "").join("\n\n");
    const response: ObserveResponse = { context };
    sendJson(res, 200, response);
  }

  /** Lazily create the proactive-layer service once the store is up. */
  private getPretool(): PretoolService | undefined {
    if (!this.pretool) {
      this.pretool = PretoolService.fromStore(this.core.getVectorStore(), this.logger);
    }
    return this.pretool;
  }

  /** Build the index in the background shortly after boot so the first tool call already has one. */
  private warmPretool(): void {
    const t = setTimeout(() => {
      this.getPretool()
        ?.warm()
        .catch((err) => {
          this.logger.warn(`pretool warm-up failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        });
    }, 3_000);
    (t as { unref?: () => void }).unref?.();
  }

  private failureMatch(body: ObserveRequest): string {
    if (body.tool_output_is_error !== true || !body.project) return "";
    const item = this.getPretool()?.check({
      sessionKey: body.session_key,
      project: body.project,
      cwd: body.cwd,
      toolName: body.tool_name,
      toolInput: body.tool_input,
      errorText: body.tool_output_text,
      phase: "failure",
    });
    return item ? item.text : "";
  }

  /**
   * POST /pretool — PreToolUse hook: memory that arrives BEFORE the agent acts.
   * In-memory lookup only; fails open (decision "none") on any problem.
   */
  private async handlePretool(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<PretoolRequestBody>(req);
    if (!body.session_key || !body.tool_name || typeof body.project !== "string") {
      sendError(res, 400, "Missing required fields: session_key, tool_name, project");
      return;
    }
    const item = await withHeavyTask("pretool", async () =>
      this.getPretool()?.check({
        sessionKey: body.session_key,
        project: body.project,
        cwd: body.cwd,
        toolName: body.tool_name,
        toolInput: body.tool_input,
        oneWay: body.one_way ?? null,
        phase: "pre",
      }) ?? null,
    );
    const response: PretoolResponse = item
      ? { decision: item.severity, message: item.text, lesson_id: item.lessonId }
      : { decision: "none", message: "" };
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

  /**
   * POST /memory/confirm | /memory/reject — the Grounded Trust ask-loop's answer
   * path for hosts without in-process tools (Claude Code skills). Validates the
   * body, calls TdaiCore.resolveGatedMemory, and maps its `ok` to 200/409 so the
   * skill can tell "recorded" from "the store could not apply it".
   */
  private async handleGatedMemory(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    decision: "confirm" | "reject",
  ): Promise<void> {
    const body = await parseJsonBody<Partial<GatedMemoryRequest>>(req);

    const ownerId = typeof body.owner_id === "string" ? body.owner_id.trim() : "";
    if (!ownerId) {
      sendError(res, 400, "Missing required field: owner_id");
      return;
    }
    if (body.owner_kind !== "fact" && body.owner_kind !== "event") {
      sendError(res, 400, 'Invalid or missing field: owner_kind (expected "fact" | "event")');
      return;
    }

    const result = await this.core.resolveGatedMemory({ ownerId, ownerKind: body.owner_kind, decision });
    const response: GatedMemoryResponse = { ok: result.ok, text: result.text };
    sendJson(res, result.ok ? 200 : 409, response);
  }

  /**
   * POST /digest — backfill: extract ONE session_key's un-extracted L0 into the
   * KB graph, reusing the live extraction path (primary + fallback + embeddings)
   * on the serial L1 queue (no concurrent writers). Drives the "digest the old
   * backlog" job without stopping the gateway. Idempotent + resumable.
   */
  private async handleDigest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<{ session_key?: string }>(req);
    if (!body.session_key) {
      sendError(res, 400, "Missing required field: session_key");
      return;
    }
    const result = await this.core.digestBacklogSession(body.session_key);
    sendJson(res, 200, { digested: true, processedCount: result.processedCount });
  }

  private async handleSeed(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SeedRequest>(req);

    if (!body.data) {
      sendError(res, 400, "Missing required field: data");
      return;
    }

    try {
      // Minutes of synchronous SQLite + LLM work: in process mode it runs in the worker.
      const response = this.supervisor
        ? await this.supervisor.request<SeedResponse>("seed", { body })
        : await runSeedRequest(body, { config: this.config, logger: this.logger });
      sendJson(res, 200, response);
    } catch (err) {
      if (err instanceof SeedValidationError) {
        sendJson(res, 400, { error: err.message, validation_errors: err.errors });
        return;
      }
      if (err instanceof WorkerRemoteError && err.code === "seed-validation") {
        sendJson(res, 400, { error: err.message, validation_errors: err.details });
        return;
      }
      throw err;
    }
  }

  // ============================
  // Worker integration (Phase 5)
  // ============================

  /** Event-loop lag of THIS process over the rolling window (the number Phase 5 is judged on). */
  private readLoopLag(): NonNullable<HealthResponse["event_loop"]> | undefined {
    const lag = readEventLoopLag();
    return lag ? { p99Ms: Math.round(lag.p99Ms), maxMs: Math.round(lag.maxMs), meanMs: Math.round(lag.meanMs) } : undefined;
  }

  private workerHealth(s: WorkerStatus): NonNullable<HealthResponse["worker"]> {
    return {
      state: s.state,
      pid: s.pid,
      restarts: s.restarts,
      heartbeat_age_s: s.heartbeatAgeS,
      rss: s.rss,
      active: [...s.active],
      lag_p99_ms: s.lagP99Ms === null ? null : Math.round(s.lagP99Ms),
      lag_max_ms: s.lagMaxMs === null ? null : Math.round(s.lagMaxMs),
    };
  }

  /** Worker -> gateway events: keep the nav index in step with what the worker writes. */
  private onWorkerEvent(event: WorkerEvent): void {
    const store = this.core.getVectorStore() as
      | { resyncKbOwners?: (ids: readonly string[]) => number }
      | undefined;
    if (event.t === "kb-owners") {
      store?.resyncKbOwners?.(event.owners);
    } else if (event.t === "nav-published") {
      this.reloadNavIndex(true);
    } else if (event.t === "ready" && !this.isNavIndexActive()) {
      this.reloadNavIndex(false); // a snapshot may have appeared while the worker booted
    }
  }

  private isNavIndexActive(): boolean {
    const store = this.core.getVectorStore() as { isKbNavIndexActive?: () => boolean } | undefined;
    return store?.isKbNavIndexActive?.() ?? true;
  }

  /** Reload the nav index from the worker's snapshot; overlapping requests coalesce into one rerun. */
  private reloadNavIndex(force: boolean): void {
    const store = this.core.getVectorStore() as
      | { followKbNavIndex?: (opts?: { skipIfActive?: boolean }) => Promise<boolean> }
      | undefined;
    if (!store?.followKbNavIndex) return;
    if (this.navReloadRunning) {
      this.navReloadPending = this.navReloadPending || force;
      return;
    }
    this.navReloadRunning = true;
    store
      .followKbNavIndex({ skipIfActive: !force })
      .catch((err) =>
        this.logger.warn(`nav index reload failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        this.navReloadRunning = false;
        if (this.navReloadPending) {
          this.navReloadPending = false;
          this.reloadNavIndex(true);
        }
      });
  }
}

/** `--import <loader>` flags this process was started with (e.g. tsx in dev / benchmarks), so the worker can load the same sources. */
function inheritedLoaderArgs(): string[] {
  const out: string[] = [];
  const argv = process.execArgv;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === "--import" || a === "--require" || a === "--loader") && argv[i + 1] !== undefined) {
      out.push(a, argv[i + 1]!);
      i++;
    } else if (a.startsWith("--import=") || a.startsWith("--require=") || a.startsWith("--loader=")) {
      out.push(a);
    }
  }
  return out;
}

/** The worker bundle sits next to the gateway bundle: `dist/src/gateway/cli.mjs` -> `dist/src/worker/worker-main.mjs`. */
function defaultWorkerEntry(): string {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "mjs";
  return fileURLToPath(new URL(`../worker/worker-main.${ext}`, import.meta.url));
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
