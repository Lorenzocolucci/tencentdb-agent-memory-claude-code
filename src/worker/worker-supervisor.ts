/**
 * WorkerSupervisor — runs in the HTTP gateway process.
 *
 * Spawns the worker (`child_process.fork`), restarts it with exponential backoff
 * when it dies, watches its heartbeat, and exposes the worker's operations as a
 * {@link HeavyWorkDelegate} so `TdaiCore({ role: "gateway" })` can hand heavy work over.
 *
 * Invariants:
 *  - At most ONE worker child exists at any time: a replacement is spawned only after
 *    the previous child's `exit` event (a hung child is SIGKILLed first). Together with
 *    the worker's own `worker.lock` this is what keeps the capture inbox single-drainer.
 *  - Every in-flight request is rejected with WorkerUnavailableError when the child exits.
 *  - The worker lives and dies with this process (IPC channel + parent-pid check on its side).
 */
import { fork, type ChildProcess } from "node:child_process";
import type { Logger } from "../core/types.js";
import {
  WorkerUnavailableError,
  type ApplyDeltaOptions,
  type HeavyWorkDelegate,
} from "../core/heavy-delegate.js";
import type { KbDelta } from "../core/kb/extraction-schema.js";
import type { ApplyKbDeltaResult } from "../core/kb/kb-writer.js";
import {
  OP_TIMEOUT_MS,
  isWorkerEvent,
  isWorkerResponse,
  type GatewayToWorker,
  type WorkerEvent,
  type WorkerHeartbeat,
  type WorkerOp,
} from "./protocol.js";

const TAG = "[tdai-worker-supervisor]";

export type WorkerState = "starting" | "ready" | "down" | "stopped";

export interface WorkerStatus {
  state: WorkerState;
  pid: number | null;
  restarts: number;
  /** Seconds since the last heartbeat (null before the first one). */
  heartbeatAgeS: number | null;
  rss: number | null;
  heapUsed: number | null;
  active: readonly string[];
  lagP99Ms: number | null;
  lagMaxMs: number | null;
}

export interface WorkerSupervisorOptions {
  /** Path of the worker entry (`dist/src/worker/worker-main.mjs`, or the .ts file under tsx). */
  entry: string;
  /** Node flags for the child (tests: `["--import", <tsx loader>]`; prod: heap cap). */
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  logger: Logger;
  /** Called for every worker event (kb-owners, nav-published, ...). */
  onEvent?: (event: WorkerEvent) => void;
  /** First restart delay; doubles up to `maxBackoffMs` (default 1 s / 30 s). */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** A child alive this long resets the backoff (default 60 s). */
  stableAfterMs?: number;
  /** No heartbeat for this long = hung: kill and restart (default 3 min; boot gets 10 min). */
  heartbeatTimeoutMs?: number;
  /** Test seam. */
  forkImpl?: typeof fork;
}

interface Pending {
  readonly op: WorkerOp;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The worker ran the op and it failed there (as opposed to WorkerUnavailableError: it could not run). */
export class WorkerRemoteError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkerRemoteError";
  }
}

export class WorkerSupervisor implements HeavyWorkDelegate {
  private readonly opts: WorkerSupervisorOptions;
  private readonly logger: Logger;
  private child: ChildProcess | null = null;
  private state: WorkerState = "down";
  private stopping = false;
  private restarts = 0;
  private backoffMs: number;
  private spawnedAt = 0;
  private lastHeartbeat: WorkerHeartbeat | null = null;
  private lastHeartbeatAt = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private restartTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private exitWaiters: Array<() => void> = [];

  constructor(opts: WorkerSupervisorOptions) {
    this.opts = opts;
    this.logger = opts.logger;
    this.backoffMs = opts.initialBackoffMs ?? 1_000;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Spawn the worker. Returns at once; readiness arrives as the `ready` event. */
  start(): void {
    if (this.stopping || this.child) return;
    this.spawn();
    this.watchdog = setInterval(() => this.checkHeartbeat(), 10_000);
    this.watchdog.unref();
  }

  /** Resolves when the worker reported `ready` (or rejects after `timeoutMs`). For tests and boot logging. */
  async whenReady(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.state !== "ready") {
      if (this.stopping) throw new WorkerUnavailableError("supervisor stopped");
      if (Date.now() > deadline) throw new WorkerUnavailableError("worker did not become ready in time");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Ask the worker to finish its current item and exit; kill it after `graceMs`. */
  async stop(graceMs = 10_000): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      return;
    }
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    this.send({ t: "shutdown" });
    const killer = setTimeout(() => {
      this.logger.warn(`${TAG} worker did not exit within ${graceMs}ms of shutdown - killing`);
      child.kill("SIGKILL");
    }, graceMs);
    await exited;
    clearTimeout(killer);
    this.state = "stopped";
  }

  /** Test hook: kill the current child (as a crash would). The supervisor restarts it. */
  killChildForTest(signal: NodeJS.Signals = "SIGKILL"): void {
    this.child?.kill(signal);
  }

  status(): WorkerStatus {
    const hb = this.lastHeartbeat;
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      heartbeatAgeS: this.lastHeartbeatAt ? Math.round((Date.now() - this.lastHeartbeatAt) / 1000) : null,
      rss: hb?.rss ?? null,
      heapUsed: hb?.heapUsed ?? null,
      active: hb?.active ?? [],
      lagP99Ms: hb?.lagP99Ms ?? null,
      lagMaxMs: hb?.lagMaxMs ?? null,
    };
  }

  // ---------------------------------------------------------------- spawning

  private spawn(): void {
    const forkFn = this.opts.forkImpl ?? fork;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.opts.env,
      // The worker refuses to run unless this is its real parent: no stray / orphan workers.
      TDAI_WORKER_PARENT_PID: String(process.pid),
    };
    const child = forkFn(this.opts.entry, [], {
      execArgv: this.opts.execArgv ?? [],
      env,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "json",
    });
    this.child = child;
    this.state = "starting";
    this.spawnedAt = Date.now();
    this.lastHeartbeat = null;
    this.lastHeartbeatAt = 0;
    this.logger.info(`${TAG} worker spawned pid=${child.pid} (restarts so far: ${this.restarts})`);

    child.on("message", (msg: unknown) => this.onMessage(child, msg));
    child.on("error", (err) => this.logger.error(`${TAG} worker process error: ${errMsg(err)}`));
    child.on("exit", (code, signal) => this.onExit(child, code, signal));
  }

  private onMessage(child: ChildProcess, msg: unknown): void {
    if (child !== this.child) return; // stale message from a replaced child
    if (isWorkerResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new WorkerRemoteError(msg.error, msg.code, msg.details));
      return;
    }
    if (!isWorkerEvent(msg)) return;
    if (msg.t === "ready") {
      this.state = "ready";
      this.lastHeartbeatAt = Date.now();
      this.logger.info(`${TAG} worker ready pid=${msg.pid}`);
    } else if (msg.t === "hb") {
      this.lastHeartbeat = msg;
      this.lastHeartbeatAt = Date.now();
    }
    try {
      this.opts.onEvent?.(msg);
    } catch (err) {
      this.logger.warn(`${TAG} event handler failed (non-fatal): ${errMsg(err)}`);
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return;
    this.child = null;
    const wasStopping = this.stopping;
    this.state = wasStopping ? "stopped" : "down";
    const err = new WorkerUnavailableError(`worker exited (code=${code}, signal=${signal})`);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of waiters) w();
    if (wasStopping) {
      this.logger.info(`${TAG} worker stopped (code=${code}, signal=${signal})`);
      return;
    }
    const lived = Date.now() - this.spawnedAt;
    if (lived >= (this.opts.stableAfterMs ?? 60_000)) this.backoffMs = this.opts.initialBackoffMs ?? 1_000;
    this.logger.error(
      `${TAG} worker died (code=${code}, signal=${signal}) after ${Math.round(lived / 1000)}s - restarting in ${this.backoffMs}ms`,
    );
    this.restarts++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping && !this.child) this.spawn();
    }, delay);
  }

  private checkHeartbeat(): void {
    const child = this.child;
    if (!child || this.stopping) return;
    const limit = this.state === "starting" ? 10 * 60_000 : (this.opts.heartbeatTimeoutMs ?? 3 * 60_000);
    const since = this.lastHeartbeatAt || this.spawnedAt;
    if (Date.now() - since > limit) {
      this.logger.error(`${TAG} worker silent for ${Math.round((Date.now() - since) / 1000)}s - killing it`);
      child.kill("SIGKILL");
    }
  }

  // ---------------------------------------------------------------- requests

  private send(msg: GatewayToWorker): boolean {
    const child = this.child;
    if (!child || !child.connected) return false;
    try {
      child.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  /** Request/response RPC. Rejects with WorkerUnavailableError when there is no live worker. */
  request<T = unknown>(op: WorkerOp, payload?: unknown, timeoutMs: number = OP_TIMEOUT_MS[op]): Promise<T> {
    if (this.state !== "ready" && this.state !== "starting") {
      return Promise.reject(new WorkerUnavailableError());
    }
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker op "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { op, resolve: resolve as (v: unknown) => void, reject, timer });
      if (!this.send({ t: "req", id, op, payload })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new WorkerUnavailableError());
      }
    });
  }

  /** Tell the worker a capture file was written. Silent when the worker is down (its start-up scan finds the file). */
  notifyCapture(): void {
    this.send({ t: "req", id: this.nextId++, op: "capture-kick" });
  }

  // ---------------------------------------------------------------- HeavyWorkDelegate

  async buildCornerstone(key: string): Promise<string> {
    const r = await this.request<{ block?: string; pending?: boolean }>("build-cornerstone", { key });
    // Not ready (nav index still loading in the worker): reject so the gateway does NOT cache an empty block.
    if (r.block === undefined) throw new WorkerUnavailableError("cornerstone not ready yet");
    return r.block;
  }

  scheduleDistillation(): void {
    this.request("distill").catch((err) =>
      this.logger.debug?.(`${TAG} distillation request skipped: ${errMsg(err)}`),
    );
  }

  async sessionEnd(sessionKey: string): Promise<void> {
    await this.request("session-end", { sessionKey });
  }

  digest(sessionKey: string): Promise<{ processedCount: number }> {
    return this.request("digest", { sessionKey });
  }

  applyDelta(delta: KbDelta, opts: ApplyDeltaOptions): Promise<ApplyKbDeltaResult> {
    return this.request("kb-write", { delta, opts });
  }

  resolveGated(params: {
    ownerId: string;
    ownerKind: "fact" | "event";
    decision: "confirm" | "reject";
  }): Promise<{ ok: boolean; text: string }> {
    return this.request("resolve-gated", params);
  }
}
