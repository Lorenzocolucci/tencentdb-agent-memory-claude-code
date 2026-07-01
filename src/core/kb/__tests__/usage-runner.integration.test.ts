/**
 * Integration: the full usage pass against a REAL throwaway VectorStore (never
 * the live vectors.db). Proves capture→store→idempotency end-to-end on the real
 * store shape — the non-circular check that catches a green no-op. Embeddings
 * are injected (test env has no embedding API) so the geometry is controlled.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { _resetUlidStateForTest } from "../kb-queries.js";
import { distillUsage } from "../usage-runner.js";
import { fakeEmbeddingReader } from "../bug-embeddings.js";

const DIMS = 4;

describe("distillUsage — real store round-trip", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-usage-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isKbReady()).toBe(true);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const usageCount = () =>
    store.listRecentEvents!("default", { limit: 1000 }).filter((e) => e.type === "usage").length;

  it("writes one usage atom for a semantic cross-session behavioral cluster, idempotent on re-run", async () => {
    const e1 = store.insertEvent!({ sessionKey: "sk-proj", sessionId: "A", ts: "2026-06-30T10:00:00.000Z", type: "preference_stated", text: "aspetta la mia risposta", sourceMessageIds: ["m1"] });
    const e2 = store.insertEvent!({ sessionKey: "sk-proj", sessionId: "B", ts: "2026-07-01T09:00:00.000Z", type: "preference_stated", text: "non partire finché non rispondo", sourceMessageIds: ["m2"] });

    // Inject near-identical vectors for the two real event ids.
    const reader = fakeEmbeddingReader(new Map([
      [e1.id, new Float32Array([1, 0, 0, 0])],
      [e2.id, new Float32Array([0.99, 0.14, 0, 0])],
    ]));

    const s1 = await distillUsage(store, reader, { now: "2026-07-01T14:00:00.000Z" });
    expect(s1.candidates).toBe(1);
    expect(s1.inserted).toBe(1);
    expect(usageCount()).toBe(1);

    const usage = store.listRecentEvents!("default", { limit: 1000 }).find((e) => e.type === "usage")!;
    expect(usage.text).toContain("modo d'uso ricorrente");
    expect(usage.entities).toContain("evidence:2");
    expect(usage.entities).toContain(`usage-src:${e1.id}`);

    // Second pass sees the existing usage atom → no duplicate.
    const s2 = await distillUsage(store, reader, { now: "2026-07-01T15:00:00.000Z" });
    expect(s2.skippedDuplicate).toBeGreaterThanOrEqual(1);
    expect(usageCount()).toBe(1);
  });

  it("anecdote guard: behaviors all in one session write nothing", async () => {
    const e1 = store.insertEvent!({ sessionKey: "sk-proj", sessionId: "A", ts: "2026-06-30T10:00:00.000Z", type: "preference_stated", text: "x" });
    const e2 = store.insertEvent!({ sessionKey: "sk-proj", sessionId: "A", ts: "2026-06-30T11:00:00.000Z", type: "preference_stated", text: "x2" });
    const reader = fakeEmbeddingReader(new Map([
      [e1.id, new Float32Array([1, 0, 0, 0])],
      [e2.id, new Float32Array([1, 0, 0, 0])],
    ]));
    const s = await distillUsage(store, reader, { now: "2026-07-01T14:00:00.000Z" });
    expect(s.candidates).toBe(0);
    expect(usageCount()).toBe(0);
  });
});
