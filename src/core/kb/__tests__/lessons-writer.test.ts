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
  recordStanceFire,
  creditStanceConfirmed,
  creditStanceRejected,
} from "../lessons-writer.js";
import {
  WILLINGNESS_DEFAULT,
  willingnessAfterConfirm,
  willingnessAfterReject,
} from "../stance-track-record.js";
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

  // ── Pilastro B stance track-record primitives ──────────────────────────────
  describe("stance track record", () => {
    function freshLesson(): string {
      return insertLesson(db, { domain: "d", triggerPattern: "t", lessonText: "x", now: NOW }, 1000).id;
    }

    it("a fresh lesson starts at zero counts and WILLINGNESS_DEFAULT", () => {
      const row = getLessonById(db, freshLesson());
      expect(row?.stance_fire_count).toBe(0);
      expect(row?.stance_confirmed_count).toBe(0);
      expect(row?.stance_rejected_count).toBe(0);
      expect(row?.stance_willingness).toBeCloseTo(WILLINGNESS_DEFAULT);
    });

    it("recordStanceFire bumps only the fire count, not willingness", () => {
      const id = freshLesson();
      const row = recordStanceFire(db, id, NOW);
      expect(row?.stance_fire_count).toBe(1);
      expect(row?.stance_willingness).toBeCloseTo(WILLINGNESS_DEFAULT); // bare fire never moves willingness
    });

    it("creditStanceConfirmed raises willingness per willingnessAfterConfirm", () => {
      const id = freshLesson();
      const row = creditStanceConfirmed(db, id, NOW);
      expect(row?.stance_confirmed_count).toBe(1);
      expect(row?.stance_willingness).toBeCloseTo(willingnessAfterConfirm(WILLINGNESS_DEFAULT));
      expect(row!.stance_willingness).toBeGreaterThan(WILLINGNESS_DEFAULT);
    });

    it("creditStanceRejected lowers willingness per willingnessAfterReject", () => {
      const id = freshLesson();
      const row = creditStanceRejected(db, id, NOW);
      expect(row?.stance_rejected_count).toBe(1);
      expect(row?.stance_willingness).toBeCloseTo(willingnessAfterReject(WILLINGNESS_DEFAULT));
      expect(row!.stance_willingness).toBeLessThan(WILLINGNESS_DEFAULT);
    });

    it("three rejections drive willingness below the demote threshold (cry-wolf silences)", () => {
      const id = freshLesson();
      creditStanceRejected(db, id, NOW);
      creditStanceRejected(db, id, NOW);
      const row = creditStanceRejected(db, id, NOW);
      expect(row?.stance_rejected_count).toBe(3);
      expect(row!.stance_willingness).toBeLessThan(0.45); // DEMOTE_BELOW — no longer fires hard
    });

    it("a rejected stance climbs back after confirmations (symmetric, never erased)", () => {
      const id = freshLesson();
      creditStanceRejected(db, id, NOW);
      creditStanceRejected(db, id, NOW);
      const low = getLessonById(db, id)!.stance_willingness;
      creditStanceConfirmed(db, id, NOW);
      const back = getLessonById(db, id)!.stance_willingness;
      expect(back).toBeGreaterThan(low);
    });

    it("all three primitives return null for an unknown lesson id", () => {
      expect(recordStanceFire(db, "nope", NOW)).toBeNull();
      expect(creditStanceConfirmed(db, "nope", NOW)).toBeNull();
      expect(creditStanceRejected(db, "nope", NOW)).toBeNull();
    });
  });
});
