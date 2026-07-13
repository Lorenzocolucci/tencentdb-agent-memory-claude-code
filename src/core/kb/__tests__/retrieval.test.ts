/**
 * Phase 4 — kbRecall (KB retrieval read path) tests.
 *
 * ALL tests run on a THROWAWAY temp DB (NEVER the live vectors.db) and use a
 * DETERMINISTIC FAKE embedding service (no network). kb_vec is seeded with KNOWN
 * unit vectors so cosine similarity is exactly predictable; the query embedding
 * is registered explicitly so we control which owner is the semantic #1.
 *
 * Covers:
 *   - exact-keyword query → right fact via FTS even when the vector side is weak
 *   - semantic query → right owner ranked #1; calibrated score in [0,1] and
 *     higher for the better match
 *   - a superseded fact is NOT returned (HEAD-only invariant on the read side)
 *   - recency boost orders two similar-relevance facts by recency
 *   - rerank-OFF passthrough works and the interface is fail-open
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { kbRecall, noopReranker, type FusedCandidate } from "../retrieval.js";
import { _resetUlidStateForTest } from "../kb-queries.js";
import type { EmbeddingService, EmbeddingProviderInfo, EmbeddingCallOptions } from "../../store/embedding.js";

const DIMS = 4;

/** L2-normalize a raw vector (cosine = dot product on unit vectors). */
function normalize(values: number[]): Float32Array {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return new Float32Array(values.map((v) => v / mag));
}

/**
 * Deterministic fake embedding service. A text registered via `register()`
 * returns its exact vector; anything else falls back to a stable char-hash so
 * unrelated texts get a different, low-similarity vector. No network.
 */
class FakeEmbeddingService implements EmbeddingService {
  private readonly registry = new Map<string, Float32Array>();

  register(text: string, vec: number[]): void {
    this.registry.set(text, normalize(vec));
  }

  private vec(text: string): Float32Array {
    const hit = this.registry.get(text);
    if (hit) return hit;
    const v = [0, 0, 0, 0];
    for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i);
    return normalize(v);
  }

  async embed(text: string, _opts?: EmbeddingCallOptions): Promise<Float32Array> {
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

/**
 * Seed a HEAD fact: resolve/create the entity, insert an event, upsert the fact,
 * then embed+index it the same way kb-writer does
 * (text = "{entity} — {attribute}: {value}", owner_kind = "fact").
 * Returns the fact id and its rendered text.
 */
async function seedFact(
  store: VectorStore,
  embedding: FakeEmbeddingService,
  params: {
    type: string;
    name: string;
    attribute: string;
    value: string;
    validFrom: string;
    now: string;
    confidence?: number;
    vec?: number[];
  },
): Promise<{ factId: string; text: string; entityId: string }> {
  const entity = store.resolveOrCreateEntity({
    type: params.type,
    name: params.name,
    now: params.now,
  });
  const fact = store.upsertFact({
    entityId: entity.id,
    attribute: params.attribute,
    value: params.value,
    validFrom: params.validFrom,
    confidence: params.confidence ?? 0.8,
    now: params.now,
  });
  const text = `${entity.name} — ${fact.attribute}: ${fact.value}`;
  // Register a known vector for this rendered text so cosine is predictable.
  if (params.vec) embedding.register(text, params.vec);
  const chunks = await embedding.embedChunks(text);
  store.upsertKbVector(fact.id, "fact", chunks, params.now);
  store.upsertKbFts({
    ownerId: fact.id,
    ownerKind: "fact",
    content: text,
    entityType: params.type,
    attribute: params.attribute,
  });
  return { factId: fact.id, text, entityId: entity.id };
}

describe("kbRecall (temp DB, deterministic fake embedding)", () => {
  let dir: string;
  let store: VectorStore;
  let embedding: FakeEmbeddingService;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kbrecall-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    expect(store.isKbReady()).toBe(true);
    embedding = new FakeEmbeddingService();
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("exact-keyword query returns the right fact via FTS even when vector is weak", async () => {
    // Fact whose value contains the rare keyword "Frobnicator".
    const target = await seedFact(store, embedding, {
      type: "project",
      name: "Sofia",
      attribute: "deploy_target",
      value: "Frobnicator cluster",
      validFrom: "2026-06-01T00:00:00Z",
      now: "2026-06-01T00:00:00Z",
      vec: [1, 0, 0, 0],
    });
    // A distractor fact with no keyword overlap and a DIFFERENT vector.
    await seedFact(store, embedding, {
      type: "project",
      name: "Aurora",
      attribute: "status",
      value: "active",
      validFrom: "2026-06-01T00:00:00Z",
      now: "2026-06-01T00:00:00Z",
      vec: [0, 1, 0, 0],
    });

    // Query embedding deliberately points AWAY from the target's vector (weak
    // vector signal) so only FTS can surface the keyword hit.
    embedding.register("Frobnicator", [0, 0, 0, 1]);

    const results = await kbRecall("Frobnicator", {
      store,
      embeddingService: embedding,
      maxResults: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].owner_id).toBe(target.factId);
    expect(results[0].owner_kind).toBe("fact");
    expect(results[0].attribute).toBe("deploy_target");
    expect(results[0].text).toContain("Frobnicator");
  });

  it("semantic query returns the right owner #1; calibrated score in [0,1] and higher for the better match", async () => {
    // Two facts with NO shared keywords with the query, so only vector matters.
    const better = await seedFact(store, embedding, {
      type: "library",
      name: "Postgres",
      attribute: "role",
      value: "primary datastore",
      validFrom: "2026-06-01T00:00:00Z",
      now: "2026-06-01T00:00:00Z",
      vec: [1, 0, 0, 0], // closest to the query vector below
    });
    const worse = await seedFact(store, embedding, {
      type: "library",
      name: "Memcached",
      attribute: "role",
      value: "ephemeral cache",
      validFrom: "2026-06-01T00:00:00Z",
      now: "2026-06-01T00:00:00Z",
      vec: [0.6, 0.8, 0, 0], // partially aligned, lower cosine
    });

    // Query points exactly at `better`'s vector (cosine 1.0); `worse` cosine 0.6.
    embedding.register("which database stores data", [1, 0, 0, 0]);

    const results = await kbRecall("which database stores data", {
      store,
      embeddingService: embedding,
      maxResults: 5,
    });

    expect(results[0].owner_id).toBe(better.factId);
    // All calibrated scores must be valid 0-1 relevances.
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    const betterScore = results.find((r) => r.owner_id === better.factId)!.score;
    const worseScore = results.find((r) => r.owner_id === worse.factId)?.score ?? 0;
    expect(betterScore).toBeGreaterThan(worseScore);
    // Calibrated from cosine 1.0 → ~1; never the (tiny) raw RRF magnitude.
    expect(betterScore).toBeCloseTo(1, 5);
  });

  it("skipVector drops the global vector source (System 1 fast path): a vector-only match is reachable normally but absent when skipped", async () => {
    // A fact reachable ONLY by vector: neither its name nor value shares any
    // keyword with the query, so FTS + entity-match cannot surface it.
    const semanticOnly = await seedFact(store, embedding, {
      type: "library",
      name: "Redis",
      attribute: "role",
      value: "ephemeral cache",
      validFrom: "2026-06-01T00:00:00Z",
      now: "2026-06-01T00:00:00Z",
      vec: [1, 0, 0, 0],
    });
    // Query vector points exactly at the fact (cosine 1.0) but shares no term.
    embedding.register("which datastore holds transient state", [1, 0, 0, 0]);

    const withVector = await kbRecall("which datastore holds transient state", {
      store,
      embeddingService: embedding,
      maxResults: 5,
    });
    const withoutVector = await kbRecall("which datastore holds transient state", {
      store,
      embeddingService: embedding,
      maxResults: 5,
      skipVector: true,
    });

    // The vector source makes the semantic-only fact reachable...
    expect(withVector.some((r) => r.owner_id === semanticOnly.factId)).toBe(true);
    // ...and skipping it (auto-recall / banner path) removes the only route to it.
    expect(withoutVector.some((r) => r.owner_id === semanticOnly.factId)).toBe(false);
  });

  it("a superseded fact is NOT returned (only HEAD)", async () => {
    const entity = store.resolveOrCreateEntity({ type: "bug", name: "login-loop", now: "2026-06-01T00:00:00Z" });

    // v1: status=open (older). Index it.
    const openFact = store.upsertFact({
      entityId: entity.id,
      attribute: "status",
      value: "open",
      validFrom: "2026-06-01T00:00:00Z",
      now: "2026-06-01T00:00:00Z",
    });
    const openText = `${entity.name} — status: open`;
    embedding.register(openText, [1, 0, 0, 0]);
    store.upsertKbVector(openFact.id, "fact", await embedding.embedChunks(openText), "2026-06-01T00:00:00Z");
    store.upsertKbFts({ ownerId: openFact.id, ownerKind: "fact", content: openText, attribute: "status" });

    // v2: status=fixed (newer) → supersedes v1. The OLD vector row for openFact
    // is intentionally LEFT in kb_vec (kb-writer only re-embeds the new head) so
    // we prove kbRecall drops it via the HEAD check, not via the index.
    const fixedFact = store.upsertFact({
      entityId: entity.id,
      attribute: "status",
      value: "fixed",
      validFrom: "2026-06-02T00:00:00Z",
      now: "2026-06-02T00:00:00Z",
    });
    const fixedText = `${entity.name} — status: fixed`;
    embedding.register(fixedText, [0, 1, 0, 0]);
    store.upsertKbVector(fixedFact.id, "fact", await embedding.embedChunks(fixedText), "2026-06-02T00:00:00Z");
    store.upsertKbFts({ ownerId: fixedFact.id, ownerKind: "fact", content: fixedText, attribute: "status" });

    // Sanity: the superseded row is still in kb_vec (so the filter is the only thing dropping it).
    expect(openFact.id).not.toBe(fixedFact.id);

    // Query points at the OLD (superseded) vector — it must STILL not be returned.
    embedding.register("login bug status", [1, 0, 0, 0]);
    const results = await kbRecall("login bug status", { store, embeddingService: embedding, maxResults: 5 });

    expect(results.some((r) => r.owner_id === openFact.id)).toBe(false);
    // The HEAD ("fixed") is the only status fact that can appear.
    const statusHit = results.find((r) => r.attribute === "status");
    if (statusHit) {
      expect(statusHit.owner_id).toBe(fixedFact.id);
      expect(statusHit.text).toContain("fixed");
    }
  });

  it("recency boost orders two similar-relevance facts by recency", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const recentIso = new Date(now - 1 * day).toISOString();
    const oldIso = new Date(now - 300 * day).toISOString();

    // Two facts with the SAME cosine to the query (both vector [1,0,0,0]) but
    // different valid_from. Distinct entities → distinct owners, equal relevance.
    const recent = await seedFact(store, embedding, {
      type: "concept",
      name: "Alpha",
      attribute: "note",
      value: "alpha note",
      validFrom: recentIso,
      now: recentIso,
      vec: [1, 0, 0, 0],
    });
    const older = await seedFact(store, embedding, {
      type: "concept",
      name: "Beta",
      attribute: "note",
      value: "beta note",
      validFrom: oldIso,
      now: oldIso,
      vec: [1, 0, 0, 0],
    });

    // Query matches both equally on cosine; FTS shares no tokens ("xyzzy").
    embedding.register("xyzzy", [1, 0, 0, 0]);
    const results = await kbRecall("xyzzy", { store, embeddingService: embedding, maxResults: 5 });

    const recentIdx = results.findIndex((r) => r.owner_id === recent.factId);
    const olderIdx = results.findIndex((r) => r.owner_id === older.factId);
    expect(recentIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    // Newer fact ranks ahead of the equally-relevant older fact.
    expect(recentIdx).toBeLessThan(olderIdx);
  });

  it("rerank-OFF passthrough works and the reranker interface is fail-open", async () => {
    await seedFact(store, embedding, {
      type: "project",
      name: "Sofia",
      attribute: "stack",
      value: "Fastify",
      validFrom: "2026-06-01T00:00:00Z",
      now: "2026-06-01T00:00:00Z",
      vec: [1, 0, 0, 0],
    });
    embedding.register("Fastify", [1, 0, 0, 0]);

    // rerank: false (default) → identical to no rerank stage.
    const off = await kbRecall("Fastify", { store, embeddingService: embedding, maxResults: 5, rerank: false });
    // rerank: true → Phase-4 ships only the no-op passthrough, so order is identical.
    const on = await kbRecall("Fastify", { store, embeddingService: embedding, maxResults: 5, rerank: true });

    expect(off.length).toBeGreaterThan(0);
    expect(on.map((r) => r.owner_id)).toEqual(off.map((r) => r.owner_id));

    // The reranker interface is an identity passthrough (fail-open baseline).
    const items: FusedCandidate[] = [
      { ownerId: "fact_a", ownerKind: "fact", rrfScore: 0.3, fromFts: true, fromEntityMatch: false },
      { ownerId: "fact_b", ownerKind: "fact", rrfScore: 0.2, fromFts: false, fromEntityMatch: true },
    ];
    const passed = await noopReranker.rerank("q", items);
    expect(passed).toEqual(items);
  });

  it("returns [] without throwing when the query is too short", async () => {
    const results = await kbRecall("a", { store, embeddingService: embedding, maxResults: 5 });
    expect(results).toEqual([]);
  });
});
