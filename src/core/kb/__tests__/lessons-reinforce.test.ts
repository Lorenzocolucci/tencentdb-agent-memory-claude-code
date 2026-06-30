/**
 * Phase B3 — lessons reinforcement writer (exposure + avoidance crediting).
 * Throwaway in-memory DB with the foundations schema.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import {
  insertLesson,
  recordExposure,
  creditAvoidance,
  temperOnRecurrence,
  queryLessonsExposedInSession,
  getLessonById,
} from "../lessons-writer.js";
import { _resetUlidStateForTest } from "../kb-queries.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };
const NOW = "2026-06-30T01:00:00.000Z";

function seed(db: DatabaseSync, conf = 0.5) {
  return insertLesson(db, {
    domain: "d", triggerPattern: "t", lessonText: "L", confidence: conf, now: NOW,
  });
}

describe("lessons reinforcement writer (B3)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    initFoundationsSchema(db);
  });

  it("recordExposure bumps exposure_count and stamps the session", () => {
    const l = seed(db);
    recordExposure(db, l.id, "sess-1", "2026-06-30T02:00:00.000Z");
    const row = getLessonById(db, l.id)!;
    expect(row.exposure_count).toBe(1);
    expect(row.last_exposed_session_id).toBe("sess-1");
    expect(row.last_exposed_at).toBe("2026-06-30T02:00:00.000Z");
  });

  it("creditAvoidance bumps avoidance_count and raises confidence", () => {
    const l = seed(db, 0.5);
    const after = creditAvoidance(db, l.id, "2026-06-30T02:00:00.000Z")!;
    expect(after.avoidance_count).toBe(1);
    expect(after.confidence).toBeGreaterThan(0.5);
  });

  it("temperOnRecurrence lowers confidence (the lesson did not fully protect)", () => {
    const l = seed(db, 0.8);
    const after = temperOnRecurrence(db, l.id, "2026-06-30T02:00:00.000Z")!;
    expect(after.confidence).toBeLessThan(0.8);
  });

  it("queryLessonsExposedInSession returns only lessons exposed in that session", () => {
    const a = seed(db);
    const b = seed(db);
    recordExposure(db, a.id, "sess-X", NOW);
    recordExposure(db, b.id, "sess-Y", NOW);
    const inX = queryLessonsExposedInSession(db, "sess-X");
    expect(inX.map((r) => r.id)).toContain(a.id);
    expect(inX.map((r) => r.id)).not.toContain(b.id);
  });

  it("a superseded lesson is not returned as exposed-in-session (HEAD only)", () => {
    const a = seed(db);
    recordExposure(db, a.id, "sess-Z", NOW);
    // mark it superseded
    db.prepare("UPDATE lessons SET superseded_by = 'x' WHERE id = ?").run(a.id);
    expect(queryLessonsExposedInSession(db, "sess-Z")).toHaveLength(0);
  });
});
