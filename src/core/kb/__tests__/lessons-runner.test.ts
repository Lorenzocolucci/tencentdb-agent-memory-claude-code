/**
 * Phase B1 — lessons orchestrator (clusters → distill → write). Offline (LLM injected).
 * Pins: cluster distills+inserts; dedup skips already-covered; accept-if-improves.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { distillLessons } from "../lessons-runner.js";
import { insertLesson, queryHeadLessonByTrigger } from "../lessons-writer.js";
import { _resetUlidStateForTest } from "../kb-queries.js";
import { fakeEmbeddingReader } from "../bug-embeddings.js";
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

function runnerOf(obj: Record<string, unknown>): LLMRunner {
  return { run: vi.fn(async () => JSON.stringify(obj)) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("distillLessons orchestrator (B1 cross-session)", () => {
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
      new Map([
        ["bug1", unitVec()],
        ["bug2", unitVec()],
      ]),
    );

    const runner = runnerOf({
      domain: "circuit-breaker",
      trigger_pattern: "breaker trips on non-error status",
      lesson_text: "Add errorFilter/statusCodeFilter.",
      anti_patterns: [],
      confidence: 0.8,
    });

    const stats = await distillLessons(db, runner, { now: NOW, embeddingReader: embReader });

    expect(stats.inserted).toBe(1);
    expect(stats.candidates).toBe(1);
    const head = queryHeadLessonByTrigger(db, {
      domain: "circuit-breaker",
      triggerPattern: "breaker trips on non-error status",
    });
    expect(head).not.toBeNull();
    expect(head!.evidence_count).toBe(2);
    expect(JSON.parse(head!.evidence_event_ids_json).sort()).toEqual(["bug1", "bug2"].sort());
  });

  it("does not re-distill a cluster already covered by a lesson", async () => {
    insBug(db, "bug1", "sA", "2026-06-01T00:00:00Z");
    insBug(db, "bug2", "sB", "2026-06-02T00:00:00Z");
    embReader = fakeEmbeddingReader(
      new Map([
        ["bug1", unitVec()],
        ["bug2", unitVec()],
      ]),
    );

    const runner = runnerOf({
      domain: "d",
      trigger_pattern: "t",
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
    insertLesson(
      db,
      { domain: "d", triggerPattern: "t", lessonText: "old", confidence: 0.4, now: NOW },
      500,
    );
    insBug(db, "bug3", "sC", "2026-06-03T00:00:00Z");
    insBug(db, "bug4", "sD", "2026-06-04T00:00:00Z");
    embReader = fakeEmbeddingReader(
      new Map([
        ["bug3", unitVec()],
        ["bug4", unitVec()],
      ]),
    );

    const better = runnerOf({
      domain: "d",
      trigger_pattern: "t",
      lesson_text: "new and better",
      anti_patterns: [],
      confidence: 0.9,
    });

    const stats = await distillLessons(db, better, { now: NOW, embeddingReader: embReader });

    expect(stats.superseded).toBe(1);
    const head = queryHeadLessonByTrigger(db, { domain: "d", triggerPattern: "t" });
    expect(head!.lesson_text).toBe("new and better");
    expect(head!.version).toBe(2);
  });

  it("keeps the old lesson when the new one does not improve", async () => {
    insertLesson(
      db,
      { domain: "d", triggerPattern: "t", lessonText: "old strong", confidence: 0.9, now: NOW },
      500,
    );
    insBug(db, "bug5", "sE", "2026-06-05T00:00:00Z");
    insBug(db, "bug6", "sF", "2026-06-06T00:00:00Z");
    embReader = fakeEmbeddingReader(
      new Map([
        ["bug5", unitVec()],
        ["bug6", unitVec()],
      ]),
    );

    const worse = runnerOf({
      domain: "d",
      trigger_pattern: "t",
      lesson_text: "weak",
      anti_patterns: [],
      confidence: 0.5,
    });

    const stats = await distillLessons(db, worse, { now: NOW, embeddingReader: embReader });

    expect(stats.superseded).toBe(0);
    expect(stats.skippedNotImproved).toBe(1);
    const head = queryHeadLessonByTrigger(db, { domain: "d", triggerPattern: "t" });
    expect(head!.lesson_text).toBe("old strong");
  });
});
