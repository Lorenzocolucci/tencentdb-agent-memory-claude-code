/**
 * WorkerSupervisor with a fake child process: request correlation, failure of in-flight requests when the
 * child dies, restart backoff, and the invariant that two children never exist at once (the guarantee that
 * the capture inbox has a single drainer). No real processes: see worker-process.test.ts for those.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { WorkerSupervisor, WorkerRemoteError } from "../worker-supervisor.js";
import { WorkerUnavailableError } from "../../core/heavy-delegate.js";
import { parseGatewayMessage, isWorkerEvent, isWorkerResponse } from "../protocol.js";
import type { Logger } from "../../core/types.js";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

class FakeChild extends EventEmitter {
  connected = true;
  killed = false;
  sent: unknown[] = [];
  constructor(readonly pid: number) {
    super();
  }
  send(msg: unknown): boolean {
    this.sent.push(msg);
    return true;
  }
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.die(null, "SIGKILL"));
    return true;
  }
  die(code: number | null, signal: NodeJS.Signals | null): void {
    this.connected = false;
    this.emit("exit", code, signal);
  }
  reply(msg: unknown): void {
    this.emit("message", msg);
  }
}

function harness(opts: { initialBackoffMs?: number } = {}) {
  const children: FakeChild[] = [];
  let alive = 0;
  let maxAlive = 0;
  const sup = new WorkerSupervisor({
    entry: "unused",
    logger: quiet,
    initialBackoffMs: opts.initialBackoffMs ?? 15,
    maxBackoffMs: 60,
    forkImpl: (() => {
      const c = new FakeChild(1000 + children.length);
      children.push(c);
      alive++;
      maxAlive = Math.max(maxAlive, alive);
      c.on("exit", () => alive--);
      return c as unknown as ChildProcess;
    }) as never,
  });
  return { sup, children, maxAlive: () => maxAlive };
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe("WorkerSupervisor", () => {
  const sups: WorkerSupervisor[] = [];
  afterEach(async () => {
    for (const s of sups.splice(0)) await s.stop(50).catch(() => {});
  });

  it("matches responses to requests by id and surfaces remote errors with their code", async () => {
    const { sup, children } = harness();
    sups.push(sup);
    sup.start();
    children[0]!.reply({ t: "ready", pid: 1000 });
    await sup.whenReady(1000);

    const a = sup.request<string>("ping");
    const b = sup.request<string>("digest", { sessionKey: "s" });
    const [reqA, reqB] = children[0]!.sent as Array<{ id: number; op: string }>;
    expect(reqA!.op).toBe("ping");
    children[0]!.reply({ t: "res", id: reqB!.id, ok: false, error: "boom", code: "x", details: { k: 1 } });
    children[0]!.reply({ t: "res", id: reqA!.id, ok: true, result: "pong" });
    expect(await a).toBe("pong");
    const err = (await b.catch((e: unknown) => e)) as WorkerRemoteError;
    expect(err).toBeInstanceOf(WorkerRemoteError);
    expect(err.code).toBe("x");
    expect(err.details).toEqual({ k: 1 });
  });

  it("rejects in-flight requests with WorkerUnavailableError when the child dies, then restarts it", async () => {
    const { sup, children } = harness();
    sups.push(sup);
    sup.start();
    children[0]!.reply({ t: "ready", pid: 1000 });
    await sup.whenReady(1000);

    const inflight = sup.request("session-end", { sessionKey: "s" });
    children[0]!.die(1, null);
    await expect(inflight).rejects.toBeInstanceOf(WorkerUnavailableError);
    await expect(sup.request("ping")).rejects.toBeInstanceOf(WorkerUnavailableError); // down: fails fast, no queueing

    await tick(80);
    expect(children).toHaveLength(2);
    expect(sup.status().restarts).toBe(1);
  });

  it("never runs two children at once, even through repeated crashes", async () => {
    const { sup, children, maxAlive } = harness({ initialBackoffMs: 5 });
    sups.push(sup);
    sup.start();
    for (let i = 0; i < 4; i++) {
      await tick(40);
      children[children.length - 1]!.die(1, null);
    }
    await tick(150);
    expect(children.length).toBeGreaterThanOrEqual(4);
    expect(maxAlive()).toBe(1);
  });

  it("backs off exponentially (up to the cap) between restarts of a worker that keeps dying", async () => {
    const { sup, children } = harness({ initialBackoffMs: 30 });
    sups.push(sup);
    sup.start();
    const born: number[] = [Date.now()];
    for (let i = 0; i < 3; i++) {
      const n = children.length;
      children[n - 1]!.die(1, null);
      while (children.length === n) await tick(5);
      born.push(Date.now());
    }
    const gaps = born.slice(1).map((t, i) => t - born[i]!);
    expect(gaps[0]!).toBeGreaterThanOrEqual(25); // 30 ms
    expect(gaps[1]!).toBeGreaterThanOrEqual(50); // 60 ms
    expect(gaps[2]!).toBeGreaterThanOrEqual(50); // capped at 60 ms, not 120
    expect(gaps[2]!).toBeLessThan(110);
  });

  it("ignores messages from a replaced child", async () => {
    const { sup, children } = harness({ initialBackoffMs: 5 });
    sups.push(sup);
    sup.start();
    children[0]!.reply({ t: "ready", pid: 1000 });
    children[0]!.die(1, null);
    await tick(60);
    expect(children).toHaveLength(2);
    children[0]!.reply({ t: "ready", pid: 1000 }); // late message from the dead one
    expect(sup.status().state).toBe("starting"); // still waiting for the NEW child
  });

  it("stop() asks the child to shut down and does not restart it", async () => {
    const { sup, children } = harness();
    sups.push(sup);
    sup.start();
    children[0]!.reply({ t: "ready", pid: 1000 });
    const stopping = sup.stop(2000);
    expect(children[0]!.sent).toContainEqual({ t: "shutdown" });
    children[0]!.die(0, null);
    await stopping;
    await tick(80);
    expect(children).toHaveLength(1);
    expect(sup.status().state).toBe("stopped");
  });
});

describe("worker protocol guards", () => {
  it("accepts a well-formed request and a shutdown, rejects junk", () => {
    expect(parseGatewayMessage({ t: "req", id: 1, op: "ping" })).toEqual({ t: "req", id: 1, op: "ping" });
    expect(parseGatewayMessage({ t: "shutdown" })).toEqual({ t: "shutdown" });
    expect(parseGatewayMessage({ t: "req", id: "1", op: "ping" })).toBeNull();
    expect(parseGatewayMessage({ t: "req", id: 1, op: "rm-rf" })).toBeNull();
    expect(parseGatewayMessage(null)).toBeNull();
    expect(parseGatewayMessage("shutdown")).toBeNull();
  });

  it("tells responses from events", () => {
    expect(isWorkerResponse({ t: "res", id: 3, ok: true })).toBe(true);
    expect(isWorkerResponse({ t: "res", ok: true })).toBe(false);
    expect(isWorkerEvent({ t: "kb-owners", owners: ["a"] })).toBe(true);
    expect(isWorkerEvent({ t: "nav-published" })).toBe(true);
    expect(isWorkerEvent({ t: "res", id: 1 })).toBe(false);
  });
});
