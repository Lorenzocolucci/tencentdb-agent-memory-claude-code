import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClient } from "../lib/gateway-client.js";
import type { GatewayClient as GatewayClientType } from "../lib/gateway-client.js";
import { handleHook } from "../lib/hook.js";
import { readAlarms } from "../lib/alarm.js";

let server: http.Server | undefined;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tdai-starting-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

describe("gateway booting (503 {status:'starting'}) is alive, not ready", () => {
  it("recall -> error 'refused': skips fallback 1, leaves the miss counter alone", async () => {
    const s = http.createServer((_q, res) => {
      res.statusCode = 503;
      res.end(JSON.stringify({ status: "starting" }));
    });
    server = s;
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });
    expect(await c.recall("q", "sk")).toMatchObject({ context: "", error: "refused" });
  });

  it("session-start raises no alarm while the gateway is starting", async () => {
    const client = {
      healthDetailed: vi.fn(async () => ({ status: "starting" as const, reachable: true })),
    } as unknown as GatewayClientType;
    await handleHook("session-start", { stdin: "{}", client, dataDir: dir });
    expect(await readAlarms(dir)).toHaveLength(0);
  });
});
