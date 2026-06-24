/**
 * Secret redaction at the KB write chokepoint (SECURITY HIGH).
 *
 * Proves end-to-end on a REAL temp store that a secret in a fact value or event
 * text is (a) stored redacted in kb_facts / kb_events, (b) absent from the FTS
 * index, and — most important — (c) NEVER passed to the embedding service, i.e.
 * never egresses to the provider. A recording fake embedding captures every
 * input so we can assert the secret never reached it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { applyKbDelta } from "../kb-writer.js";
import { parseKbDelta } from "../extraction-schema.js";
import type { EmbeddingService, EmbeddingProviderInfo } from "../../store/embedding.js";
import { _resetUlidStateForTest } from "../kb-queries.js";

const DIMS = 4;
const NOW = "2026-06-24T12:00:00.000Z";
const SECRET = "sk-proj-AbCd1234EfGh5678IjKl9012MnOp";

/** Fake embedding that RECORDS every text it is asked to embed. */
class RecordingEmbedding implements EmbeddingService {
  readonly seen: string[] = [];
  private vec(text: string): Float32Array {
    this.seen.push(text);
    return new Float32Array([1, 0, 0, 0]);
  }
  async embed(text: string): Promise<Float32Array> { return this.vec(text); }
  async embedBatch(texts: string[]): Promise<Float32Array[]> { return texts.map((t) => this.vec(t)); }
  async embedChunks(text: string): Promise<Float32Array[]> {
    return text.trim().length === 0 ? [] : [this.vec(text)];
  }
  getDimensions(): number { return DIMS; }
  getProviderInfo(): EmbeddingProviderInfo { return { provider: "fake", model: "fake-4d" }; }
  isReady(): boolean { return true; }
  startWarmup(): void { /* no-op */ }
}

function secretDelta() {
  const res = parseKbDelta({
    language: "en",
    entities: [{ ref: "e1", type: "config", name: "openai-credentials", aliases: [`alias ${SECRET}`], language: "en" }],
    facts: [
      {
        entity_ref: "e1",
        attribute: "api_key",
        value: `the key is ${SECRET}`,
        valid_from: "2026-06-24T12:00:00Z",
        confidence: 0.9,
        source_event_ref: "ev1",
      },
    ],
    events: [
      {
        ref: "ev1",
        type: "config_change",
        ts: "2026-06-24T12:00:00Z",
        text: `Lorenzo pasted ${SECRET} into the gateway env.`,
        entity_refs: ["e1"],
        source_message_ids: ["m1"],
      },
    ],
    relations: [],
  });
  if (!res.ok) throw new Error(`secret delta invalid: ${res.error}`);
  return res.delta;
}

function dbAll(store: VectorStore, sql: string, ...args: unknown[]): Record<string, unknown>[] {
  const handle = (store as unknown as {
    db: { prepare: (q: string) => { all: (...a: unknown[]) => Record<string, unknown>[] } };
  }).db;
  return handle.prepare(sql).all(...args);
}

describe("applyKbDelta — secret redaction", () => {
  let dir: string;
  let store: VectorStore;
  let embedding: RecordingEmbedding;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kb-redact-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    embedding = new RecordingEmbedding();
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("redacts the secret in stored rows, FTS, and never embeds it", async () => {
    const result = await applyKbDelta(secretDelta(), {
      store,
      embeddingService: embedding,
      namespace: "default",
      project: "repo",
      sessionKey: "sess-1",
      sessionId: "sid-1",
      now: NOW,
    });

    // (a) Stored fact value + event text are redacted (no cleartext secret).
    const factRows = dbAll(store, "SELECT value FROM facts");
    expect(factRows.some((r) => String(r.value).includes(SECRET))).toBe(false);
    expect(factRows.some((r) => String(r.value).includes("[REDACTED"))).toBe(true);

    const eventRows = dbAll(store, "SELECT text FROM events");
    expect(eventRows.some((r) => String(r.text).includes(SECRET))).toBe(false);

    // Entity aliases must not store the secret cleartext either.
    const entRows = dbAll(store, "SELECT aliases_json FROM entities");
    expect(entRows.some((r) => String(r.aliases_json).includes(SECRET))).toBe(false);

    // (b) FTS index holds no cleartext secret (content + content_original).
    const ftsRows = dbAll(store, "SELECT content, content_original FROM kb_fts");
    expect(ftsRows.some((r) => String(r.content).includes(SECRET))).toBe(false);
    expect(ftsRows.some((r) => String(r.content_original).includes(SECRET))).toBe(false);

    // (c) THE EGRESS GUARANTEE: the secret was never handed to the embedder.
    expect(result.embedded).toBeGreaterThan(0); // it did embed (redacted) content
    expect(embedding.seen.length).toBeGreaterThan(0);
    expect(embedding.seen.some((t) => t.includes(SECRET))).toBe(false);
  });
});
