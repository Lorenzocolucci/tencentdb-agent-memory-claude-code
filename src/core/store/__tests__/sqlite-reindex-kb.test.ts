/**
 * VectorStore.reindexKb — rebuild the KB recall vec surface (kb_vec) from kb_fts.
 *
 * Ground truth (NON-circular): the test seeds kb_fts (the text source) directly
 * and leaves kb_vec empty (simulating a dimension-change drop). The assertions
 * are (a) which texts reindexKb feeds the embed fn — driven by the seeded
 * kb_fts, not by reindexKb's own output — and (b) that kb_vec ends up populated,
 * one chunk per owner, idempotently.
 *
 * WHY this exists: a dimension/model change drops kb_vec but reindexAll only
 * covers L0/L1. Without reindexKb, kb semantic recall stays blank after an
 * embedding-provider switch (the live bug found 2026-07-02).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";

const DIMS = 4;

function normalize(values: number[]): Float32Array {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return new Float32Array(values.map((v) => v / mag));
}

function kbVecOwnerCount(store: VectorStore, ownerId: string): number {
  return (
    store as unknown as { db: { prepare: (q: string) => { get: (a: string) => { c: number } } } }
  ).db
    .prepare("SELECT count(*) c FROM kb_vec WHERE owner_id = ?")
    .get(ownerId).c;
}

describe("VectorStore.reindexKb (temp DB)", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kb-reindex-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);

    // Seed the TEXT source (kb_fts) for two owners; leave kb_vec EMPTY to
    // simulate the post-dimension-change state that reindexKb must repair.
    store.upsertKbFts({ ownerId: "fact-1", ownerKind: "fact", content: "lorenzo prefers small files" });
    store.upsertKbFts({ ownerId: "event-1", ownerKind: "event", content: "gateway restarted with guard" });
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("rebuilds kb_vec from kb_fts, embedding each owner's text exactly once", async () => {
    const embedded: string[] = [];
    const { kbCount } = await store.reindexKb(async (t) => {
      embedded.push(t);
      return normalize([1, 0, 0, 0]);
    });

    expect(kbCount).toBe(2);
    // Ground truth: the texts fed to embed come from the seeded kb_fts.
    expect(embedded.sort()).toEqual([
      "gateway restarted with guard",
      "lorenzo prefers small files",
    ]);
    // kb_vec is now populated for both owners.
    expect(kbVecOwnerCount(store, "fact-1")).toBe(1);
    expect(kbVecOwnerCount(store, "event-1")).toBe(1);
  });

  it("is idempotent — a second run does not duplicate vectors", async () => {
    const embed = async (): Promise<Float32Array> => normalize([0, 1, 0, 0]);
    await store.reindexKb(embed);
    await store.reindexKb(embed);
    expect(kbVecOwnerCount(store, "fact-1")).toBe(1);
    expect(kbVecOwnerCount(store, "event-1")).toBe(1);
  });
});
