/**
 * Gateway routes added 2026-09-05 (CONTRACT points 1 + 2):
 *   POST /memory/confirm | /memory/reject  → TdaiCore.resolveGatedMemory
 *   POST /observe with tool_risk           → validated, forwarded to the core
 *
 * A real TdaiGateway on an ephemeral temp data dir (never the live store), with
 * embeddings/extraction off so nothing leaves the process.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiGateway } from "../server.js";
import { parseConfig } from "../../config.js";
import type { TdaiCore } from "../../core/tdai-core.js";

const PORT = 18431;
const TOKEN = "route-test-token";

async function post(
  pathname: string,
  body: unknown,
  headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path: pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers },
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

describe("POST /memory/confirm | /memory/reject and /observe tool_risk", () => {
  let gateway: TdaiGateway;
  let core: TdaiCore;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gw-routes-"));
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
      data: { baseDir: dir },
      llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "unused" },
      memory: parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } }),
    });
    await gateway.start();
    core = (gateway as unknown as { core: TdaiCore }).core;
    await (core as unknown as { storeReady?: Promise<void> }).storeReady;
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
  });

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("requires the same Bearer token as every other route", async () => {
    expect((await post("/memory/confirm", { owner_id: "x", owner_kind: "event" }, {})).status).toBe(401);
    expect((await post("/memory/reject", { owner_id: "x", owner_kind: "event" }, {})).status).toBe(401);
  });

  it("400 on missing owner_id or an invalid owner_kind", async () => {
    let res = await post("/memory/confirm", { owner_kind: "event" });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain("owner_id");
    res = await post("/memory/reject", { owner_id: "ev_1", owner_kind: "lesson" });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain("owner_kind");
    res = await post("/memory/confirm", { owner_id: "   ", owner_kind: "fact" });
    expect(res.status).toBe(400);
  });

  it("confirm → 200 {ok:true,text} and the memory's provenance becomes lorenzo_confirmed", async () => {
    const store = core.getVectorStore()!;
    const ev = store.insertEvent!({ ts: "2026-09-05T10:00:00.000Z", sessionKey: "s1", type: "decision", text: "the payout IBAN is IT60X..." });

    const res = await post("/memory/confirm", { owner_id: ev.id, owner_kind: "event" });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(String(res.json.text)).toContain("Confermato");

    const db = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
    const row = db.prepare("SELECT provenance_json FROM memory_lifecycle WHERE owner_id = ? AND owner_kind = 'event'").get(ev.id) as { provenance_json: string };
    expect(JSON.parse(row.provenance_json).origin).toBe("lorenzo_confirmed");
  });

  it("reject → 200 {ok:true,text} and the memory is tombstoned (gate_state rejected)", async () => {
    const store = core.getVectorStore()!;
    const ev = store.insertEvent!({ ts: "2026-09-05T10:00:00.000Z", sessionKey: "s1", type: "decision", text: "wrong memory" });

    const res = await post("/memory/reject", { owner_id: ev.id, owner_kind: "event" });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(String(res.json.text)).toContain("Rifiutato");

    const db = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
    const row = db.prepare("SELECT provenance_json FROM memory_lifecycle WHERE owner_id = ? AND owner_kind = 'event'").get(ev.id) as { provenance_json: string };
    expect(JSON.parse(row.provenance_json).gate_state).toBe("rejected");
  });

  it("409 {ok:false,text} when the core says the store could not apply it", async () => {
    const original = core.resolveGatedMemory;
    core.resolveGatedMemory = async () => ({ ok: false, text: "Memory store unavailable." });
    try {
      const res = await post("/memory/confirm", { owner_id: "ev_x", owner_kind: "fact" });
      expect(res.status).toBe(409);
      expect(res.json).toEqual({ ok: false, text: "Memory store unavailable." });
    } finally {
      core.resolveGatedMemory = original;
    }
  });

  it("/observe rejects an unknown tool_risk with 400 and forwards 'destructive' to the core", async () => {
    let res = await post("/observe", { session_key: "s1", tool_name: "Bash", tool_risk: "spicy" });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain("tool_risk");

    const spy = vi.spyOn(core, "handleToolObservation");
    res = await post("/observe", {
      session_key: "s1", tool_name: "Bash", tool_input: { command: "rm -rf dist" },
      tool_output_is_error: false, tool_output_text: "removed", tool_risk: "destructive",
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ context: "" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "s1", toolName: "Bash", toolRisk: "destructive", toolOutputText: "removed", toolOutputIsError: false,
    }));
    spy.mockRestore();

    // …and the core recorded it as an observation (CONTRACT point 1).
    const db = (core.getVectorStore() as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
    const row = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'observation' AND text LIKE 'destructive command succeeded:%'").get() as { n: number };
    expect(row.n).toBe(1);
  });
});
