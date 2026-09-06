/**
 * Spins up its OWN throwaway http server on an ephemeral localhost port —
 * NEVER the live gateway (127.0.0.1:8421). Verifies postDigest's request
 * shape, response parsing, and abort handling only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { postDigest } from "../gateway-http.js";

describe("postDigest", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastRequest: { path: string; method: string; auth: string | undefined; body: string } | null;

  beforeEach(async () => {
    lastRequest = null;
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastRequest = {
          path: req.url ?? "",
          method: req.method ?? "",
          auth: req.headers.authorization,
          body,
        };
        const parsed = JSON.parse(body) as { session_key?: string };
        if (parsed.session_key === "boom") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "kaboom" }));
          return;
        }
        if (parsed.session_key === "hang") {
          // Never respond — used by the abort test.
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ digested: true, processedCount: 42 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POSTs to /digest with a Bearer token and the session_key body", async () => {
    const result = await postDigest({ baseUrl, token: "tok-123", sessionKey: "key-1" });
    expect(result).toEqual({ digested: true, processedCount: 42 });
    expect(lastRequest?.path).toBe("/digest");
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.auth).toBe("Bearer tok-123");
    expect(JSON.parse(lastRequest?.body ?? "{}")).toEqual({ session_key: "key-1" });
  });

  it("rejects on an HTTP error status", async () => {
    await expect(postDigest({ baseUrl, token: "t", sessionKey: "boom" })).rejects.toThrow(/HTTP 500/);
  });

  it("rejects via the AbortSignal when the server never responds (stall)", async () => {
    const controller = new AbortController();
    const promise = postDigest({ baseUrl, token: "t", sessionKey: "hang", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/aborted by stall watchdog/);
  });

  it("rejects immediately if the signal is already aborted before the call", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      postDigest({ baseUrl, token: "t", sessionKey: "key-1", signal: controller.signal }),
    ).rejects.toThrow(/aborted before request started/);
  });
});
