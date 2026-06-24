/**
 * Phase B part 2 — lessons writer (sync DB access layer).
 *
 * Throwaway in-memory DB with the foundations schema. Pins:
 *   - insertLesson creates a HEAD row (version 1, superseded_by NULL); JSON
 *     arrays (anti_patterns, evidence_event_ids) round-trip
 *   - queryHeadLessonByTrigger finds the current row, null for unknown
 *   - supersedeLesson links old→new and removes the old row from HEAD
 *   - namespace isolates lessons sharing a trigger pattern
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import {
  insertLesson,
  queryHeadLessonByTrigger,
  supersedeLesson,
  getLessonById,
} from "../lessons-writer.js";
import { _resetUlidStateForTest } from "../kb-queries.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };
const NOW = "2026-06-24T01:00:00.000Z";

describe("lessons-writer", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    initFoundationsSchema(db);
  });

  it("inserts a HEAD lesson and round-trips its JSON arrays", () => {
    const row = insertLesson(
      db,
      {
        domain: "circuit-breaker",
        triggerPattern: "circuit breaker trips on non-error status",
        lessonText: "Configure errorFilter/statusCodeFilter so 404 doesn't trip the breaker.",
        antiPatterns: ["treat all non-2xx as failure"],
        evidenceEventIds: ["bug1", "fix1"],
        confidence: 0.8,
        now: NOW,
      },
      1000,
    );

    expect(row.id).toMatch(/^les_/);
    expect(row.version).toBe(1);
    expect(row.superseded_by).toBeNull();
    expect(JSON.parse(row.anti_patterns_json)).toEqual(["treat all non-2xx as failure"]);
    expect(JSON.parse(row.evidence_event_ids_json)).toEqual(["bug1", "fix1"]);
    expect(row.evidence_count).toBe(2);

    const head = queryHeadLessonByTrigger(db, {
      domain: "circuit-breaker",
      triggerPattern: "circuit breaker trips on non-error status",
    });
    expect(head?.id).toBe(row.id);
  });

  it("returns null for an unknown trigger", () => {
    expect(queryHeadLessonByTrigger(db, { domain: "x", triggerPattern: "nope" })).toBeNull();
  });

  it("supersedes the old version and moves HEAD to the new one", () => {
    const v1 = insertLesson(
      db,
      { domain: "d", triggerPattern: "t", lessonText: "v1", now: NOW },
      1000,
    );
    const v2 = insertLesson(
      db,
      { domain: "d", triggerPattern: "t", lessonText: "v2 better", version: 2, now: NOW },
      2000,
    );
    supersedeLesson(db, v1.id, v2.id, NOW);

    const old = getLessonById(db, v1.id);
    expect(old?.superseded_by).toBe(v2.id);
    expect(old?.superseded_at).toBe(NOW);

    const head = queryHeadLessonByTrigger(db, { domain: "d", triggerPattern: "t" });
    expect(head?.id).toBe(v2.id);
    expect(head?.lesson_text).toBe("v2 better");
  });

  it("isolates lessons by namespace even with the same trigger", () => {
    insertLesson(db, { namespace: "t1", domain: "d", triggerPattern: "t", lessonText: "a", now: NOW }, 1000);
    insertLesson(db, { namespace: "t2", domain: "d", triggerPattern: "t", lessonText: "b", now: NOW }, 2000);

    expect(queryHeadLessonByTrigger(db, { namespace: "t1", domain: "d", triggerPattern: "t" })?.lesson_text).toBe("a");
    expect(queryHeadLessonByTrigger(db, { namespace: "t2", domain: "d", triggerPattern: "t" })?.lesson_text).toBe("b");
  });
});
