/**
 * B2a — lessons-runner changes: deterministic trigger_pattern + real fixes from
 * fixed-by relations (not bugTexts.slice(1)).
 *
 * These tests pin the NEW behaviour introduced in B2a:
 *   T1  trigger_pattern stored in DB = canonicalTrigger(clusterTrigger(...))
 *       (deterministic JSON, NOT the LLM's free-text trigger_pattern field).
 *   T2  Fixes passed to the distiller come from fixed-by relations, not
 *       bugTexts.slice(1). When no fix events exist, fixTexts=[] is passed.
 *   T3  The LLM response no longer needs trigger_pattern in its JSON; the parser
 *       still accepts it if present (backward-compat) but the stored value is
 *       always the canonical fingerprint.
 *
 * Seed approach mirrors lessons-runner.test.ts (in-memory SQLite + fake LLM).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { distillLessons } from "../lessons-runner.js";
import { queryHeadLessonByTrigger } from "../lessons-writer.js";
import { _resetUlidStateForTest } from "../kb-queries.js";
import { fakeEmbeddingReader } from "../bug-embeddings.js";
import { canonicalTrigger, clusterTrigger, type PerBugBreakdown } from "../lesson-trigger.js";
import type { LLMRunner } from "../types.js";
import type { FailureCluster } from "../bug-clusters.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => DatabaseSync;
};

const NOW = "2026-06-24T02:00:00.000Z";

// ── Schema helpers ─────────────────────────────────────────────────────────────

function createSchema(db: DatabaseSync): void {
  initFoundationsSchema(db);
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

function insBug(
  db: DatabaseSync,
  id: string,
  session: string,
  text = `bug text for ${id}`,
  entities: string[] = [],
): void {
  db.prepare(
    `INSERT INTO events (id, ts, recorded_at, session_key, type, text, entities_json)
     VALUES (?, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', ?, 'bug', ?, ?)`,
  ).run(id, session, text, JSON.stringify(entities));
}

function insFix(db: DatabaseSync, id: string, session: string, text: string): void {
  db.prepare(
    `INSERT INTO events (id, ts, recorded_at, session_key, type, text)
     VALUES (?, '2026-06-01T01:00:00Z', '2026-06-01T01:00:00Z', ?, 'fix', ?)`,
  ).run(id, session, text);
}

function insRelation(
  db: DatabaseSync,
  id: string,
  src: string,
  type: string,
  dst: string,
): void {
  db.prepare(
    `INSERT INTO relations (id, src_entity_id, type, dst_entity_id, created_time)
     VALUES (?, ?, ?, ?, '2026-06-01T00:00:00Z')`,
  ).run(id, src, type, dst);
}

function unitVec(dims = 16): Float32Array {
  const v = new Float32Array(dims);
  v.fill(Math.sqrt(1 / dims));
  return v;
}

function runnerOf(obj: Record<string, unknown>): LLMRunner {
  return { run: vi.fn(async () => JSON.stringify(obj)) };
}

// ── T1: trigger_pattern = canonical fingerprint, NOT LLM text ─────────────────

describe("T1 — trigger_pattern is canonical fingerprint (not LLM text)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    createSchema(db);
  });

  it("stores canonicalTrigger fingerprint, not the LLM's trigger_pattern field", async () => {
    insBug(db, "bug1", "sA", "TypeError in payment flow", ["ent_pay"]);
    insBug(db, "bug2", "sB", "TypeError in payment flow again", ["ent_pay"]);

    const reader = fakeEmbeddingReader(
      new Map([["bug1", unitVec()], ["bug2", unitVec()]]),
    );

    // LLM returns its own free-text trigger_pattern — should NOT end up in DB
    const runner = runnerOf({
      domain: "payment",
      trigger_pattern: "LLM decided trigger text — should be ignored",
      lesson_text: "Always validate payment amounts.",
      anti_patterns: [],
      confidence: 0.8,
    });

    const stats = await distillLessons(db, runner, { now: NOW, embeddingReader: reader });
    expect(stats.inserted).toBe(1);

    // Build what the canonical trigger SHOULD be for this cluster
    const cluster: FailureCluster = {
      bugEventIds: ["bug1", "bug2"],
      bugTexts: ["TypeError in payment flow", "TypeError in payment flow again"],
      distinctSessionCount: 2,
      sessionKeys: ["sA", "sB"],
      namespace: "default",
      project: "",
      files: [],
      entityIds: ["ent_pay"],
      errorSignatures: [],
    };
    const breakdowns: PerBugBreakdown[] = [
      { bugEventId: "bug1", files: [], errorSignatures: ["TypeError"] },
      { bugEventId: "bug2", files: [], errorSignatures: ["TypeError"] },
    ];
    const expected = canonicalTrigger(clusterTrigger(cluster, breakdowns));

    const head = queryHeadLessonByTrigger(db, {
      domain: "payment",
      triggerPattern: expected,
    });
    expect(head).not.toBeNull();
    // The stored trigger is the canonical fingerprint, not the LLM string
    expect(head!.trigger_pattern).toBe(expected);
    expect(head!.trigger_pattern).not.toContain("LLM decided");
  });
});

// ── T2: fix events from fixed-by relations, not bugTexts.slice(1) ─────────────

describe("T2 — fix texts from fixed-by relations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    createSchema(db);
  });

  it("passes fix event texts when fixed-by relations exist", async () => {
    // Real KB shape: bug events reference ent_* entity ids, not each other.
    // Relations link entity ids on BOTH sides (verified live: 20/20 ent_* endpoints).
    insBug(db, "bugA", "sA", "Circuit breaker trips on 404", ["ent_circuit_breaker"]);
    insBug(db, "bugB", "sB", "Circuit breaker trips on 404 again", ["ent_circuit_breaker"]);
    insFix(db, "fixA", "sA", "Added statusCodeFilter to ignore 404");
    // Seed fix event with its own entity id so the chain can find it.
    db.prepare(
      `UPDATE events SET entities_json = '["ent_fix_circuit"]' WHERE id = 'fixA'`,
    ).run();
    // ent_circuit_breaker --fixed-by--> ent_fix_circuit (BOTH endpoints are ent_*)
    insRelation(db, "rel1", "ent_circuit_breaker", "fixed-by", "ent_fix_circuit");

    const reader = fakeEmbeddingReader(
      new Map([["bugA", unitVec()], ["bugB", unitVec()]]),
    );

    let capturedPrompt = "";
    const runner: LLMRunner = {
      run: vi.fn(async (p) => {
        capturedPrompt = p.prompt;
        return JSON.stringify({
          domain: "circuit-breaker",
          lesson_text: "Use statusCodeFilter.",
          anti_patterns: [],
          confidence: 0.8,
        });
      }),
    };

    await distillLessons(db, runner, { now: NOW, embeddingReader: reader });

    // Fix text should appear in the prompt
    expect(capturedPrompt).toContain("statusCodeFilter");
    // bugTexts.slice(1) is "Circuit breaker trips on 404 again" — should NOT be presented as a fix
    // (it IS present as a recurrence, but it should not appear in the "FIX" section)
    expect(capturedPrompt).toContain("RECURRENCE");
  });

  it("passes empty fixes when no fixed-by relations exist", async () => {
    insBug(db, "bugC", "sC", "Repeated crash in auth", []);
    insBug(db, "bugD", "sD", "Repeated crash in auth again", []);

    const reader = fakeEmbeddingReader(
      new Map([["bugC", unitVec()], ["bugD", unitVec()]]),
    );

    let capturedPrompt = "";
    const runner: LLMRunner = {
      run: vi.fn(async (p) => {
        capturedPrompt = p.prompt;
        return JSON.stringify({
          domain: "auth",
          lesson_text: "Investigate auth crash.",
          anti_patterns: [],
          confidence: 0.6,
        });
      }),
    };

    await distillLessons(db, runner, { now: NOW, embeddingReader: reader });

    // No fix events → fix section empty / indicates unknown
    expect(capturedPrompt).toContain("RECURRENCE");
    // The second bug text should NOT be presented as a fix
    expect(capturedPrompt).not.toMatch(/FIX.*Repeated crash in auth again/s);
  });
});

// ── T3: distiller output without trigger_pattern is still accepted ─────────────

describe("T3 — distiller output without trigger_pattern still parses", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    createSchema(db);
  });

  it("inserts a lesson when the LLM omits trigger_pattern from its JSON", async () => {
    insBug(db, "bug10", "s10", "Null pointer in serializer", []);
    insBug(db, "bug11", "s11", "Null pointer in serializer again", []);

    const reader = fakeEmbeddingReader(
      new Map([["bug10", unitVec()], ["bug11", unitVec()]]),
    );

    // LLM response without trigger_pattern (B2a contract: not required)
    const runner = runnerOf({
      domain: "serialization",
      lesson_text: "Validate before serialize.",
      anti_patterns: ["skip null check"],
      confidence: 0.75,
    });

    const stats = await distillLessons(db, runner, { now: NOW, embeddingReader: reader });
    expect(stats.inserted).toBe(1);
    expect(stats.skippedUndistillable).toBe(0);
  });
});
