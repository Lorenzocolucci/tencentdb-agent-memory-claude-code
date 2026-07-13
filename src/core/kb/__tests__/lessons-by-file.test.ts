/**
 * B2b retrieval — queryHeadLessonsByFile: the read that lets a recurring-failure
 * lesson resurface when the agent touches a file in its trigger pattern.
 *
 * Pins the properties Proactive Injection depends on:
 *   - a lesson triggered by {fileA, fileB} surfaces for EITHER file, not for a
 *     third unrelated file;
 *   - superseded (non-HEAD) lessons never surface;
 *   - results are ranked by confidence (strongest lesson first);
 *   - namespace is honored.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  insertLesson,
  supersedeLesson,
  queryHeadLessonsByFile,
} from "../lessons-writer.js";

const LESSONS_DDL = `
  CREATE TABLE lessons (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL DEFAULT 'default',
    project TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL,
    trigger_pattern TEXT NOT NULL,
    lesson_text TEXT NOT NULL,
    anti_patterns_json TEXT NOT NULL DEFAULT '[]',
    evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
    evidence_count INTEGER NOT NULL DEFAULT 1,
    confidence REAL NOT NULL DEFAULT 0.5,
    version INTEGER NOT NULL DEFAULT 1,
    superseded_by TEXT,
    superseded_at TEXT,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    created_time TEXT NOT NULL,
    updated_time TEXT NOT NULL
  )`;

/** Canonical trigger JSON (same shape as canonicalTrigger in lesson-trigger.ts). */
function trigger(files: string[]): string {
  return JSON.stringify({ files: [...files].sort(), error_signatures: [], task_type: "" });
}

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(LESSONS_DDL);
});

describe("queryHeadLessonsByFile", () => {
  it("surfaces a lesson for ANY file in its trigger, not for unrelated files", () => {
    insertLesson(db, {
      domain: "notification-services",
      triggerPattern: trigger(["file:outbox.ts", "file:telegram.ts"]),
      lessonText: "Check the outbox state before editing a notification service.",
      evidenceEventIds: ["e1", "e2", "e3"],
      confidence: 0.8,
      now: "2026-06-29T00:00:00Z",
    });

    expect(queryHeadLessonsByFile(db, "file:outbox.ts").map((r) => r.domain)).toEqual(["notification-services"]);
    expect(queryHeadLessonsByFile(db, "file:telegram.ts")).toHaveLength(1);
    expect(queryHeadLessonsByFile(db, "file:unrelated.ts")).toHaveLength(0);
  });

  it("never surfaces a superseded lesson (HEAD only)", () => {
    const v1 = insertLesson(db, {
      domain: "d", triggerPattern: trigger(["file:a.ts"]), lessonText: "old", now: "t1",
    });
    const v2 = insertLesson(db, {
      domain: "d", triggerPattern: trigger(["file:a.ts"]), lessonText: "new", version: 2, now: "t2",
    });
    supersedeLesson(db, v1.id, v2.id, "t2");

    const hits = queryHeadLessonsByFile(db, "file:a.ts");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.lesson_text).toBe("new");
  });

  it("ranks by confidence (strongest lesson first) and honors the limit", () => {
    insertLesson(db, { domain: "low", triggerPattern: trigger(["file:a.ts"]), lessonText: "low", confidence: 0.4, now: "t" });
    insertLesson(db, { domain: "high", triggerPattern: trigger(["file:a.ts"]), lessonText: "high", confidence: 0.9, now: "t" });
    const hits = queryHeadLessonsByFile(db, "file:a.ts", "default", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.domain).toBe("high");
  });

  it("honors namespace isolation", () => {
    insertLesson(db, { namespace: "other", domain: "d", triggerPattern: trigger(["file:a.ts"]), lessonText: "x", now: "t" });
    expect(queryHeadLessonsByFile(db, "file:a.ts", "default")).toHaveLength(0);
    expect(queryHeadLessonsByFile(db, "file:a.ts", "other")).toHaveLength(1);
  });
});
