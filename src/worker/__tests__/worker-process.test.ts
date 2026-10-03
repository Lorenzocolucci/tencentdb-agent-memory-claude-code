/**
 * Phase 5 process boundary: the supervised worker really is a separate process, owns the capture
 * drain, survives crashes without losing or double-writing a capture, and refuses to run as an
 * orphan or as a second drainer. Real child processes (tsx), temp dirs, never the live store.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WorkerSupervisor, WorkerRemoteError } from "../worker-supervisor.js";
import { WorkerUnavailableError } from "../../core/heavy-delegate.js";
import { CaptureInbox } from "../../core/capture-inbox.js";
import type { CaptureRequest } from "../../gateway/types.js";
import type { Logger } from "../../core/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, "../worker-main.ts");
const TSX = ["--import", "tsx"];

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tdai-worker-"));
}

function workerEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    TDAI_DATA_DIR: dataDir,
    TDAI_WORKER_LOCK_WAIT_MS: "1500",
    // Hermetic: no config file from the developer's home, no real LLM / embedding credentials.
    MEMORY_TENCENTDB_ROOT: dataDir,
    TDAI_GATEWAY_CONFIG: "",
    TDAI_LLM_API_KEY: "",
    TDAI_LLM_BASE_URL: "http://127.0.0.1:9/v1",
    TDAI_FALLBACK_LLM_API_KEY: "",
    OPENAI_API_KEY: "",
    DEEPINFRA_API_KEY: "",
  };
}

async function until(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Message texts stored in the worker's L0 table (read-only connection; the worker owns writes). */
function l0Texts(dataDir: string): string[] {
  const file = path.join(dataDir, "vectors.db");
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT message_text FROM l0_conversations").all() as Array<{ message_text: string }>).map((r) => r.message_text);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function capture(n: number): CaptureRequest {
  return {
    user_content: `process-boundary user ${n}`,
    assistant_content: `process-boundary assistant ${n}`,
    session_key: "pb-session",
    session_id: "pb-session-id",
    idempotency_key: `pb_key_${n}`,
  };
}

describe("worker process boundary", () => {
  const supervisors: WorkerSupervisor[] = [];
  const children: ChildProcess[] = [];
  const dirs: string[] = [];

  function makeSupervisor(dataDir: string, extra: { initialBackoffMs?: number } = {}): WorkerSupervisor {
    const sup = new WorkerSupervisor({
      entry: ENTRY,
      execArgv: TSX,
      env: workerEnv(dataDir),
      logger: quiet,
      initialBackoffMs: extra.initialBackoffMs ?? 300,
    });
    supervisors.push(sup);
    return sup;
  }

  afterEach(async () => {
    for (const c of children.splice(0)) c.kill("SIGKILL");
    for (const s of supervisors.splice(0)) await s.stop(3000).catch(() => {});
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("starts as its own process, answers requests, and reports ready", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const sup = makeSupervisor(dir);
    sup.start();
    await sup.whenReady(60_000);
    const pong = await sup.request<{ pid: number }>("ping");
    expect(pong.pid).toBe(sup.status().pid);
    expect(pong.pid).not.toBe(process.pid);
    expect(sup.status().state).toBe("ready");
  }, 90_000);

  it("rejects a malformed payload with a remote error instead of crashing", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const sup = makeSupervisor(dir);
    sup.start();
    await sup.whenReady(60_000);
    await expect(sup.request("session-end", { wrong: true })).rejects.toBeInstanceOf(WorkerRemoteError);
    expect((await sup.request<{ pid: number }>("ping")).pid).toBe(sup.status().pid); // still alive
  }, 90_000);

  it("a capture enqueued while the worker is DOWN is written exactly once after the restart", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const sup = makeSupervisor(dir, { initialBackoffMs: 4_000 }); // keep it down long enough to enqueue
    sup.start();
    await sup.whenReady(60_000);
    const firstPid = sup.status().pid;

    sup.killChildForTest();
    await until(() => sup.status().state === "down", 10_000, "worker to be seen as down");
    await expect(sup.request("ping")).rejects.toBeInstanceOf(WorkerUnavailableError);

    // The gateway side: enqueue-only inbox writes the durable file while nobody drains.
    const inbox = new CaptureInbox<CaptureRequest>({
      dir: path.join(dir, "capture-inbox"),
      drain: false,
      process: async () => {
        throw new Error("the gateway-side inbox must never process");
      },
    });
    await inbox.start();
    for (let n = 1; n <= 3; n++) await inbox.enqueue(capture(n), { idempotencyKey: capture(n).idempotency_key });
    expect((await inbox.status()).pending).toBe(3);

    await sup.whenReady(90_000);
    expect(sup.status().pid).not.toBe(firstPid);
    expect(sup.status().restarts).toBe(1);
    await until(async () => (await inbox.status()).pending === 0, 60_000, "the restarted worker to drain the inbox");

    const texts = l0Texts(dir);
    for (let n = 1; n <= 3; n++) {
      expect(texts.filter((t) => t === `process-boundary user ${n}`)).toHaveLength(1);
      expect(texts.filter((t) => t === `process-boundary assistant ${n}`)).toHaveLength(1);
    }

    // The client re-sends a batch whose ack it never saw: the written key is a no-op.
    const again = await inbox.enqueue(capture(2), { idempotencyKey: capture(2).idempotency_key });
    expect(again.duplicate).toBe(true);
    expect((await inbox.status()).pending).toBe(0);
  }, 180_000);

  it("a worker killed mid-drain loses nothing: every enqueued capture ends up written", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const inbox = new CaptureInbox<CaptureRequest>({
      dir: path.join(dir, "capture-inbox"),
      drain: false,
      process: async () => undefined,
    });
    await inbox.start();
    const total = 8;
    for (let n = 1; n <= total; n++) await inbox.enqueue(capture(n), { idempotencyKey: capture(n).idempotency_key });

    const sup = makeSupervisor(dir);
    sup.start();
    await sup.whenReady(60_000);
    sup.killChildForTest(); // crash while the replay is (probably) in progress
    await until(async () => (await inbox.status()).pending === 0 && sup.status().state === "ready", 120_000, "drain after crash");

    const texts = l0Texts(dir);
    for (let n = 1; n <= total; n++) {
      expect(texts.filter((t) => t === `process-boundary user ${n}`).length).toBeGreaterThanOrEqual(1);
    }
    // A hard kill between the L0 write and the inbox bookkeeping replays that ONE in-flight item
    // (at-least-once, as before the split); nothing else may be written twice.
    const written = texts.filter((t) => t.startsWith("process-boundary user ")).length;
    expect(written).toBeGreaterThanOrEqual(total);
    expect(written).toBeLessThanOrEqual(total + 1);
  }, 240_000);

  it("a second worker for the same data dir does not run (worker.lock) and drains nothing", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const sup = makeSupervisor(dir);
    sup.start();
    await sup.whenReady(60_000);

    const second = fork(ENTRY, [], {
      execArgv: TSX,
      env: { ...process.env, ...workerEnv(dir), TDAI_WORKER_PARENT_PID: String(process.pid) },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(second);
    const code = await new Promise<number | null>((resolve) => second.once("exit", (c) => resolve(c)));
    expect(code).toBe(4);
  }, 90_000);

  it("refuses to start when TDAI_WORKER_PARENT_PID is not its real parent", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const child = fork(ENTRY, [], {
      execArgv: TSX,
      env: { ...process.env, ...workerEnv(dir), TDAI_WORKER_PARENT_PID: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
    expect(code).toBe(3);
  }, 60_000);

  it("exits by itself when the gateway side of the channel closes (no orphan worker)", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const child = fork(ENTRY, [], {
      execArgv: TSX,
      env: { ...process.env, ...workerEnv(dir), TDAI_WORKER_PARENT_PID: String(process.pid) },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    await new Promise<void>((resolve) => child.on("message", (m: { t?: string }) => m.t === "ready" && resolve()));
    child.disconnect();
    const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
    expect(code).toBe(0);
  }, 90_000);
});
