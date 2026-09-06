/**
 * POST /capture after 2026-09-06: the gateway signs for the turns as soon as
 * they are durably in its capture inbox and answers at once; the L0 write
 * follows. A real TdaiGateway on an ephemeral temp data dir (never the live
 * store), with embeddings/extraction off so nothing leaves the process.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiGateway } from "../server.js";
import { parseConfig } from "../../config.js";
import type { CaptureInbox } from "../../core/capture-inbox.js";

const PORT = 18437;
const TOKEN = "capture-route-test-token";

async function request(
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path: pathname, method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
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

describe("POST /capture — durable inbox, ack first", () => {
  let gateway: TdaiGateway;
  let inbox: CaptureInbox;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gw-capture-"));
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
      data: { baseDir: dir },
      llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "unused" },
      memory: parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } }),
    });
    await gateway.start();
    inbox = (gateway as unknown as { captureInbox: CaptureInbox }).captureInbox;
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("400 when a required field is missing (unchanged contract)", async () => {
    const res = await request("POST", "/capture", { user_content: "q", session_key: "s" });
    expect(res.status).toBe(400);
  });

  it("answers 200 with accepted/queued/inbox_id and the request is on disk", async () => {
    const messages = [
      { role: "user", content: "primo" }, { role: "assistant", content: "risposta 1" },
      { role: "user", content: "secondo" }, { role: "assistant", content: "risposta 2" },
    ];
    const res = await request("POST", "/capture", {
      user_content: "secondo", assistant_content: "risposta 2", session_key: "sess-a", session_id: "sid-a", messages,
    });
    expect(res.status).toBe(200);
    expect(res.json.queued).toBe(true);
    expect(res.json.accepted).toBe(4);
    // Legacy field mirrors accepted so an older plugin still advances its cursor.
    expect(res.json.l0_recorded).toBe(4);
    expect(typeof res.json.inbox_id).toBe("string");

    // Drained shortly after; the file is consumed, nothing parked.
    await inbox.idle();
    const status = await inbox.status();
    expect(status.pending).toBe(0);
    expect(status.failed).toBe(0);
    expect(fs.existsSync(path.join(dir, "capture-inbox", `${String(res.json.inbox_id)}.json`))).toBe(false);
  });

  it("/health exposes the inbox backlog fields", async () => {
    const res = await request("GET", "/health");
    expect([200, 503]).toContain(res.status);
    expect(res.json).toHaveProperty("capture_backlog");
    expect(res.json).toHaveProperty("capture_oldest_pending_s");
    expect(res.json).toHaveProperty("capture_failed");
    expect(res.json.capture_backlog).toBe(0);
  });

  it("without messages[] the pair user/assistant counts as 2 accepted", async () => {
    const res = await request("POST", "/capture", { user_content: "q", assistant_content: "a", session_key: "sess-b" });
    expect(res.status).toBe(200);
    expect(res.json.accepted).toBe(2);
    await inbox.idle();
  });
});
