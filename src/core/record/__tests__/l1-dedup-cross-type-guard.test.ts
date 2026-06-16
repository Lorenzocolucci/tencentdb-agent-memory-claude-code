/**
 * Regression test for FIX 4 — the L1 dedup destructive-merge guard's cross-type
 * gap.
 *
 * BUG: parseBatchResult's guard rejected a destructive merge/update only when
 * (a) merged_type != the NEW memory's type, or (b) target_ids.length > 1. It
 * never inspected the TARGET candidate's actual type. So an `update` with a
 * SINGLE target whose EXISTING type differs from the new memory, but whose
 * merged_type happens to equal the new memory's type, slipped through the guard
 * and deleted a different-type record via deleteL1Batch.
 *
 * FIX: the candidate pool's id→type map (+ each new memory's recalled candidate
 * set) is threaded into the guard. A destructive decision is forced to "store"
 * (target_ids cleared) when a target resolves to a different-type candidate OR
 * to a hallucinated id that was never recalled.
 *
 * This drives the REAL batchDedup against a REAL temp VectorStore with a stored
 * existing `instruction` record, a new `episodic` memory, a tiny fake embedding
 * service (exact-match vector) and a fake LLM runner that emits the malicious
 * cross-type single-target update. No live LLM / network needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { batchDedup } from "../l1-dedup.js";
import type { ExtractedMemory, MemoryRecord } from "../l1-writer.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { LLMRunner } from "../../types.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const VEC = new Float32Array([1, 0, 0, 0]);

describe("l1-dedup — destructive-merge guard rejects cross-type / hallucinated targets", () => {
  let dir: string;
  let store: VectorStore;
  const sessionKey = "sess-dedup-guard";

  // Fake embedding service: only embedBatch is used by the vector recall path.
  // Returns the same unit vector for every new memory so it matches the stored
  // candidate exactly (cosine = 1.0).
  const fakeEmbedding = {
    embedBatch: async (texts: string[]) => texts.map(() => VEC),
    embed: async () => VEC,
    getDimensions: () => 4,
  } as unknown as EmbeddingService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-dedup-guard-"));
    fs.mkdirSync(path.join(dir, "records"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    const res = store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    expect(res.needsReindex).toBe(false);

    // Existing record of type INSTRUCTION — this must NOT be deletable by an
    // episodic "update".
    const now = new Date().toISOString();
    const existing: MemoryRecord = {
      id: "existing-instruction-1",
      content: "Always deploy via feature branch and PR, never push to main.",
      type: "instruction",
      priority: 95,
      scene_name: "ops",
      source_message_ids: ["x1"],
      metadata: {},
      timestamps: [now],
      createdAt: now,
      updatedAt: now,
      sessionKey,
      sessionId: "sid-existing",
    };
    expect(store.upsertL1(existing, VEC)).toBe(true);
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("forces store (no delete) for an episodic update whose single target is an instruction record", async () => {
    const newMemory: ExtractedMemory & { record_id: string } = {
      record_id: "new-episodic-1",
      content: "Deployed the new build to production this afternoon.",
      type: "episodic",
      priority: 80,
      source_message_ids: ["m1"],
      metadata: {},
      scene_name: "ops",
    };

    // Malicious / mistaken LLM output: a SINGLE-target update where merged_type
    // matches the new memory's type (episodic) — so the OLD guard would pass it —
    // but the target is the existing INSTRUCTION record.
    const fakeRunner: LLMRunner = {
      async run(): Promise<string> {
        return JSON.stringify([
          {
            record_id: "new-episodic-1",
            action: "update",
            target_ids: ["existing-instruction-1"],
            merged_content: "Deployed the new build to production this afternoon.",
            merged_type: "episodic", // equals new type → old guard would NOT catch it
            merged_priority: 80,
            merged_timestamps: [],
          },
        ]);
      },
    };

    const decisions = await batchDedup({
      memories: [newMemory],
      config: {},
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
      conflictRecallTopK: 5,
      llmRunner: fakeRunner,
    });

    expect(decisions.length).toBe(1);
    const d = decisions[0];
    expect(d.record_id).toBe("new-episodic-1");
    // The cross-type destructive update MUST be neutralized to a plain store.
    expect(d.action, "cross-type single-target update must be forced to store").toBe("store");
    expect(d.target_ids, "no record may be deleted").toEqual([]);

    // batchDedup only DECIDES — it never deletes or stores; the caller applies
    // decisions later. So the store still holds exactly the 1 pre-seeded
    // instruction record (the new memory was never upserted here).
    expect(await store.countL1()).toBe(1);
  });

  it("forces store (no delete) for an update targeting a hallucinated id never recalled", async () => {
    const newMemory: ExtractedMemory & { record_id: string } = {
      record_id: "new-episodic-2",
      content: "Reviewed the quarterly metrics with the team.",
      type: "episodic",
      priority: 70,
      source_message_ids: ["m2"],
      metadata: {},
      scene_name: "ops",
    };

    // The recalled candidate (same vector) is existing-instruction-1, but the LLM
    // names a target that was never a candidate — a hallucinated id.
    const fakeRunner: LLMRunner = {
      async run(): Promise<string> {
        return JSON.stringify([
          {
            record_id: "new-episodic-2",
            action: "merge",
            target_ids: ["id-that-was-never-recalled"],
            merged_content: "Reviewed the quarterly metrics with the team.",
            merged_type: "episodic",
            merged_priority: 70,
          },
        ]);
      },
    };

    const decisions = await batchDedup({
      memories: [newMemory],
      config: {},
      logger: silentLogger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
      conflictRecallTopK: 5,
      llmRunner: fakeRunner,
    });

    expect(decisions.length).toBe(1);
    const d = decisions[0];
    expect(d.action, "hallucinated-target merge must be forced to store").toBe("store");
    expect(d.target_ids).toEqual([]);
  });
});
