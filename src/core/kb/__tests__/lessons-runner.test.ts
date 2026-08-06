/**
 * Phase B (B2a+) — lessons orchestrator (clusters → distill → write). Offline (LLM injected).
 *
 * B2a changes reflected here:
 *   - trigger_pattern in DB = canonicalTrigger(clusterTrigger(...)), NOT the LLM's field.
 *     The LLM response no longer needs trigger_pattern; we query the HEAD by the
 *     canonical fingerprint, not by a hard-coded string.
 *   - DistilledLesson has no triggerPattern field; LLM JSON omits it.
 *   - toDistillable uses bugTexts[] (recurrences) + fixTexts from relations.
 *
 * Pins: cluster distills+inserts; dedup skips already-covered; accept-if-improves.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { distillLessons } from "../lessons-runner.js";
import { insertLesson, queryHeadLessonByTrigger, getLessonById } from "../lessons-writer.js";
import { _resetUlidStateForTest } from "../kb-queries.js";
import { fakeEmbeddingReader } from "../bug-embeddings.js";
import { canonicalTrigger } from "../lesson-trigger.js";
import type { LLMRunner } from "../types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };
const NOW = "2026-06-24T01:00:00.000Z";

// ── Schema helpers ────────────────────────────────────────────────────────────

function seedEventsTable(db: DatabaseSync): void {
  db.prepare(
    `CREATE TABLE events (
       id TEXT PRIMARY KEY, ts TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
       session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
       namespace TEXT NOT NULL DEFAULT 'default', project TEXT NOT NULL DEFAULT '',
       type TEXT NOT NULL, text TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'und',
       entities_json TEXT NOT NULL DEFAULT '[]', source_message_ids_json TEXT NOT NULL DEFAULT '[]'
     )`,
  ).run();
}

function seedRelationsTable(db: DatabaseSync): void {
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
  db.prepare(
    "INSERT INTO events (id, ts, recorded_at, session_key, type, text) VALUES (?, ?, ?, ?, 'bug', ?)",
  ).run(id, ts, ts, session, `bug text for ${id}`);
}

function unitVec(dims = 16): Float32Array {
  const v = new Float32Array(dims);
  v.fill(Math.sqrt(1 / dims));
  return v;
}

// B2a: LLM JSON no longer needs trigger_pattern
function runnerOf(obj: Record<string, unknown>): LLMRunner {
  return { run: vi.fn(async () => JSON.stringify(obj)) };
}

/**
 * Compute the canonical trigger for a 2-bug cluster with no files/signatures.
 * Mirrors what lessons-runner will produce internally.
 */
function emptyTrigger(): string {
  return canonicalTrigger({ files: [], errorSignatures: [], taskType: "" });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("distillLessons orchestrator (B2a cross-session)", () => {
  let db: DatabaseSync;
  let embReader: ReturnType<typeof fakeEmbeddingReader>;

  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    initFoundationsSchema(db);
    seedEventsTable(db);
    seedRelationsTable(db);
    embReader = fakeEmbeddingReader(new Map());
  });

  it("distills a cross-session cluster and writes a HEAD lesson with evidence", async () => {
    insBug(db, "bug1", "sA", "2026-06-01T00:00:00Z");
    insBug(db, "bug2", "sB", "2026-06-02T00:00:00Z");
    embReader = fakeEmbeddingReader(
      new Map([["bug1", unitVec()], ["bug2", unitVec()]]),
    );

    // B2a: no trigger_pattern in LLM response
    const runner = runnerOf({
      domain: "circuit-breaker",
      lesson_text: "Add errorFilter/statusCodeFilter.",
      anti_patterns: [],
      confidence: 0.8,
    });

    const stats = await distillLessons(db, runner, { now: NOW, embeddingReader: embReader });

    expect(stats.inserted).toBe(1);
    expect(stats.candidates).toBe(1);

    // Query by canonical trigger (not LLM text)
    const head = queryHeadLessonByTrigger(db, {
      domain: "circuit-breaker",
      triggerPattern: emptyTrigger(),
    });
    expect(head).not.toBeNull();
    expect(head!.evidence_count).toBe(2);
    expect(JSON.parse(head!.evidence_event_ids_json).sort()).toEqual(["bug1", "bug2"].sort());
    // trigger_pattern is the canonical fingerprint JSON
    expect(head!.trigger_pattern).toBe(emptyTrigger());
  });

  it("does not re-distill a cluster already covered by a lesson", async () => {
    insBug(db, "bug1", "sA", "2026-06-01T00:00:00Z");
    insBug(db, "bug2", "sB", "2026-06-02T00:00:00Z");
    embReader = fakeEmbeddingReader(
      new Map([["bug1", unitVec()], ["bug2", unitVec()]]),
    );

    const runner = runnerOf({
      domain: "d",
      lesson_text: "x",
      anti_patterns: [],
      confidence: 0.8,
    });

    await distillLessons(db, runner, { now: NOW, embeddingReader: embReader });
    const stats2 = await distillLessons(db, runner, { now: NOW, embeddingReader: embReader });

    expect(stats2.skippedDuplicate).toBe(1);
    expect(stats2.inserted).toBe(0);
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("supersedes an existing lesson only when the new one improves", async () => {
    // Pre-insert a lesson with the canonical trigger pattern
    insertLesson(
      db,
      { domain: "d", triggerPattern: emptyTrigger(), lessonText: "old", confidence: 0.4, now: NOW },
      500,
    );
    insBug(db, "bug3", "sC", "2026-06-03T00:00:00Z");
    insBug(db, "bug4", "sD", "2026-06-04T00:00:00Z");
    embReader = fakeEmbeddingReader(
      new Map([["bug3", unitVec()], ["bug4", unitVec()]]),
    );

    const better = runnerOf({
      domain: "d",
      lesson_text: "new and better",
      anti_patterns: [],
      confidence: 0.9,
    });

    const stats = await distillLessons(db, better, { now: NOW, embeddingReader: embReader });

    expect(stats.superseded).toBe(1);
    const head = queryHeadLessonByTrigger(db, { domain: "d", triggerPattern: emptyTrigger() });
    expect(head!.lesson_text).toBe("new and better");
    expect(head!.version).toBe(2);
  });

  it("keeps the old lesson when the new one does not improve", async () => {
    insertLesson(
      db,
      { domain: "d", triggerPattern: emptyTrigger(), lessonText: "old strong", confidence: 0.9, now: NOW },
      500,
    );
    insBug(db, "bug5", "sE", "2026-06-05T00:00:00Z");
    insBug(db, "bug6", "sF", "2026-06-06T00:00:00Z");
    embReader = fakeEmbeddingReader(
      new Map([["bug5", unitVec()], ["bug6", unitVec()]]),
    );

    const worse = runnerOf({
      domain: "d",
      lesson_text: "weak",
      anti_patterns: [],
      confidence: 0.5,
    });

    const stats = await distillLessons(db, worse, { now: NOW, embeddingReader: embReader });

    expect(stats.superseded).toBe(0);
    expect(stats.skippedNotImproved).toBe(1);
    const head = queryHeadLessonByTrigger(db, { domain: "d", triggerPattern: emptyTrigger() });
    expect(head!.lesson_text).toBe("old strong");
  });

  it("lesson row has no triggerPattern from LLM — trigger_pattern is canonical JSON", async () => {
    insBug(db, "bugX", "sX", "2026-06-10T00:00:00Z");
    insBug(db, "bugY", "sY", "2026-06-11T00:00:00Z");
    embReader = fakeEmbeddingReader(
      new Map([["bugX", unitVec()], ["bugY", unitVec()]]),
    );

    const runner = runnerOf({
      domain: "serialization",
      trigger_pattern: "LLM text should be ignored",
      lesson_text: "Validate before serialise.",
      anti_patterns: [],
      confidence: 0.7,
    });

    const stats = await distillLessons(db, runner, { now: NOW, embeddingReader: embReader });
    expect(stats.inserted).toBe(1);

    const head = queryHeadLessonByTrigger(db, {
      domain: "serialization",
      triggerPattern: emptyTrigger(),
    });
    expect(head).not.toBeNull();
    expect(head!.trigger_pattern).toBe(emptyTrigger());
    // Confirm it is parseable canonical JSON
    const parsed = JSON.parse(head!.trigger_pattern) as Record<string, unknown>;
    expect(parsed).toHaveProperty("files");
    expect(parsed).toHaveProperty("error_signatures");
    expect(parsed).toHaveProperty("task_type");
  });

  it("maxClusters advances to NEW clusters across runs (already-covered ones do not consume the budget)", async () => {
    // Two DISTINCT clusters: group A (orthogonal vector e0) and group B (e1).
    insBug(db, "a1", "sA1", "2026-06-01T00:00:00Z");
    insBug(db, "a2", "sA2", "2026-06-02T00:00:00Z");
    insBug(db, "b1", "sB1", "2026-06-03T00:00:00Z");
    insBug(db, "b2", "sB2", "2026-06-04T00:00:00Z");
    const axis = (i: number): Float32Array => {
      const v = new Float32Array(16);
      v[i] = 1; // unit vector on a single axis → the two groups are orthogonal
      return v;
    };
    embReader = fakeEmbeddingReader(
      new Map([["a1", axis(0)], ["a2", axis(0)], ["b1", axis(1)], ["b2", axis(1)]]),
    );

    // Distinct domains so each cluster writes its own HEAD lesson.
    let call = 0;
    const runner: LLMRunner = {
      run: vi.fn(async () => {
        call += 1;
        return JSON.stringify({
          domain: `domain-${call}`,
          lesson_text: `lesson ${call}`,
          anti_patterns: [],
          confidence: 0.8,
        });
      }),
    };

    // Run 1 with a budget of ONE cluster → exactly one lesson.
    const first = await distillLessons(db, runner, {
      now: NOW,
      embeddingReader: embReader,
      maxClusters: 1,
    });
    expect(first.inserted).toBe(1);

    // Run 2, same budget. The cluster distilled in run 1 must NOT consume the
    // budget again — the run must advance to the OTHER cluster. Before the fix
    // this returned inserted=0 forever (same first cluster re-picked + skipped),
    // which is why only 6 lessons existed against 27 real clusters on the live DB.
    const second = await distillLessons(db, runner, {
      now: NOW,
      embeddingReader: embReader,
      maxClusters: 1,
    });
    expect(second.inserted).toBe(1);
    // The already-covered cluster is still REPORTED as a duplicate — it just no
    // longer eats the budget, so the fresh cluster is reached in the same run.
    expect(second.skippedDuplicate).toBe(1);

    // Two distinct lessons now exist.
    const total = db.prepare("SELECT COUNT(*) c FROM lessons").get() as { c: number };
    expect(total.c).toBe(2);
  });
});
