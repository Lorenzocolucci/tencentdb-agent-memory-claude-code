/**
 * Wiring test (Pilastro C, Fase 1) — buildCornerstones must carry the
 * distinctiveness verdict onto lifecycle salience via store.stampSalience.
 *
 * Guards against the "green-but-no-op" failure mode: the decay-side protection
 * and the stampSalience primitive are each unit-tested, but they are inert
 * unless the runner actually calls the bridge. This drives the REAL
 * buildCornerstones against a REAL VectorStore and asserts the bridge fires for
 * a genuinely distinctive event (rare terms + neutral isolation → score ≥ 0.7).
 *
 * Isolation note: searchKbVector is shadowed to return [] → isolation defaults
 * to 1.0, so distinctiveness = 0.5 + 0.5*termRarity. A rare event clears the
 * PROTECTED_MIN_SALIENCE (0.7) threshold; common ones do not.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { buildCornerstones, CornerstoneInjectionTracker } from "../cornerstone-runner.js";
import { PROTECTED_MIN_SALIENCE } from "../../kb/lifecycle-decay.js";
import type { EmbeddingService } from "../../store/embedding.js";

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("cornerstone-runner — stampSalience bridge fires for distinctive peaks", () => {
  let dir: string;
  let store: VectorStore;

  const fakeEmbedding = new Float32Array([1, 0, 0, 0]);
  const fakeEmbeddingService = {
    embed: async () => fakeEmbedding,
    embedBatch: async (texts: string[]) => texts.map(() => fakeEmbedding),
    getDimensions: () => 4,
  } as unknown as EmbeddingService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cornerstone-salience-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    const res = store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    expect(res.needsReindex).toBe(false);

    // Corpus: several common events + ONE with rare, unique vocabulary. With
    // isolation pinned to 1.0, the rare event's distinctiveness clears 0.7.
    (store as unknown as { listRecentEvents: unknown }).listRecentEvents = () => [
      { id: "ev-common-1", text: "deploy done today ok fine good work" },
      { id: "ev-common-2", text: "deploy done today ok fine good work again" },
      { id: "ev-common-3", text: "deploy done today ok fine good stuff" },
      { id: "ev-rare", text: "zxqwph glimmerfax obelisk quokka thunderdome palindrome" },
    ];
    (store as unknown as { searchKbVector: unknown }).searchKbVector = () => [];
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("stamps salience (≥ threshold, ownerKind event) for the distinctive event", async () => {
    // Spy that DELEGATES to the real stampSalience — proves the call happens AND
    // keeps the real persistence behavior.
    const calls: Array<{ ownerId: string; ownerKind: string; salience: number }> = [];
    const realStamp = store.stampSalience.bind(store);
    (store as unknown as { stampSalience: unknown }).stampSalience = (p: {
      ownerId: string; ownerKind: "fact" | "event"; salience: number; now: string;
    }) => {
      calls.push({ ownerId: p.ownerId, ownerKind: p.ownerKind, salience: p.salience });
      realStamp(p);
    };

    const block = await buildCornerstones({
      vectorStore: store,
      embeddingService: fakeEmbeddingService,
      injectionTracker: new CornerstoneInjectionTracker(),
      logger: silentLogger,
    });

    expect(block, "a cornerstone block should be produced").not.toBe("");

    // The bridge fired at least once, only for events, only above threshold.
    expect(calls.length, "stampSalience must be called for the distinctive peak").toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.ownerKind).toBe("event");
      expect(c.salience).toBeGreaterThanOrEqual(PROTECTED_MIN_SALIENCE);
    }
    // The rare event specifically must be among the stamped ids.
    expect(calls.some((c) => c.ownerId === "ev-rare")).toBe(true);
  });
});
