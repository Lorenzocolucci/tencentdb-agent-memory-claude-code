/**
 * Recall-path secret redaction (SECURITY HIGH).
 *
 * The write path (L0/L1/KB) is redacted elsewhere; this pins the READ path: a
 * secret pasted into the user prompt must NOT be embedded and sent to the
 * provider as a query vector. A recording embedding captures every query it is
 * asked to embed; we assert the secret never reaches it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { performAutoRecall } from "../auto-recall.js";
import { parseConfig } from "../../../config.js";
import type { EmbeddingService, EmbeddingProviderInfo } from "../../store/embedding.js";

const DIMS = 4;
const SECRET = "sk-proj-AbCd1234EfGh5678IjKl9012MnOp";

class RecordingEmbedding implements EmbeddingService {
  readonly seen: string[] = [];
  private vec(t: string): Float32Array {
    this.seen.push(t);
    return new Float32Array([1, 0, 0, 0]);
  }
  async embed(t: string): Promise<Float32Array> { return this.vec(t); }
  async embedBatch(ts: string[]): Promise<Float32Array[]> { return ts.map((t) => this.vec(t)); }
  async embedChunks(t: string): Promise<Float32Array[]> { return t.trim() ? [this.vec(t)] : []; }
  getDimensions(): number { return DIMS; }
  getProviderInfo(): EmbeddingProviderInfo { return { provider: "fake", model: "fake-4d" }; }
  isReady(): boolean { return true; }
  startWarmup(): void { /* no-op */ }
}

describe("recall path — secret redaction before embedding", () => {
  let dir: string;
  let store: VectorStore;
  let embedding: RecordingEmbedding;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-recall-redact-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    embedding = new RecordingEmbedding();
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("never embeds a secret pasted into the query", async () => {
    const cfg = parseConfig({ recall: { strategy: "embedding" }, embedding: { provider: "openai" } });
    await performAutoRecall({
      userText: `please store my key ${SECRET} somewhere`,
      actorId: "default_user",
      sessionKey: "s1",
      cfg,
      pluginDataDir: dir,
      vectorStore: store,
      embeddingService: embedding,
    });

    expect(embedding.seen.length).toBeGreaterThan(0); // the query WAS embedded…
    expect(embedding.seen.some((t) => t.includes(SECRET))).toBe(false); // …but redacted
  });
});
