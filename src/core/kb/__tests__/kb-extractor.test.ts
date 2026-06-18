/**
 * Phase 2 — kb-extractor runner test (MOCK LLM, temp DB).
 *
 * A mock LLMRunner returns a fixed KbDelta JSON. We feed a window in, then
 * assert applyKbDelta ran and searchKbVector/searchKbFts return the fact.
 * (Live Kimi quality is validated later in P3/P4, NOT here.)
 *
 * Also covers the fail-closed contracts:
 *   - schema-invalid JSON  → success:false (cursor would hold).
 *   - empty delta           → success:true, no-op (cursor advances).
 *   - LLM throws            → success:false.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { extractKbDelta } from "../kb-extractor.js";
import type { EmbeddingService, EmbeddingProviderInfo } from "../../store/embedding.js";
import type { LLMRunner, LLMRunParams } from "../../types.js";
import type { ConversationMessage } from "../../conversation/l0-recorder.js";
import { _resetUlidStateForTest } from "../kb-queries.js";

const DIMS = 4;

function normalize(values: number[]): Float32Array {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return new Float32Array(values.map((v) => v / mag));
}

class FakeEmbeddingService implements EmbeddingService {
  private vec(text: string): Float32Array {
    const v = [0, 0, 0, 0];
    for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i);
    return normalize(v);
  }
  async embed(text: string): Promise<Float32Array> {
    return this.vec(text);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.vec(t));
  }
  async embedChunks(text: string): Promise<Float32Array[]> {
    return text.trim().length === 0 ? [] : [this.vec(text)];
  }
  getDimensions(): number {
    return DIMS;
  }
  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: "fake", model: "fake-4d" };
  }
  isReady(): boolean {
    return true;
  }
  startWarmup(): void {
    /* no-op */
  }
}

/** A mock LLM runner that returns a fixed string (optionally wrapped in fences). */
class MockLLMRunner implements LLMRunner {
  public lastParams?: LLMRunParams;
  constructor(private readonly response: string | (() => Promise<string>)) {}
  async run(params: LLMRunParams): Promise<string> {
    this.lastParams = params;
    return typeof this.response === "function" ? this.response() : this.response;
  }
}

const WINDOW: ConversationMessage[] = [
  {
    id: "msg_b1",
    role: "user",
    content: "There's a booking loop bug: bookSlot() in booking.ts recurses forever.",
    timestamp: Date.parse("2026-06-06T09:00:00Z"),
  },
];

const FIXED_DELTA_JSON = JSON.stringify({
  language: "en",
  entities: [
    { ref: "e1", type: "bug", name: "booking-loop", aliases: ["booking loop bug"], language: "en" },
    { ref: "e2", type: "file", name: "booking.ts", aliases: [], language: "en" },
  ],
  facts: [
    {
      entity_ref: "e1",
      attribute: "status",
      value: "open",
      valid_from: "2026-06-06T09:00:00Z",
      confidence: 0.9,
      source_event_ref: "ev1",
    },
  ],
  events: [
    {
      ref: "ev1",
      type: "bug",
      ts: "2026-06-06T09:00:00Z",
      text: "Bug: bookSlot() in booking.ts recurses forever when the slot is already taken.",
      entity_refs: ["e1", "e2"],
      source_message_ids: ["msg_b1"],
    },
  ],
  relations: [{ src_ref: "e1", type: "fixed-by", dst_ref: "e2" }],
});

describe("extractKbDelta (mock LLM, temp DB)", () => {
  let dir: string;
  let store: VectorStore;
  let embedding: FakeEmbeddingService;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kbextract-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isKbReady()).toBe(true);
    embedding = new FakeEmbeddingService();
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("fixed KbDelta → applied; searchKbVector/searchKbFts return the fact", async () => {
    const runner = new MockLLMRunner(FIXED_DELTA_JSON);
    const res = await extractKbDelta({
      messages: WINDOW,
      sessionKey: "sess-1",
      sessionId: "sid-1",
      store,
      embeddingService: embedding,
      llmRunner: runner,
      now: "2026-06-06T09:01:00.000Z",
    });

    expect(res.success).toBe(true);
    expect(res.entitiesCount).toBe(2);
    expect(res.factsCount).toBe(1);
    expect(res.eventsCount).toBe(1);
    expect(res.relationsCount).toBe(1);
    expect(res.embeddedCount).toBe(2);

    // The prompt was built with the right taskId.
    expect(runner.lastParams?.taskId).toBe("kb-extraction");

    // The fact is recallable by FTS and by vector.
    const bug = store.queryEntityByKey("default", "bug", "bug:booking-loop")!;
    const factId = store.queryHeadFacts(bug.id)[0].id;

    const fts = store.searchKbFts('"booking"', 10);
    expect(fts.some((r) => r.owner_id === factId && r.owner_kind === "fact")).toBe(true);

    const qv = await embedding.embed("booking-loop — status: open");
    const vec = store.searchKbVector(qv, 10, "fact");
    expect(vec.some((r) => r.owner_id === factId)).toBe(true);
  });

  it("strips ```json fences before parsing", async () => {
    const runner = new MockLLMRunner("```json\n" + FIXED_DELTA_JSON + "\n```");
    const res = await extractKbDelta({
      messages: WINDOW,
      sessionKey: "sess-1",
      store,
      embeddingService: embedding,
      llmRunner: runner,
      now: "2026-06-06T09:01:00.000Z",
    });
    expect(res.success).toBe(true);
    expect(res.factsCount).toBe(1);
  });

  it("empty delta → success:true, no-op (cursor advances)", async () => {
    const runner = new MockLLMRunner(
      JSON.stringify({ language: "en", entities: [], facts: [], events: [], relations: [] }),
    );
    const res = await extractKbDelta({
      messages: WINDOW,
      sessionKey: "sess-1",
      store,
      embeddingService: embedding,
      llmRunner: runner,
    });
    expect(res.success).toBe(true);
    expect(res.entitiesCount).toBe(0);
    expect(res.factsCount).toBe(0);
    // Nothing written.
    const handle = (store as unknown as {
      db: { prepare: (q: string) => { all: () => Record<string, unknown>[] } };
    }).db;
    expect((handle.prepare("SELECT count(*) AS c FROM entities").all()[0] as { c: number }).c).toBe(0);
  });

  it("schema-invalid JSON (dangling ref) → success:false (cursor holds)", async () => {
    const bad = JSON.stringify({
      language: "en",
      entities: [{ ref: "e1", type: "bug", name: "x", language: "en" }],
      facts: [{ entity_ref: "e_nope", attribute: "status", value: "open" }],
      events: [],
      relations: [],
    });
    const runner = new MockLLMRunner(bad);
    const res = await extractKbDelta({
      messages: WINDOW,
      sessionKey: "sess-1",
      store,
      embeddingService: embedding,
      llmRunner: runner,
    });
    expect(res.success).toBe(false);
  });

  it("non-JSON garbage → success:false (cursor holds)", async () => {
    const runner = new MockLLMRunner("I could not produce JSON, sorry.");
    const res = await extractKbDelta({
      messages: WINDOW,
      sessionKey: "sess-1",
      store,
      embeddingService: embedding,
      llmRunner: runner,
    });
    expect(res.success).toBe(false);
  });

  it("LLM throws → success:false (cursor holds)", async () => {
    const runner = new MockLLMRunner(async () => {
      throw new Error("timeout");
    });
    const res = await extractKbDelta({
      messages: WINDOW,
      sessionKey: "sess-1",
      store,
      embeddingService: embedding,
      llmRunner: runner,
    });
    expect(res.success).toBe(false);
  });

  it("empty window → no-op success without calling the LLM", async () => {
    let called = false;
    const runner = new MockLLMRunner(async () => {
      called = true;
      return FIXED_DELTA_JSON;
    });
    const res = await extractKbDelta({
      messages: [],
      sessionKey: "sess-1",
      store,
      embeddingService: embedding,
      llmRunner: runner,
    });
    expect(res.success).toBe(true);
    expect(res.factsCount).toBe(0);
    expect(called).toBe(false);
  });
});
