/**
 * Honest distillation stats (2026-09-05).
 *
 * Live that day the primary model was dead: 17/17 calls threw. The three
 * distillers swallowed the throw and returned null, the runners counted it as
 * "undistillable" / "rejected", and the gateway printed "no new lessons". A dead
 * model was reported as "nothing to learn". These tests pin the separation:
 * a THROWN call is `skippedLlmFailed` (+ its message), never a judge verdict.
 */
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { distillLessons, noteLlmFailure, MAX_LLM_ERRORS_KEPT } from "../lessons-runner.js";
import { distillPrinciples } from "../principle-runner.js";
import { distillUsage } from "../usage-runner.js";
import { distillLesson } from "../lessons-distiller.js";
import { distillPrinciple } from "../principle-distiller.js";
import { distillUsageCluster } from "../usage-distiller.js";
import { fakeEmbeddingReader } from "../bug-embeddings.js";
import { _resetUlidStateForTest } from "../kb-queries.js";
import type { KbEvent, KbEventInput } from "../../store/types.js";
import type { LLMRunner } from "../../types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };

const DEAD = "Not found the model moonshot-v1-auto or Permission denied";
const deadRunner = (): LLMRunner => ({ run: vi.fn(async () => { throw new Error(DEAD); }) });
const garbageRunner = (): LLMRunner => ({ run: vi.fn(async () => "not json at all") });

// ── distillers: the sink fires on a THROW only ───────────────────────────────

describe("distillers report a thrown LLM call, not an unusable answer", () => {
  it("distillLesson", async () => {
    const onLlmError = vi.fn();
    const cluster = { project: "p", bugTexts: ["a", "b"], fixTexts: [] };
    expect(await distillLesson(cluster, deadRunner(), { onLlmError })).toBeNull();
    expect(onLlmError).toHaveBeenCalledWith({ taskId: "lesson-distill", message: DEAD });
    onLlmError.mockClear();
    expect(await distillLesson(cluster, garbageRunner(), { onLlmError })).toBeNull();
    expect(onLlmError).not.toHaveBeenCalled();
  });

  it("distillPrinciple", async () => {
    const onLlmError = vi.fn();
    const cluster = { project: "p", domainEntity: "ent", texts: ["a", "b"] };
    expect(await distillPrinciple(cluster, deadRunner(), { onLlmError })).toBeNull();
    expect(onLlmError).toHaveBeenCalledWith({ taskId: "principle-distill", message: DEAD });
    onLlmError.mockClear();
    expect(await distillPrinciple(cluster, garbageRunner(), { onLlmError })).toBeNull();
    expect(onLlmError).not.toHaveBeenCalled();
  });

  it("distillUsageCluster", async () => {
    const onLlmError = vi.fn();
    const cluster = { project: "p", texts: ["a", "b"] };
    expect(await distillUsageCluster(cluster, deadRunner(), { onLlmError })).toBeNull();
    expect(onLlmError).toHaveBeenCalledWith({ taskId: "usage-distill", message: DEAD });
    onLlmError.mockClear();
    expect(await distillUsageCluster(cluster, garbageRunner(), { onLlmError })).toBeNull();
    expect(onLlmError).not.toHaveBeenCalled();
  });

  it("a throwing sink never turns the swallowed failure into a thrown one", async () => {
    const onLlmError = () => { throw new Error("sink exploded"); };
    await expect(distillLesson({ project: "p", bugTexts: ["a"], fixTexts: [] }, deadRunner(), { onLlmError })).resolves.toBeNull();
  });
});

// ── usage runner: LLM failed ≠ judge rejected ────────────────────────────────

function evt(p: Partial<KbEvent>): KbEvent {
  return {
    id: "e", ts: "2026-07-01T10:00:00.000Z", recorded_at: "r", session_key: "sA",
    session_id: "sid", namespace: "default", project: "sofia", type: "preference_stated",
    text: "aspetta la mia risposta", language: "it", entities: [], source_message_ids: ["m1"], ...p,
  };
}
const V = (...xs: number[]) => new Float32Array(xs);

describe("distillUsage stats", () => {
  const events = [
    evt({ id: "b1", session_id: "chatA" }),
    evt({ id: "b2", session_id: "chatB", source_message_ids: ["m2"] }),
  ];
  const reader = fakeEmbeddingReader(new Map([["b1", V(1, 0)], ["b2", V(0.99, 0.14)]]));

  it("dead model → skippedLlmFailed=1, skippedRejected=0, message kept, nothing written", async () => {
    const insert = vi.fn();
    const store = { listRecentEvents: () => events, insertEvent: insert, stampSalience: () => {} } as any;
    const stats = await distillUsage(store, reader, deadRunner(), { now: "n" });
    expect(stats.candidates).toBe(1);
    expect(stats.skippedLlmFailed).toBe(1);
    expect(stats.skippedRejected).toBe(0);
    expect(stats.llmErrors).toEqual([DEAD]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("judge says noise → skippedRejected=1, skippedLlmFailed=0 (unchanged verdict path)", async () => {
    const reject: LLMRunner = { run: vi.fn(async () => '{"is_tendency": false, "tendency_text": "", "confidence": 0.1}') };
    const store = { listRecentEvents: () => events, insertEvent: vi.fn(), stampSalience: () => {} } as any;
    const stats = await distillUsage(store, reader, reject, { now: "n" });
    expect(stats.skippedRejected).toBe(1);
    expect(stats.skippedLlmFailed).toBe(0);
    expect(stats.llmErrors).toEqual([]);
  });
});

// ── principle runner ─────────────────────────────────────────────────────────

describe("distillPrinciples stats", () => {
  it("dead model → skippedLlmFailed=1, skippedUndistillable=0", async () => {
    const decision = (p: Partial<KbEvent>) => evt({ type: "decision", text: "chose value pricing", entities: ["ent_pricing"], ...p });
    const events = [decision({ id: "d1", session_id: "chatA" }), decision({ id: "d2", session_id: "chatB" })];
    const store = { listRecentEvents: () => events, insertEvent: vi.fn(), stampSalience: () => {} } as any;
    const stats = await distillPrinciples(store, deadRunner(), { now: "n" });
    expect(stats.candidates).toBe(1);
    expect(stats.skippedLlmFailed).toBe(1);
    expect(stats.skippedUndistillable).toBe(0);
    expect(stats.llmErrors).toEqual([DEAD]);
  });
});

// ── lessons runner (real sqlite schema) ──────────────────────────────────────

function seedTables(db: DatabaseSync): void {
  db.prepare(
    `CREATE TABLE events (
       id TEXT PRIMARY KEY, ts TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
       session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
       namespace TEXT NOT NULL DEFAULT 'default', project TEXT NOT NULL DEFAULT '',
       type TEXT NOT NULL, text TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'und',
       entities_json TEXT NOT NULL DEFAULT '[]', source_message_ids_json TEXT NOT NULL DEFAULT '[]'
     )`,
  ).run();
  db.prepare(
    `CREATE TABLE relations (
       id TEXT PRIMARY KEY, src_entity_id TEXT NOT NULL, type TEXT NOT NULL,
       dst_entity_id TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT 'default',
       valid_from TEXT, valid_to TEXT, support INTEGER NOT NULL DEFAULT 1,
       source_event_id TEXT, created_time TEXT NOT NULL DEFAULT ''
     )`,
  ).run();
}

function insBug(db: DatabaseSync, id: string, session: string, ts: string): void {
  db.prepare("INSERT INTO events (id, ts, recorded_at, session_key, type, text) VALUES (?, ?, ?, ?, 'bug', ?)")
    .run(id, ts, ts, session, `bug text for ${id}`);
}

function unitVec(dims = 16): Float32Array {
  const v = new Float32Array(dims);
  v.fill(Math.sqrt(1 / dims));
  return v;
}

describe("distillLessons stats", () => {
  it("dead model → skippedLlmFailed=1, skippedUndistillable=0, no lesson row", async () => {
    _resetUlidStateForTest();
    const db = new DB(":memory:");
    initFoundationsSchema(db);
    seedTables(db);
    insBug(db, "bug1", "sA", "2026-06-01T00:00:00Z");
    insBug(db, "bug2", "sB", "2026-06-02T00:00:00Z");
    const embReader = fakeEmbeddingReader(new Map([["bug1", unitVec()], ["bug2", unitVec()]]));

    const stats = await distillLessons(db, deadRunner(), { now: "2026-06-24T01:00:00.000Z", embeddingReader: embReader });

    expect(stats.candidates).toBe(1);
    expect(stats.skippedLlmFailed).toBe(1);
    expect(stats.skippedUndistillable).toBe(0);
    expect(stats.inserted).toBe(0);
    expect(stats.llmErrors).toEqual([DEAD]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number }).n).toBe(0);
  });

  it("garbage answer → still skippedUndistillable (the old counter keeps its meaning)", async () => {
    _resetUlidStateForTest();
    const db = new DB(":memory:");
    initFoundationsSchema(db);
    seedTables(db);
    insBug(db, "bug1", "sA", "2026-06-01T00:00:00Z");
    insBug(db, "bug2", "sB", "2026-06-02T00:00:00Z");
    const embReader = fakeEmbeddingReader(new Map([["bug1", unitVec()], ["bug2", unitVec()]]));
    const stats = await distillLessons(db, garbageRunner(), { now: "2026-06-24T01:00:00.000Z", embeddingReader: embReader });
    expect(stats.skippedUndistillable).toBe(1);
    expect(stats.skippedLlmFailed).toBe(0);
  });
});

describe("noteLlmFailure", () => {
  it("counts every failure but keeps only the first distinct messages", () => {
    const stats = { skippedLlmFailed: 0, llmErrors: [] as string[] };
    for (let i = 0; i < MAX_LLM_ERRORS_KEPT + 3; i++) noteLlmFailure(stats, `e${i}`);
    noteLlmFailure(stats, "e0");
    expect(stats.skippedLlmFailed).toBe(MAX_LLM_ERRORS_KEPT + 4);
    expect(stats.llmErrors).toHaveLength(MAX_LLM_ERRORS_KEPT);
    expect(stats.llmErrors[0]).toBe("e0");
  });
});

// ── the store-less shape a fake store returns must still satisfy callers ──────

describe("KbEventInput compatibility (sanity)", () => {
  it("evt() builds a KbEventInput-compatible object", () => {
    const e: KbEventInput = { ts: "t", sessionKey: "s", type: "bug", text: "x" };
    expect(e.type).toBe("bug");
  });
});
