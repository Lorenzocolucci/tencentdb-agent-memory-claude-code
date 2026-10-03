/**
 * Worker process entry — owns every heavy job so the HTTP gateway never runs one.
 *
 * Spawned (and supervised) by the gateway via `child_process.fork`. It runs a
 * `TdaiCore({ role: "worker" })` on its own event loop and its own SQLite connection:
 *   - the capture-inbox drain (L0 index, embeddings, pipeline notify),
 *   - the extraction pipeline (L1/L2/L3, applyKbDelta), consolidation, recap, distillation,
 *   - the cornerstone build (once per cooldown, corpus-wide),
 *   - the nav-index build / compaction / snapshot persist,
 *   - the gateway's heavy HTTP operations (session end, digest, kb write, seed, confirm/reject).
 *
 * Safety rails: it refuses to run unless `TDAI_WORKER_PARENT_PID` is its real parent, takes the
 * exclusive `worker.lock` (a second worker never drains the inbox), exits when the IPC channel
 * closes or the parent dies, and writes crashes to `worker.crash.log`.
 */
import path from "node:path";
import { TdaiCore } from "../core/tdai-core.js";
import { CaptureInbox } from "../core/capture-inbox.js";
import { StandaloneHostAdapter } from "../adapters/standalone/host-adapter.js";
import { SessionFilter } from "../utils/session-filter.js";
import { loadGatewayConfig, type GatewayConfig } from "../gateway/config.js";
import { installCrashHandlers } from "../gateway/crash-log.js";
import { acquireGatewayLock, isPidAlive, type GatewayLock } from "../gateway/gateway-lock.js";
import { createCaptureProcessor } from "../gateway/capture-processor.js";
import { runSeedRequest } from "../gateway/seed-service.js";
import { parseKbDelta } from "../core/kb/extraction-schema.js";
import { SeedValidationError } from "../core/seed/input.js";
import { initDataDirectories } from "../utils/pipeline-factory.js";
import { snapshotHeavyTasks } from "../core/diagnostics/inflight-registry.js";
import { readEventLoopLag, startEventLoopMonitor } from "../core/diagnostics/event-loop-monitor.js";
import type { Logger } from "../core/types.js";
import type { CaptureRequest, SeedRequest } from "../gateway/types.js";
import {
  PAYLOAD_SCHEMAS,
  parseGatewayMessage,
  type WorkerEvent,
  type WorkerOp,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";

const TAG = "[tdai-worker]";
const HEARTBEAT_MS = 5_000;
const INBOX_RESCAN_MS = 10_000;
const PARENT_POLL_MS = 5_000;
/** How long to wait for a dying previous worker to release `worker.lock` (env override for tests). */
const LOCK_WAIT_MS = Math.max(0, Number(process.env.TDAI_WORKER_LOCK_WAIT_MS) || 45_000);
const SHUTDOWN_GRACE_MS = 10_000;
/** Owner ids are flushed to the gateway at most this often (batched + deduped). */
const OWNER_FLUSH_MS = 200;

const EXIT_NOT_FORKED = 2;
const EXIT_WRONG_PARENT = 3;
const EXIT_LOCK_HELD = 4;

function stamp(msg: string): string {
  return `${new Date().toISOString()} ${TAG} ${msg}`;
}

function createLogger(): Logger {
  return {
    debug: (msg: string) => console.debug(stamp(msg)),
    info: (msg: string) => console.info(stamp(msg)),
    warn: (msg: string) => console.warn(stamp(msg)),
    error: (msg: string) => console.error(stamp(msg)),
  };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface NavStore {
  setKbVecChangeListener?(l: ((ownerId: string) => void) | null): void;
  setKbNavPublishedListener?(l: (() => void) | null): void;
}

async function acquireWorkerLock(dataDir: string, logger: Logger): Promise<GatewayLock | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return await acquireGatewayLock(dataDir, { fileName: "worker.lock" });
    } catch (err) {
      // A previous worker (killed with its gateway) can still be flushing its last item.
      if (Date.now() > deadline) {
        logger.error(`could not take worker.lock within ${LOCK_WAIT_MS}ms: ${errMsg(err)}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function main(): Promise<void> {
  const send = process.send?.bind(process);
  if (!send) {
    process.stderr.write("tdai-worker: must be started by the gateway (no IPC channel)\n");
    process.exit(EXIT_NOT_FORKED);
  }
  const parentPid = Number(process.env.TDAI_WORKER_PARENT_PID);
  if (!Number.isInteger(parentPid) || parentPid <= 0 || parentPid !== process.ppid) {
    process.stderr.write(`tdai-worker: TDAI_WORKER_PARENT_PID (${process.env.TDAI_WORKER_PARENT_PID}) is not my parent (${process.ppid})\n`);
    process.exit(EXIT_WRONG_PARENT);
  }

  const config: GatewayConfig = loadGatewayConfig();
  const dataDir = config.data.baseDir;
  installCrashHandlers(dataDir, (code) => process.exit(code), process, "worker.crash.log");
  const logger = createLogger();
  startEventLoopMonitor();
  initDataDirectories(dataDir);

  const lock = await acquireWorkerLock(dataDir, logger);
  if (!lock) process.exit(EXIT_LOCK_HELD);

  const emit = (event: WorkerEvent): void => {
    try {
      send(event);
    } catch {
      /* channel closed: the disconnect handler shuts us down */
    }
  };

  const core = new TdaiCore({
    hostAdapter: new StandaloneHostAdapter({
      dataDir,
      llmConfig: config.llm,
      logger,
      platform: "gateway",
    }),
    config: config.memory,
    sessionFilter: new SessionFilter(config.memory.capture.excludeAgents),
    role: "worker",
  });

  // ---- shutdown -------------------------------------------------------------
  let inbox: CaptureInbox<CaptureRequest> | undefined;
  let shuttingDown = false;
  const timers: NodeJS.Timeout[] = [];
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutting down (${reason})`);
    for (const t of timers) clearInterval(t);
    const hardStop = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS + 5_000);
    hardStop.unref();
    try {
      await Promise.race([
        (async () => {
          await inbox?.stop();
          await core.destroy();
        })(),
        new Promise<void>((r) => setTimeout(r, SHUTDOWN_GRACE_MS)),
      ]);
    } catch (err) {
      logger.warn(`shutdown error (ignored): ${errMsg(err)}`);
    }
    await lock?.release().catch(() => {});
    process.exit(0);
  };
  process.on("disconnect", () => void shutdown("gateway channel closed"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  timers.push(
    setInterval(() => {
      if (!isPidAlive(parentPid)) void shutdown("parent process gone");
    }, PARENT_POLL_MS),
  );

  // ---- boot -----------------------------------------------------------------
  const ready = (async () => {
    await core.initialize();
    await core.whenStoresReady();
    wireNavNotifications(core, emit, logger);
    inbox = new CaptureInbox<CaptureRequest>({
      dir: path.join(dataDir, "capture-inbox"),
      logger,
      process: createCaptureProcessor(core, logger),
    });
    await inbox.start(); // replays whatever a previous worker / the gateway left behind
    timers.push(setInterval(() => inbox?.poke(), INBOX_RESCAN_MS)); // safety net for a missed kick
    core.resumeExtraction().catch((err) => logger.warn(`extraction resume failed (non-fatal): ${errMsg(err)}`));
  })();

  const handlers = createHandlers(core, () => inbox, config, logger);
  process.on("message", (raw: unknown) => {
    const msg = parseGatewayMessage(raw);
    if (!msg) {
      logger.warn(`ignored malformed message from gateway`);
      return;
    }
    if (msg.t === "shutdown") {
      void shutdown("shutdown requested");
      return;
    }
    void handleRequest(msg, ready, handlers, send, logger);
  });

  timers.push(
    setInterval(() => {
      const lag = readEventLoopLag();
      const m = process.memoryUsage();
      emit({
        t: "hb",
        at: Date.now(),
        rss: m.rss,
        heapUsed: m.heapUsed,
        active: snapshotHeavyTasks(0).active.map((a) => a.name),
        lagP99Ms: lag?.p99Ms ?? 0,
        lagMaxMs: lag?.maxMs ?? 0,
      });
    }, HEARTBEAT_MS),
  );

  await ready;
  emit({ t: "ready", pid: process.pid });
  logger.info(`worker ready pid=${process.pid} dataDir=${dataDir}`);
}

/** Forward kb_vec owner writes (batched) and nav-snapshot publications to the gateway. */
function wireNavNotifications(core: TdaiCore, emit: (e: WorkerEvent) => void, logger: Logger): void {
  const store = core.getVectorStore() as NavStore | undefined;
  if (!store?.setKbVecChangeListener) return;
  const dirty = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    timer = null;
    if (dirty.size === 0) return;
    const owners = [...dirty];
    dirty.clear();
    emit({ t: "kb-owners", owners });
  };
  store.setKbVecChangeListener((ownerId) => {
    dirty.add(ownerId);
    if (!timer) {
      timer = setTimeout(flush, OWNER_FLUSH_MS);
      timer.unref();
    }
  });
  store.setKbNavPublishedListener?.(() => {
    logger.info("nav snapshot published - telling the gateway to reload");
    emit({ t: "nav-published" });
  });
}

type Handler = (payload: unknown) => Promise<unknown> | unknown;

function createHandlers(
  core: TdaiCore,
  inbox: () => CaptureInbox<CaptureRequest> | undefined,
  config: GatewayConfig,
  logger: Logger,
): Record<WorkerOp, Handler> {
  const parse = <K extends keyof typeof PAYLOAD_SCHEMAS>(op: K, payload: unknown) =>
    PAYLOAD_SCHEMAS[op].parse(payload) as ReturnType<(typeof PAYLOAD_SCHEMAS)[K]["parse"]>;
  return {
    ping: () => {
      const m = process.memoryUsage();
      return { pid: process.pid, uptimeS: Math.round(process.uptime()), rss: m.rss, heapUsed: m.heapUsed };
    },
    "capture-kick": () => {
      inbox()?.poke();
      return {};
    },
    "build-cornerstone": async (payload) => {
      parse("build-cornerstone", payload);
      const block = await core.buildCornerstoneShared();
      return block === undefined ? { pending: true } : { block };
    },
    distill: () => {
      core.scheduleDistillationNow();
      return {};
    },
    "session-end": async (payload) => {
      await core.handleSessionEnd(parse("session-end", payload).sessionKey);
      return {};
    },
    digest: async (payload) => core.digestBacklogSession(parse("digest", payload).sessionKey),
    "kb-write": async (payload) => {
      const { delta, opts } = parse("kb-write", payload);
      const validation = parseKbDelta(delta);
      if (!validation.ok) throw new Error(`Invalid KbDelta: ${validation.error}`);
      return core.applyDelta(validation.delta, opts);
    },
    "resolve-gated": async (payload) => core.resolveGatedMemory(parse("resolve-gated", payload)),
    seed: async (payload) => {
      const { body } = parse("seed", payload);
      try {
        return await runSeedRequest(body as SeedRequest, { config, logger });
      } catch (err) {
        if (err instanceof SeedValidationError) {
          throw Object.assign(new Error(err.message), { code: "seed-validation", details: err.errors });
        }
        throw err;
      }
    },
  };
}

async function handleRequest(
  req: WorkerRequest,
  ready: Promise<void>,
  handlers: Record<WorkerOp, Handler>,
  send: (m: WorkerResponse) => boolean,
  logger: Logger,
): Promise<void> {
  const respond = (res: WorkerResponse): void => {
    if (req.op === "capture-kick") return; // fire-and-forget on the gateway side
    try {
      send(res);
    } catch (err) {
      logger.warn(`could not answer ${req.op}#${req.id}: ${errMsg(err)}`);
    }
  };
  try {
    if (req.op !== "ping") await ready;
    const result = await handlers[req.op](req.payload);
    respond({ t: "res", id: req.id, ok: true, result });
  } catch (err) {
    const { code, details } = err as { code?: unknown; details?: unknown };
    respond({
      t: "res",
      id: req.id,
      ok: false,
      error: errMsg(err),
      ...(typeof code === "string" ? { code } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }
}

main().catch((err) => {
  process.stderr.write(`tdai-worker failed: ${String(err)}\n`);
  process.exit(1);
});
