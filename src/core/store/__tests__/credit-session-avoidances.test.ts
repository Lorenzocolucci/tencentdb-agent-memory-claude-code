import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { insertLesson, recordExposure, getLessonById } from "../../kb/lessons-writer.js";

describe("creditSessionAvoidances — implicit Phase-A crediting at session end (B3)", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-30T22:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-credit-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const db = () => (store as never as { db: never }).db;

  /** A Phase-A lesson (avoidance_count ≥ τ) triggered by file entity `fileId`, exposed in `sess`. */
  function phaseALesson(fileId: string, sess: string) {
    const l = insertLesson(db(), {
      domain: "d", triggerPattern: JSON.stringify({ files: [fileId] }),
      lessonText: "L", confidence: 0.5, now,
    });
    (db() as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => void } })
      .prepare("UPDATE lessons SET avoidance_count = 3 WHERE id = ?").run(l.id);
    recordExposure(db(), l.id, sess, now);
    return l.id;
  }

  function insertBugEvent(sess: string, entityId: string) {
    (db() as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => void } })
      .prepare(
        `INSERT INTO events (id, ts, recorded_at, session_key, type, text, entities_json)
         VALUES (?, ?, ?, ?, 'bug', 'boom', ?)`,
      )
      .run("ev-" + entityId, now, now, sess, JSON.stringify([entityId]));
  }

  it("credits an avoidance when an exposed Phase-A lesson did NOT relapse", () => {
    const id = phaseALesson("file-1", "sess-A");
    const before = getLessonById(db(), id)!;
    const res = store.creditSessionAvoidances("sess-A", "2026-06-30T23:00:00.000Z");
    expect(res.credited).toBe(1);
    const after = getLessonById(db(), id)!;
    expect(after.avoidance_count).toBe(4);
    expect(after.confidence).toBeGreaterThan(before.confidence);
  });

  it("tempers (does NOT credit) when the failure relapsed this session", () => {
    const id = phaseALesson("file-2", "sess-B");
    insertBugEvent("sess-B", "file-2"); // a bug touching the trigger file = relapse
    const before = getLessonById(db(), id)!;
    const res = store.creditSessionAvoidances("sess-B", "2026-06-30T23:00:00.000Z");
    expect(res.tempered).toBe(1);
    expect(res.credited).toBe(0);
    expect(getLessonById(db(), id)!.confidence).toBeLessThan(before.confidence);
  });

  it("skips a Phase-B (young) lesson — it waits for explicit confirmation", () => {
    const l = insertLesson(db(), {
      domain: "d", triggerPattern: JSON.stringify({ files: ["file-3"] }),
      lessonText: "L", confidence: 0.5, now,
    });
    recordExposure(db(), l.id, "sess-C", now); // avoidance_count stays 0 → Phase B
    const res = store.creditSessionAvoidances("sess-C", "2026-06-30T23:00:00.000Z");
    expect(res.credited).toBe(0);
    expect(getLessonById(db(), l.id)!.avoidance_count).toBe(0);
  });
});
