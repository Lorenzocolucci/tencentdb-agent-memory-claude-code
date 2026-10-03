/**
 * Gateway lifecycle (2026-10-03): port bound before core.initialize() with 503
 * "starting" until ready, exclusive gateway.lock, X-TDAI-Deadline-Ms handling,
 * capture idempotency, memory in /health. Real TdaiGateway instances on random
 * ports and temp dirs - never the live store or port 8421.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiGateway } from "../server.js";
import { GatewayLockHeldError, GATEWAY_LOCK_FILE } from "../gateway-lock.js";
import { parseConfig } from "../../config.js";
import type { CaptureInbox } from "../../core/capture-inbox.js";
import type { TdaiCore } from "../../core/tdai-core.js";

const TOKEN = "lifecycle-test-token";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function request(
  port: number,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port, path: pathname, method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(text); } catch { json = { raw: text }; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

interface Harness { gateway: TdaiGateway; port: number; dir: string }

async function makeGateway(dir?: string): Promise<Harness> {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gw-life-"));
  const port = await freePort();
  vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
  const gateway = new TdaiGateway({
    server: { port, host: "127.0.0.1" },
    data: { baseDir: d },
    llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "unused" },
    memory: parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } }),
  });
  return { gateway, port, dir: d };
}

const internals = (g: TdaiGateway) =>
  g as unknown as { core: TdaiCore; captureInbox: CaptureInbox; ready: boolean };

describe("gateway lifecycle", () => {
  const started: Harness[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const h of started.splice(0)) await h.gateway.stop().catch(() => {});
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function boot(dir?: string): Promise<Harness> {
    const h = await makeGateway(dir);
    dirs.push(h.dir);
    await h.gateway.start();
    started.push(h);
    return h;
  }

  it("binds the port first and answers 503 starting on every route until core.initialize() finishes", async () => {
    const h = await makeGateway();
    dirs.push(h.dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const core = internals(h.gateway).core;
    const realInit = core.initialize.bind(core);
    vi.spyOn(core, "initialize").mockImplementation(async () => { await gate; await realInit(); });

    const startP = h.gateway.start();
    // Wait until the socket accepts connections (listen precedes initialize).
    let health = { status: 0, json: {} as Record<string, unknown> };
    for (let i = 0; i < 100; i++) {
      try { health = await request(h.port, "GET", "/health"); break; } catch { await new Promise((r) => setTimeout(r, 20)); }
    }
    expect(health.status).toBe(503);
    expect(health.json).toEqual({ status: "starting" });
    const recall = await request(h.port, "POST", "/recall", { query: "q", session_key: "s" });
    expect(recall.status).toBe(503);
    expect(recall.json).toEqual({ status: "starting" });

    release();
    await startP;
    started.push(h);
    const after = await request(h.port, "GET", "/health");
    expect(after.json.status).not.toBe("starting");
  });

  it("a second gateway on the same data dir is refused with GatewayLockHeldError; the first keeps serving", async () => {
    const first = await boot();
    const second = await makeGateway(first.dir);
    await expect(second.gateway.start()).rejects.toBeInstanceOf(GatewayLockHeldError);
    expect(fs.existsSync(path.join(first.dir, GATEWAY_LOCK_FILE))).toBe(true);
    const health = await request(first.port, "GET", "/health");
    expect(health.json.status).not.toBe("starting");
  });

  it("the refused gateway never drains the shared capture inbox", async () => {
    const first = await boot();
    const second = await makeGateway(first.dir);
    const processSpy = vi.fn();
    const inbox = internals(second.gateway).captureInbox as unknown as { processItem: unknown };
    inbox.processItem = processSpy;
    fs.mkdirSync(path.join(first.dir, "capture-inbox"), { recursive: true });
    await expect(second.gateway.start()).rejects.toBeInstanceOf(GatewayLockHeldError);
    expect(processSpy).not.toHaveBeenCalled();
  });

  it("stop() releases the lock so the next gateway can start", async () => {
    const first = await boot();
    await first.gateway.stop();
    started.length = 0;
    expect(fs.existsSync(path.join(first.dir, GATEWAY_LOCK_FILE))).toBe(false);
    await boot(first.dir);
  });

  it("takes over a stale lock left by a dead pid", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gw-stale-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, GATEWAY_LOCK_FILE), JSON.stringify({ pid: 2_147_483_000 }));
    await boot(dir);
    const owner = JSON.parse(fs.readFileSync(path.join(dir, GATEWAY_LOCK_FILE), "utf-8")) as { pid: number };
    expect(owner.pid).toBe(process.pid);
  });

  it("recall passes min(cfg, header-500) from X-TDAI-Deadline-Ms to the core, floor 500", async () => {
    const h = await boot();
    const core = internals(h.gateway).core;
    const spy = vi.spyOn(core, "handleBeforeRecall").mockResolvedValue({});
    const body = { query: "q", session_key: "s" };

    await request(h.port, "POST", "/recall", body, { "X-TDAI-Deadline-Ms": "4500" });
    expect(spy.mock.calls[0]![4]).toEqual({ recallTimeoutMs: 4000 });

    await request(h.port, "POST", "/recall", body, { "X-TDAI-Deadline-Ms": "60000" });
    expect(spy.mock.calls[1]![4]).toEqual({ recallTimeoutMs: 5000 }); // cfg default stands as the cap

    await request(h.port, "POST", "/recall", body, { "X-TDAI-Deadline-Ms": "600" });
    expect(spy.mock.calls[2]![4]).toEqual({ recallTimeoutMs: 500 });

    await request(h.port, "POST", "/recall", body);
    expect(spy.mock.calls[3]![4]).toEqual({ recallTimeoutMs: undefined });
  });

  it("POST /capture with the same idempotency_key stores once", async () => {
    const h = await boot();
    const inbox = internals(h.gateway).captureInbox;
    const processed: string[] = [];
    (inbox as unknown as { processItem: (i: { id: string }) => Promise<void> }).processItem = async (i) => {
      processed.push(i.id);
    };
    const body = { user_content: "u", assistant_content: "a", session_key: "s", idempotency_key: "abc123" };
    const r1 = await request(h.port, "POST", "/capture", body);
    await inbox.idle();
    const r2 = await request(h.port, "POST", "/capture", body);
    await inbox.idle();
    expect(r1.status).toBe(200);
    expect(r1.json.duplicate).toBeUndefined();
    expect(r2.status).toBe(200);
    expect(r2.json.duplicate).toBe(true);
    expect(processed).toHaveLength(1);
  });

  it("/health reports process and machine memory", async () => {
    const h = await boot();
    const res = await request(h.port, "GET", "/health");
    const mem = res.json.memory as Record<string, number>;
    for (const k of ["rss", "heapUsed", "external", "machineFree", "machineTotal"]) {
      expect(typeof mem[k]).toBe("number");
      expect(mem[k]).toBeGreaterThan(0);
    }
  });
});
