/**
 * Wiring proof: the ORIGINAL bug was a capture that existed but was never called
 * in the live path (green tests, no-op in production). This drives the REAL
 * performAutoRecall on a first turn and asserts a rollover session_recap for the
 * PREVIOUS session actually lands in the store — proving the wiring fires.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performAutoRecall } from "../auto-recall.js";
import { SessionBannerTracker } from "../session-banner.js";
import { VectorStore } from "../../store/sqlite.js";
import { parseConfig } from "../../../config.js";
import type { EmbeddingService } from "../../store/embedding.js";

describe("performAutoRecall — rollover capture wiring", () => {
  let dir: string;
  let store: VectorStore;

  const cfg = parseConfig({
    recall: { strategy: "embedding", maxResults: 5, scoreThreshold: 0.1 },
  } as unknown as Record<string, unknown>);

  const fakeEmbedding = new Float32Array([1, 0, 0, 0]);
  const fakeEmbeddingService = {
    embed: async () => fakeEmbedding,
    getDimensions: () => 4,
  } as unknown as EmbeddingService;

  const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-rollover-wiring-"));
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });

    // The PREVIOUS session (A) left an anchored thread behind.
    store.insertEvent({ sessionKey: "sess-roll", sessionId: "A", ts: "2026-06-30T10:00:00.000Z", type: "decision", text: "chose the rollover design", sourceMessageIds: ["ma"] });
    store.insertEvent({ sessionKey: "sess-roll", sessionId: "A", ts: "2026-06-30T10:05:00.000Z", type: "task", text: "verify live next session", sourceMessageIds: ["mb"] });
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("first turn of a NEW session captures the previous session's recap", async () => {
    const before = store.listEventsBySession!("sess-roll").filter((e) => e.type === "session_recap").length;
    expect(before).toBe(0);

    await performAutoRecall({
      userText: "riprendiamo",
      actorId: "actor-1",
      sessionKey: "sess-roll",
      sessionId: "B", // brand-new session opening
      cfg,
      pluginDataDir: dir,
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbeddingService,
      bannerTracker: new SessionBannerTracker(),
    });

    const recaps = store.listEventsBySession!("sess-roll").filter((e) => e.type === "session_recap");
    expect(recaps, "a rollover recap must have been captured via the live recall path").toHaveLength(1);
    expect(recaps[0].session_id).toBe("A");
    expect(recaps[0].text).toContain("chose the rollover design");
  });
});
