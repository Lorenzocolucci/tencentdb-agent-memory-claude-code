/**
 * Regression test — a slow/unreachable embedding provider must DEGRADE the
 * memory search to empty WITHOUT dropping the whole session-open injection.
 *
 * ROOT CAUSE (verified from the live gateway.err.log):
 *   [recall] ⚠️ Recall timed out after 5000ms — skipping memory injection
 *   [kb-recall] vector source failed: getaddrinfo ENOTFOUND api.openai.com
 * The recall embeds the query via a REMOTE provider (OpenAI). On a network/DNS
 * blip the embed hangs/retries; the single 5s recall timeout fired and dropped
 * the ENTIRE injection (persona + scene + banner + memories) — Lorenzo's
 * "la memoria non arriva all'apertura".
 *
 * FIX: the search has its OWN budget (recall.searchTimeoutMs, default 4000, <
 * the 5000 overall). When exceeded, memories degrade to empty and the
 * deterministic LOCAL context is still assembled. This test drives the REAL
 * performAutoRecall with a search that hangs (3s embed) and a 50ms search
 * budget: recall MUST return a defined result FAST — not wait the 3s embed nor
 * blow the 5s overall timeout.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { performAutoRecall } from "../auto-recall.js";
import { parseConfig } from "../../../config.js";
import type { EmbeddingService } from "../../store/embedding.js";

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("auto-recall — search degrades (embedding outage) without dropping the injection", () => {
  let dir: string;
  let store: VectorStore;
  const sessionKey = "sess-degrade";
  const sessionId = "sid-degrade-1";

  // strategy "embedding" so the search path embeds the query; a 50ms search
  // budget under the 5000ms overall timeout.
  const cfg = parseConfig({
    recall: { strategy: "embedding", maxResults: 5, scoreThreshold: 0.1, searchTimeoutMs: 50, timeoutMs: 5000 },
  } as unknown as Record<string, unknown>);

  const fakeEmbedding = new Float32Array([1, 0, 0, 0]);
  // The embed HANGS ~3s — far beyond the 50ms search budget. The recall must
  // NOT wait for it: it degrades and returns immediately.
  const hangingEmbeddingService = {
    embed: async () => { await new Promise((r) => setTimeout(r, 3000)); return fakeEmbedding; },
    embedBatch: async () => { await new Promise((r) => setTimeout(r, 3000)); return [fakeEmbedding]; },
    getDimensions: () => 4,
  } as unknown as EmbeddingService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-degrade-"));
    fs.mkdirSync(path.join(dir, "records"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    const res = store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    expect(res.needsReindex).toBe(false);

    // A persona (LOCAL, no network) must survive an embedding outage — it is the
    // deterministic context that must ALWAYS reach the agent at session open.
    fs.writeFileSync(
      path.join(dir, "persona.md"),
      "# User Profile\n\n## Identity & Role\n- **Lorenzo** — role: il socio, non l'esecutore\n",
    );
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns a defined result FAST when the search embedding hangs (degraded, not dropped)", async () => {
    const t0 = performance.now();
    const result = await performAutoRecall({
      userText: "ciao socio, dove eravamo?",
      actorId: "actor-1",
      sessionKey,
      sessionId,
      cfg,
      pluginDataDir: dir,
      logger: silentLogger,
      vectorStore: store,
      embeddingService: hangingEmbeddingService,
    });
    const elapsed = performance.now() - t0;

    // The injection is NOT dropped: recall returns a defined result...
    expect(result, "recall must degrade, not drop the whole injection").toBeDefined();
    // ...the LOCAL persona still reaches the agent despite the embedding outage...
    expect(result!.appendSystemContext ?? "").toContain("il socio, non l'esecutore");
    // ...and it returns FAST — it abandoned the 3s embed at the 50ms budget and
    // never approached the 5s overall timeout.
    expect(elapsed, `recall should return ~instantly, took ${elapsed.toFixed(0)}ms`).toBeLessThan(2000);
  });
});
