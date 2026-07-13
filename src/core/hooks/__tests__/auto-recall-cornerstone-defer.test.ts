/**
 * Regression test — the cornerstone corpus-embedding (Idea 5: Distinctiveness
 * Scorer) must NOT run on the recall critical path.
 *
 * BUG (root cause of "Sinapsys a volte non si presenta all'apertura"):
 * performAutoRecall awaited buildCornerstones() INLINE on a cornerstone cache
 * MISS — i.e. the FIRST turn of every session. buildCornerstones batch-embeds
 * the whole event corpus (cornerstone-runner.ts → buildNeighborMap →
 * embeddingService.embedBatch), a ~5s OpenAI round-trip on a cold/contended
 * connection. That blew the cc hook's RECALL_TIMEOUT_MS (4s), so the client
 * aborted and the ENTIRE session-open injection (persona + principles + scene +
 * "dove eravamo" banner + relevant memories) was silently dropped on turn 1.
 *
 * FIX: on a cache MISS, performAutoRecall no longer awaits the corpus embed. It
 * returns a `cornerstoneMiss: { key }` signal; the caller (tdai-core) builds the
 * block OFF the critical path and commits it to the session cache, so
 * cornerstones appear from the NEXT turn while turn 1 ships everything else
 * instantly.
 *
 * This test drives the REAL performAutoRecall against a REAL temp VectorStore.
 * `listRecentEvents`/`searchKbVector` are shadowed on the instance so the
 * cornerstone path is REACHABLE (events present), and `embedBatch` is a spy:
 * after recall it MUST NOT have been called (the corpus embed is deferred).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { performAutoRecall } from "../auto-recall.js";
import { parseConfig } from "../../../config.js";
import { CornerstoneInjectionTracker } from "../../distinctiveness/cornerstone-runner.js";
import { CornerstoneSessionCache } from "../../distinctiveness/cornerstone-cache.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { EmbeddingService } from "../../store/embedding.js";

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("auto-recall — cornerstone corpus-embedding is OFF the critical path", () => {
  let dir: string;
  let store: VectorStore;
  const sessionKey = "sess-cornerstone-defer";
  const sessionId = "sid-cornerstone-1";
  const cfg = parseConfig({
    recall: { strategy: "embedding", maxResults: 5, scoreThreshold: 0.1 },
  } as unknown as Record<string, unknown>);

  const fakeEmbedding = new Float32Array([1, 0, 0, 0]);
  let embedBatchCalls = 0;
  const fakeEmbeddingService = {
    embed: async () => fakeEmbedding,
    // The corpus embed used by buildCornerstones. If the recall path ever awaits
    // it, this counter trips — which is exactly the regression we forbid.
    embedBatch: async () => {
      embedBatchCalls += 1;
      return [fakeEmbedding];
    },
    getDimensions: () => 4,
  } as unknown as EmbeddingService;

  beforeEach(() => {
    embedBatchCalls = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cornerstone-defer-"));
    fs.mkdirSync(path.join(dir, "records"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    const res = store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    expect(res.needsReindex).toBe(false);

    // One L1 memory so recall returns a defined result (prependContext present).
    const now = new Date().toISOString();
    const rec: MemoryRecord = {
      id: "mem-1",
      content: "Lorenzo è il socio, non l'esecutore — io porto la tecnica.",
      type: "episodic",
      priority: 90,
      scene_name: "patto",
      source_message_ids: ["m1"],
      metadata: {},
      timestamps: [now],
      createdAt: now,
      updatedAt: now,
      sessionKey,
      sessionId,
    };
    expect(store.upsertL1(rec, fakeEmbedding)).toBe(true);

    // Make the cornerstone path REACHABLE: events present + KB vector search
    // available. Shadow the two methods on the instance (other store methods
    // keep their real implementation + correct `this`).
    (store as unknown as { listRecentEvents: unknown }).listRecentEvents = () => [
      { id: "ev-1", text: "La sessione del 16 giugno 2026 — il picco assoluto di Sinapsys." },
      { id: "ev-2", text: "Deploy di Sofia AI completato e attivo." },
    ];
    (store as unknown as { searchKbVector: unknown }).searchKbVector = () => [];
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("does NOT call embedBatch (corpus embed) during recall on a cache miss", async () => {
    const tracker = new CornerstoneInjectionTracker();
    const cache = new CornerstoneSessionCache();

    const result = await performAutoRecall({
      userText: "ciao socio, dove eravamo?",
      actorId: "actor-1",
      sessionKey,
      sessionId,
      cfg,
      pluginDataDir: dir,
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbeddingService,
      cornerstoneTracker: tracker,
      cornerstoneCache: cache,
    });

    expect(result, "recall must return a result").toBeDefined();
    // The corpus embedding must be deferred — not awaited on the recall path.
    expect(embedBatchCalls, "corpus embedBatch must NOT run on the recall critical path").toBe(0);
  });

  it("signals a deferred cornerstone build via cornerstoneMiss (not an inline cornerstonePending)", async () => {
    const tracker = new CornerstoneInjectionTracker();
    const cache = new CornerstoneSessionCache();

    const result = await performAutoRecall({
      userText: "ciao socio, dove eravamo?",
      actorId: "actor-1",
      sessionKey,
      sessionId,
      cfg,
      pluginDataDir: dir,
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbeddingService,
      cornerstoneTracker: tracker,
      cornerstoneCache: cache,
    });

    // New contract: a miss yields a deferral signal keyed on sessionId.
    expect(result!.cornerstoneMiss).toEqual({ key: sessionId });
    // Old inline-compute field is gone.
    expect((result as Record<string, unknown>).cornerstonePending).toBeUndefined();
  });
});
