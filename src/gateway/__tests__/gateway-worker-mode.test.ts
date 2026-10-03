/**
 * Phase 5 gateway in process mode: the HTTP process owns no scheduler and no capture drain, the
 * worker process does the heavy work, /health exposes loop lag + worker state, and a dead worker
 * degrades heavy routes to 503 without touching recall / health. Real gateway + real worker child
 * (tsx) on a random port and a temp dir - never the live store or port 8421.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TdaiGateway } from "../server.js";
import { parseConfig } from "../../config.js";
import type { TdaiCore } from "../../core/tdai-core.js";
import type { WorkerSupervisor } from "../../worker/worker-supervisor.js";

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

async function call(
  port: number,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port, path: pathname, method,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { json = {}; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function until(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function l0Texts(dir: string): string[] {
  const file = path.join(dir, "vectors.db");
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

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe("gateway in process mode (worker child)", () => {
  const gateways: TdaiGateway[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const g of gateways.splice(0)) await g.stop().catch(() => {});
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function start(): Promise<{ gateway: TdaiGateway; port: number; dir: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gw-worker-"));
    dirs.push(dir);
    const port = await freePort();
    vi.stubEnv("TDAI_DATA_DIR", dir);
    vi.stubEnv("MEMORY_TENCENTDB_ROOT", dir);
    vi.stubEnv("TDAI_GATEWAY_CONFIG", "");
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    vi.stubEnv("TDAI_LLM_API_KEY", "");
    vi.stubEnv("TDAI_LLM_BASE_URL", "http://127.0.0.1:9/v1");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("DEEPINFRA_API_KEY", "");
    const gateway = new TdaiGateway(
      {
        server: { port, host: "127.0.0.1" },
        data: { baseDir: dir },
        llm: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "", model: "unused" },
        memory: parseConfig({ embedding: { provider: "none" } }),
      },
      { workerMode: "process", workerExecArgv: ["--import", "tsx"] },
    );
    gateways.push(gateway);
    await gateway.start();
    const sup = (gateway as unknown as { supervisor: WorkerSupervisor }).supervisor;
    await sup.whenReady(90_000);
    return { gateway, port, dir };
  }

  it("keeps the HTTP core free of heavy machinery and lets the worker drain captures", async () => {
    const { gateway, port, dir } = await start();
    const core = (gateway as unknown as { core: TdaiCore }).core;
    expect(core.getScheduler()).toBeUndefined(); // no extraction pipeline in the HTTP process

    const cap = await call(port, "POST", "/capture", {
      user_content: "gateway-mode user message",
      assistant_content: "gateway-mode assistant message",
      session_key: "gw-worker-session",
      idempotency_key: "gw_worker_1",
    });
    expect(cap.status).toBe(200);
    expect(cap.json.queued).toBe(true);

    await until(() => l0Texts(dir).includes("gateway-mode user message"), 60_000, "the worker to write the capture");
    expect(l0Texts(dir).filter((t) => t === "gateway-mode user message")).toHaveLength(1);
    const inbox = (gateway as unknown as { captureInbox: { status(): Promise<{ pending: number }> } }).captureInbox;
    await until(async () => (await inbox.status()).pending === 0, 30_000, "the inbox file to be removed after the write");
  }, 180_000);

  it("/health reports event-loop lag and the worker; heavy routes are served by the worker", async () => {
    const { port } = await start();
    const health = await call(port, "GET", "/health");
    const ev = health.json.event_loop as { p99Ms: number; maxMs: number } | undefined;
    expect(ev).toBeDefined();
    expect(typeof ev!.p99Ms).toBe("number");
    const worker = health.json.worker as { state: string; pid: number; restarts: number };
    expect(worker.state).toBe("ready");
    expect(worker.pid).not.toBe(process.pid);

    const end = await call(port, "POST", "/session/end", { session_key: "gw-worker-session" });
    expect(end.status).toBe(200);
    expect(end.json.flushed).toBe(true);

    const kb = await call(port, "POST", "/kb/write", {
      facts: [{ entity_name: "Worker Mode Entity", entity_type: "concept", attribute: "note", value: "written through the worker" }],
      session_key: "gw-worker-kb",
    });
    expect(kb.status).toBe(200);
    expect(kb.json.ok).toBe(true);
    expect(kb.json.entities_written).toBe(1);
  }, 180_000);

  it("a dead worker turns heavy routes into 503 but never degrades /health or recall", async () => {
    const { gateway, port } = await start();
    const sup = (gateway as unknown as { supervisor: WorkerSupervisor }).supervisor;
    const pid = sup.status().pid!;
    sup.killChildForTest();
    await until(() => sup.status().state === "down", 10_000, "worker down");

    const kb = await call(port, "POST", "/kb/write", {
      facts: [{ entity_name: "Down Entity", attribute: "note", value: "no worker" }],
    });
    expect(kb.status).toBe(503);
    const end = await call(port, "POST", "/session/end", { session_key: "x" });
    expect(end.status).toBe(503);

    const health = await call(port, "GET", "/health");
    expect((health.json.worker as { state: string }).state).toBe("down");
    const recall = await call(port, "POST", "/recall", { query: "anything at all", session_key: "gw-worker-recall" });
    expect(recall.status).toBe(200);
    expect(isAlive(pid)).toBe(false);

    await sup.whenReady(90_000); // it comes back by itself
    expect(sup.status().restarts).toBe(1);
  }, 180_000);

  it("heavy capture work in the worker does not stall the HTTP loop", async () => {
    const { gateway, port, dir } = await start();
    const inbox = (gateway as unknown as { captureInbox: { status(): Promise<{ pending: number }> } }).captureInbox;

    // This test process IS the gateway process: its own timer drift is the gateway's event-loop lag.
    let last = performance.now();
    let maxGapMs = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - last - 10);
      last = now;
    }, 10);
    try {
      const batches = 12;
      for (let b = 0; b < batches; b++) {
        const messages = Array.from({ length: 60 }, (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          content: `loop-probe batch ${b} message ${i}: sqlite wal checkpoint and fts rowid layout`,
        }));
        const res = await call(port, "POST", "/capture", {
          user_content: String(messages[0]!.content),
          assistant_content: String(messages[1]!.content),
          session_key: `loop-probe-${b}`,
          messages,
          idempotency_key: `loop_probe_${b}`,
        });
        expect(res.status).toBe(200);
      }
      // /health answers while the worker drains (503 here only means "no embedding provider in this test config").
      const health = await call(port, "GET", "/health");
      expect([200, 503]).toContain(health.status);
      await until(async () => (await inbox.status()).pending === 0, 120_000, "the worker to drain 720 messages");
    } finally {
      clearInterval(probe);
    }
    // (the capture sanitizer drops some near-duplicate messages: assert "most", not all 720)
    expect(l0Texts(dir).filter((t) => t.startsWith("loop-probe batch")).length).toBeGreaterThanOrEqual(12 * 30);
    // Generous bound for a shared dev machine; the same drain inside the HTTP process measured seconds.
    expect(maxGapMs, `max event-loop gap while the worker drained: ${maxGapMs.toFixed(0)} ms`).toBeLessThan(500);
  }, 240_000);

  it("stop() takes the worker down with the gateway", async () => {
    const { gateway } = await start();
    const sup = (gateway as unknown as { supervisor: WorkerSupervisor }).supervisor;
    const pid = sup.status().pid!;
    await gateway.stop();
    await until(() => !isAlive(pid), 20_000, "the worker process to exit");
    expect(sup.status().state).toBe("stopped");
  }, 180_000);
});
