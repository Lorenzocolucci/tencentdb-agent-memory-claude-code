/**
 * Tests for the L3 PersonaGenerator guard introduced to fix the double-write
 * bug: when engine=kb + kbProjections=on + llmRunner present + store kb-capable,
 * `createL3Runner` must NOT invoke PersonaGenerator (which would overwrite the
 * deterministic KB projection with a Chinese LLM narrative).
 *
 * Discipline (mirrors projections.test.ts):
 *   - temp dirs only — NEVER the live vectors.db
 *   - NO network, NO real LLM calls
 *   - tests assert SIDE EFFECTS, not internal booleans
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../config.js";
import { kbProjectionOwnsProjectedFiles, createL3Runner, createL2Runner } from "../pipeline-factory.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { LLMRunner, LLMRunParams } from "../../core/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const silentLogger = {
  debug: (_: string) => {},
  info: (_: string) => {},
  warn: (_: string) => {},
  error: (_: string) => {},
};

/** Capture info-level messages to assert on specific log lines. */
function makeCapturingLogger(): { logger: typeof silentLogger; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    logger: {
      debug: (_: string) => {},
      info: (msg: string) => { messages.push(msg); },
      warn: (_: string) => {},
      error: (_: string) => {},
    },
  };
}

/**
 * Minimal fake IMemoryStore that satisfies supportsKbWrite (all KB primitives
 * present) and isDegraded() === false. Everything else is a no-op.
 */
function makeKbCapableStore(): IMemoryStore {
  return {
    // isDegraded / init
    isDegraded: () => false,
    init: async () => ({ needsReindex: false }),
    close: () => {},
    // KB write primitives (supportsKbWrite checks these)
    isKbReady: () => true,
    resolveOrCreateEntity: () => ({ id: "fake-entity", namespace: "default", type: "person", name: "Fake", createdAt: "", updatedAt: "", heat: 0, alias: [] }),
    insertEvent: () => ({ id: "fake-event", namespace: "default", type: "fact", text: "", entities: [], sourceMessageIds: [], ts: "", sessionKey: "" }),
    upsertFact: () => ({ id: "fake-fact", entityId: "", attribute: "", value: "", validFrom: "", sourceEventId: undefined, supersededAt: undefined, createdAt: "", updatedAt: "" }),
    upsertRelation: () => ({ id: "fake-rel", srcEntityId: "", type: "", dstEntityId: "", createdAt: "" }),
    queryEntityById: () => undefined,
    upsertKbVector: () => {},
    upsertKbFts: () => {},
    // Minimal no-ops for the rest of IMemoryStore
    storeMemory: async () => false,
    searchMemories: async () => [],
    searchMemoriesFTS: async () => [],
    searchMemoriesHybrid: async () => [],
    deleteMemory: async () => false,
    updateMemory: async () => false,
    getMemoryById: async () => null,
    listSessionKeys: async () => [],
    listMemoryRecords: async () => [],
    queryMemoryRecords: async () => [],
    queryL1Records: async () => [], // l1-reader path: zero records → L2 early-exits
    getStats: async () => ({ total: 0, byType: {}, byScene: {} }),
    upsertL0: () => false,
    queryL0GroupedBySessionId: () => [],
    cleanupL0: async () => 0,
    cleanupL1: async () => 0,
  } as unknown as IMemoryStore;
}

/** Store that does NOT satisfy supportsKbWrite (missing KB primitives). */
function makeNonKbStore(): IMemoryStore {
  return {
    isDegraded: () => false,
    init: async () => ({ needsReindex: false }),
    close: () => {},
    storeMemory: async () => false,
    searchMemories: async () => [],
    searchMemoriesFTS: async () => [],
    searchMemoriesHybrid: async () => [],
    deleteMemory: async () => false,
    updateMemory: async () => false,
    getMemoryById: async () => null,
    listSessionKeys: async () => [],
    listMemoryRecords: async () => [],
    queryMemoryRecords: async () => [],
    getStats: async () => ({ total: 0, byType: {}, byScene: {} }),
    upsertL0: () => false,
    queryL0GroupedBySessionId: () => [],
    cleanupL0: async () => 0,
    cleanupL1: async () => 0,
  } as unknown as IMemoryStore;
}

/** Fake LLMRunner that records every call so tests can assert it was NOT called. */
function makeFakeLlmRunner(): { runner: LLMRunner; callCount: () => number } {
  let calls = 0;
  const runner: LLMRunner = {
    async run(_params: LLMRunParams): Promise<string> {
      calls++;
      return "";
    },
  };
  return { runner, callCount: () => calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Part A — kbProjectionOwnsProjectedFiles truth table
// ─────────────────────────────────────────────────────────────────────────────

describe("kbProjectionOwnsProjectedFiles — truth table", () => {
  const kbStore = makeKbCapableStore();
  const nonKbStore = makeNonKbStore();
  const fakeLlm = makeFakeLlmRunner().runner;

  const cfgKbOn = parseConfig({ extraction: { engine: "kb", kbProjections: true } } as unknown as Record<string, unknown>);
  const cfgKbOff = parseConfig({ extraction: { engine: "kb", kbProjections: false } } as unknown as Record<string, unknown>);
  const cfgL1On = parseConfig({ extraction: { engine: "l1", kbProjections: true } } as unknown as Record<string, unknown>);

  it("returns TRUE when engine=kb, kbProjections=true, llmRunner set, store kb-capable", () => {
    expect(kbProjectionOwnsProjectedFiles(cfgKbOn, kbStore, fakeLlm)).toBe(true);
  });

  it("returns FALSE when engine=kb, kbProjections=false (even with llmRunner + kb store)", () => {
    expect(kbProjectionOwnsProjectedFiles(cfgKbOff, kbStore, fakeLlm)).toBe(false);
  });

  it("returns FALSE when engine=l1, kbProjections=true (even with llmRunner + kb store)", () => {
    expect(kbProjectionOwnsProjectedFiles(cfgL1On, kbStore, fakeLlm)).toBe(false);
  });

  it("returns FALSE when llmRunner is undefined (engine=kb, kbProjections=true)", () => {
    expect(kbProjectionOwnsProjectedFiles(cfgKbOn, kbStore, undefined)).toBe(false);
  });

  it("returns FALSE when store is NOT kb-capable (engine=kb, kbProjections=true, llmRunner set)", () => {
    expect(kbProjectionOwnsProjectedFiles(cfgKbOn, nonKbStore, fakeLlm)).toBe(false);
  });

  it("returns FALSE when store is undefined (engine=kb, kbProjections=true, llmRunner set)", () => {
    expect(kbProjectionOwnsProjectedFiles(cfgKbOn, undefined, fakeLlm)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part B — createL3Runner behaviour: PersonaGenerator NOT invoked on kb path
// ─────────────────────────────────────────────────────────────────────────────

describe("createL3Runner — skips PersonaGenerator when kbProjectionOwnsProjectedFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-l3-guard-"));
    // Minimal directory structure PersonaTrigger requires.
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    fs.mkdirSync(path.join(dir, "scene_blocks"), { recursive: true });
    // Write a checkpoint that WOULD trigger persona generation (cold-start: scenes>0, last_persona_at=0).
    // PersonaTrigger.shouldGenerate Priority 2 fires when scenes_processed>0 + no persona + scene files exist.
    const cp = {
      total_processed: 5,
      last_l1_cursor: 0,
      memories_since_last_persona: 5,
      last_persona_at: 0,
      last_persona_time: null,
      scenes_processed: 1,
      request_persona_update: false,
      persona_update_reason: null,
      last_scene_name: null,
      runner_states: {},
    };
    fs.writeFileSync(
      path.join(dir, ".metadata", "recall_checkpoint.json"),
      JSON.stringify(cp),
      "utf-8",
    );
    // Write a dummy scene file so hasSceneFiles() returns true.
    fs.writeFileSync(
      path.join(dir, "scene_blocks", "scene-test.md"),
      "---\nMETA: {\"summary\":\"test\",\"heat\":1,\"created\":\"2026-06-01\",\"updated\":\"2026-06-01\"}\n---\ntest content\n",
      "utf-8",
    );
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("does NOT call llmRunner.run and emits the [L3] Skipped info log when kbProjectionOwnsProjectedFiles=true", async () => {
    const cfg = parseConfig({
      extraction: { engine: "kb", kbProjections: true },
    } as unknown as Record<string, unknown>);

    const kbStore = makeKbCapableStore();
    const { runner: fakeLlm, callCount } = makeFakeLlmRunner();
    const { logger, messages } = makeCapturingLogger();

    const l3Runner = createL3Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: {},
      vectorStore: kbStore,
      logger,
      llmRunner: fakeLlm,
    });

    // This would normally trigger persona generation (cold-start) …
    await l3Runner();

    // … but the KB guard must have intercepted it before PersonaGenerator ran.
    expect(callCount()).toBe(0); // LLM was NEVER called
    const skippedLog = messages.find((m) => m.includes("[L3] Skipped"));
    expect(skippedLog).toBeDefined(); // the guard log line was emitted
    expect(skippedLog).toContain("engine=kb");
    expect(skippedLog).toContain("kbProjections=on");
  });

  it("does NOT fire the guard on the l1 path (and reaches no LLM with zero records)", async () => {
    // On the l1 path the LLM IS the source of persona.md, so L3 must run.
    // We can't assert it reaches the LLM directly without a working PersonaGenerator,
    // but we CAN assert kbProjectionOwnsProjectedFiles=false and that no [L3] Skipped is logged.
    const cfg = parseConfig({
      extraction: { engine: "l1", kbProjections: true },
    } as unknown as Record<string, unknown>);

    const kbStore = makeKbCapableStore();
    const { runner: fakeLlm } = makeFakeLlmRunner();
    const { logger, messages } = makeCapturingLogger();

    // Sanity: the pure function says false for l1.
    expect(kbProjectionOwnsProjectedFiles(cfg, kbStore, fakeLlm)).toBe(false);

    const l3Runner = createL3Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: {},
      vectorStore: kbStore,
      logger,
      llmRunner: fakeLlm,
    });

    // We don't assert the LLM gets called here (PersonaGenerator needs a lot of
    // filesystem + LLM infra), but we DO assert the guard log was NOT emitted.
    try { await l3Runner(); } catch { /* PersonaGenerator may fail in test env */ }

    const skippedLog = messages.find((m) => m.includes("[L3] Skipped"));
    expect(skippedLog).toBeUndefined(); // guard did NOT fire
  });

  it("DOES NOT skip when llmRunner is undefined (fallback: no LLM → L3 guard must be false)", async () => {
    // When llmRunner is absent, kbProjectionOwnsProjectedFiles=false, guard must not emit
    // the skip log (it may skip for a different reason: "No LLM runner").
    const cfg = parseConfig({
      extraction: { engine: "kb", kbProjections: true },
    } as unknown as Record<string, unknown>);

    const kbStore = makeKbCapableStore();
    const { logger, messages } = makeCapturingLogger();

    const l3Runner = createL3Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: undefined,  // also no openclawConfig
      vectorStore: kbStore,
      logger,
      llmRunner: undefined,       // no runner → kbProjectionOwnsProjectedFiles=false
    });

    await l3Runner();

    // The [L3] Skipped guard line must NOT appear (skipped for a different reason).
    const guardSkip = messages.find((m) => m.includes("[L3] Skipped") && m.includes("kbProjections=on"));
    expect(guardSkip).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part C — createL2Runner behaviour: SceneExtractor NOT invoked on kb path
// (sibling of the L3 guard — protects scene_blocks/ from double-writes)
// ─────────────────────────────────────────────────────────────────────────────

describe("createL2Runner — skips SceneExtractor when kbProjectionOwnsProjectedFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-l2-guard-"));
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    fs.mkdirSync(path.join(dir, "scene_blocks"), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("does NOT call llmRunner.run and emits the [L2] Skipped info log when the projection owns scene_blocks", async () => {
    const cfg = parseConfig({
      extraction: { engine: "kb", kbProjections: true },
    } as unknown as Record<string, unknown>);

    const kbStore = makeKbCapableStore();
    const { runner: fakeLlm, callCount } = makeFakeLlmRunner();
    const { logger, messages } = makeCapturingLogger();

    const l2Runner = createL2Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: {},
      vectorStore: kbStore,
      logger,
      llmRunner: fakeLlm,
    });

    await l2Runner("test-session", undefined);

    // The guard must intercept before SceneExtractor (LLM) runs.
    expect(callCount()).toBe(0);
    const skippedLog = messages.find((m) => m.includes("[L2] Skipped"));
    expect(skippedLog).toBeDefined();
    expect(skippedLog).toContain("scene_blocks");
    expect(skippedLog).toContain("kbProjections=on");
  });

  it("does NOT emit the [L2] Skipped guard log on the l1 path (guard must not fire)", async () => {
    const cfg = parseConfig({
      extraction: { engine: "l1", kbProjections: true },
    } as unknown as Record<string, unknown>);

    const kbStore = makeKbCapableStore(); // queryMemoryRecords → [] → early "no records" exit
    const { runner: fakeLlm, callCount } = makeFakeLlmRunner();
    const { logger, messages } = makeCapturingLogger();

    // Sanity: the pure predicate is false on l1.
    expect(kbProjectionOwnsProjectedFiles(cfg, kbStore, fakeLlm)).toBe(false);

    const l2Runner = createL2Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: {},
      vectorStore: kbStore,
      logger,
      llmRunner: fakeLlm,
    });

    await l2Runner("test-session", undefined);

    // Guard did NOT fire (no [L2] Skipped guard line); and with zero L1 records the
    // LLM is never reached either.
    const skippedLog = messages.find((m) => m.includes("[L2] Skipped"));
    expect(skippedLog).toBeUndefined();
    expect(callCount()).toBe(0);
  });
});
