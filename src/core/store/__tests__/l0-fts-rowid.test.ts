/**
 * L0 capture write cost (Phase 5): `DELETE FROM l0_fts WHERE record_id = ?` scans the
 * whole FTS content table (record_id is UNINDEXED), 300-870 ms on the 47k-row live
 * copy. New L0 rows get FTS rowid = l0_conversations.rowid so updates/deletes go by
 * rowid. Ground truth is read straight from the SQLite file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../sqlite.js";

const DIMS = 4;

function rec(id: string, text: string) {
  return {
    id,
    sessionKey: "s1",
    sessionId: "sid",
    role: "user",
    messageText: text,
    recordedAt: "2026-10-03T10:00:00.000Z",
    timestamp: 1,
  };
}

describe("L0 FTS rowid alignment", () => {
  let dir: string;
  let file: string;
  let store: VectorStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-l0-fts-"));
    file = path.join(dir, "vectors.db");
    store = new VectorStore(file, DIMS);
    store.init({ provider: "openai", model: "m" });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function raw<T>(sql: string, ...p: string[]): T[] {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all(...p) as T[];
    } finally {
      db.close();
    }
  }

  it("new rows share the metadata rowid", () => {
    expect(store.upsertL0(rec("a", "alpha"), undefined)).toBe(true);
    expect(store.upsertL0(rec("b", "bravo"), undefined)).toBe(true);
    const meta = raw<{ record_id: string; rid: number }>("SELECT record_id, rowid AS rid FROM l0_conversations ORDER BY rid");
    const fts = raw<{ record_id: string; rid: number }>("SELECT record_id, rowid AS rid FROM l0_fts ORDER BY rid");
    expect(fts).toEqual(meta);
  });

  it("an update replaces the FTS row (one row, new text)", () => {
    store.upsertL0(rec("a", "alpha"), undefined);
    store.upsertL0(rec("a", "alpha revised"), undefined);
    const rows = raw<{ original: string }>("SELECT message_text_original AS original FROM l0_fts WHERE record_id = 'a'");
    expect(rows).toEqual([{ original: "alpha revised" }]);
  });

  it("deleteL0 removes metadata and FTS row", () => {
    store.upsertL0(rec("a", "alpha"), undefined);
    store.upsertL0(rec("b", "bravo"), undefined);
    expect(store.deleteL0("a")).toBe(true);
    expect(raw("SELECT 1 FROM l0_fts WHERE record_id = 'a'")).toHaveLength(0);
    expect(raw("SELECT 1 FROM l0_fts WHERE record_id = 'b'")).toHaveLength(1);
  });

  it("legacy rows (FTS rowid unrelated to metadata rowid) are still replaced, not duplicated", () => {
    // Legacy layout: FTS row first at rowid 1000, metadata row with a different rowid.
    const db = new DatabaseSync(file, { allowExtension: false });
    db.prepare("INSERT INTO l0_conversations (record_id, session_key, session_id, role, message_text, recorded_at, timestamp) VALUES ('old','s1','sid','user','legacy text','2026-01-01T00:00:00Z',1)").run();
    db.prepare("INSERT INTO l0_fts (rowid, message_text, message_text_original, record_id, session_key, session_id, role, recorded_at, timestamp) VALUES (1000,'legacy text','legacy text','old','s1','sid','user','2026-01-01T00:00:00Z',1)").run();
    db.close();
    expect(store.upsertL0(rec("old", "legacy text v2"), undefined)).toBe(true);
    const rows = raw<{ original: string }>("SELECT message_text_original AS original FROM l0_fts WHERE record_id = 'old'");
    expect(rows).toEqual([{ original: "legacy text v2" }]);
  });

  it("does not collide with a legacy FTS row that occupies the metadata rowid", () => {
    const db = new DatabaseSync(file, { allowExtension: false });
    // FTS row of ANOTHER record parked at rowid 1 (the rowid the next metadata row will get).
    db.prepare("INSERT INTO l0_fts (rowid, message_text, message_text_original, record_id, session_key, session_id, role, recorded_at, timestamp) VALUES (1,'x','x','other','s1','sid','user','2026-01-01T00:00:00Z',1)").run();
    db.close();
    expect(store.upsertL0(rec("fresh", "fresh text"), undefined)).toBe(true);
    expect(raw("SELECT 1 FROM l0_fts WHERE record_id = 'fresh'")).toHaveLength(1);
    expect(raw("SELECT 1 FROM l0_fts WHERE record_id = 'other'")).toHaveLength(1);
  });
});
