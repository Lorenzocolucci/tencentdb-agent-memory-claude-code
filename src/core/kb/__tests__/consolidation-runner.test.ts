/**
 * Phase A part 2 — deterministic consolidation runner tests.
 *
 * Throwaway in-memory DB. Foundations created via initFoundationsSchema; a
 * minimal events/facts shape is seeded for the runner to read. Pins:
 *   - the session's events get reinforced (lifecycle rows created, count=1)
 *   - facts derived from those events get reinforced
 *   - events of OTHER sessions are not touched
 *   - stale active memories decay (forget the noise)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { runConsolidation } from "../consolidation-runner.js";
import { getLifecycle } from "../lifecycle-writer.js";
import { _resetUlidStateForTest } from "../kb-queries.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
const NOW = "2026-06-24T01:00:00.000Z";

function seedSourceTables(db: DatabaseSync): void {
  db.prepare("CREATE TABLE events (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, ts TEXT, type TEXT, text TEXT)").run();
  db.prepare("CREATE TABLE facts (id TEXT PRIMARY KEY, source_event_id TEXT)").run();
}

function insertEvent(db: DatabaseSync, id: string, sessionKey: string): void {
  db.prepare("INSERT INTO events (id, session_key, ts, type, text) VALUES (?, ?, ?, 'fix', 't')").run(id, sessionKey, NOW);
}

describe("runConsolidation", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    _resetUlidStateForTest();
    db = new DB(":memory:");
    initFoundationsSchema(db);
    seedSourceTables(db);
  });

  it("reinforces the session's events and derived facts; ignores other sessions", () => {
    insertEvent(db, "evt_1", "sessA");
    insertEvent(db, "evt_2", "sessA");
    insertEvent(db, "evt_other", "sessB");
    db.prepare("INSERT INTO facts (id, source_event_id) VALUES ('fact_1','evt_1')").run();

    const stats = runConsolidation(db, { sessionKey: "sessA", now: NOW });

    expect(stats.eventsReinforced).toBe(2);
    expect(stats.factsReinforced).toBe(1);
    expect(getLifecycle(db, "evt_1", "event")?.reinforcement_count).toBe(1);
    expect(getLifecycle(db, "fact_1", "fact")?.reinforcement_count).toBe(1);
    // Other session untouched (no lifecycle row created).
    expect(getLifecycle(db, "evt_other", "event")).toBeNull();
  });

  it("decays stale active memories (forget the noise)", () => {
    // A 'short' memory last reinforced long ago, low permanence.
    db.prepare(
      `INSERT INTO memory_lifecycle
         (owner_id, owner_kind, permanence_score, salience, reinforcement_count,
          last_reinforced_at, tier, state, retention_class, function_importance,
          provenance_json, namespace, created_time, updated_time)
       VALUES ('fact_old','fact', 0.1, 0, 1, '2026-05-01T00:00:00.000Z',
               'short','active','default',0.5,'{}','default',
               '2026-05-01T00:00:00.000Z','2026-05-01T00:00:00.000Z')`,
    ).run();

    const stats = runConsolidation(db, { sessionKey: "sessEmpty", now: NOW });

    expect(stats.staled).toBe(1);
    const decayed = getLifecycle(db, "fact_old", "fact");
    expect(decayed?.state).toBe("dormant"); // 0.1 * 0.5 = 0.05 < DORMANT_MIN
    // The decay is recorded in the audit trail.
    const audit = db.prepare("SELECT operation FROM memory_audit WHERE owner_id='fact_old'").get() as { operation: string };
    expect(audit.operation).toBe("decay");
  });
});
