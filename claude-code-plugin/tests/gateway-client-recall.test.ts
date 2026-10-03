import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GatewayClient } from "../lib/gateway-client.js";
import { RECALL_TIMEOUT_MS } from "../lib/budget.js";

let server: http.Server | undefined;
afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function stub(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<number> {
  const s = http.createServer(handler);
  server = s;
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

describe("GatewayClient.recall: error classification", () => {
  it("success -> error null, and the deadline header carries the client timeout", async () => {
    let header: string | string[] | undefined;
    const port = await stub((req, res) => {
      header = req.headers["x-tdai-deadline-ms"];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ context: "ctx" }));
    });
    const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });
    const r = await c.recall("q", "sk");
    expect(r.context).toBe("ctx");
    expect(r.error).toBeNull();
    expect(header).toBe(String(RECALL_TIMEOUT_MS));
  });

  it("empty-but-answered -> error null (not a failure)", async () => {
    const port = await stub((_q, res) => res.end(JSON.stringify({ context: "" })));
    const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });
    expect(await c.recall("q", "sk")).toMatchObject({ context: "", error: null });
  });

  it("nothing listening -> error 'refused'", async () => {
    const port = await stub((_q, res) => res.end("{}"));
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });
    expect(await c.recall("q", "sk")).toMatchObject({ context: "", error: "refused" });
  });

  it("no answer in time -> error 'timeout'", async () => {
    const port = await stub(() => {
      /* never answer */
    });
    const c = new GatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "t",
      recallTimeoutMs: 150,
    });
    const r = await c.recall("q", "sk");
    expect(r).toMatchObject({ context: "", error: "timeout" });
  });
});

describe("GatewayClient.captureTurn: idempotency key", () => {
  it("is sent in the JSON body", async () => {
    let body = "";
    const port = await stub((req, res) => {
      req.on("data", (c) => (body += c));
      req.on("end", () => res.end(JSON.stringify({ l0_recorded: 2, scheduler_notified: true })));
    });
    const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });
    await c.captureTurn({
      user_content: "u",
      assistant_content: "a",
      session_key: "sk",
      idempotency_key: "abc",
    });
    expect(JSON.parse(body).idempotency_key).toBe("abc");
  });
});
