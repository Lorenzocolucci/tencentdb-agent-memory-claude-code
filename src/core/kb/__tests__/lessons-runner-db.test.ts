/**
 * loadFixTexts unit tests — mirrors REAL KB data shape.
 *
 * Verified on live KB (2026-06-24):
 *   - 20/20 caused/fixed-by relation endpoints are ent_* entity ids.
 *   - 0/11 bug event ids (evt_*) appear as relation endpoints.
 *
 * The old implementation queried relations WHERE src/dst IN (bugEventIds)
 * using EVENT ids — matched nothing on real data → always returned [].
 * These tests lock in the correct entity-chain behaviour.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { loadEntityMap, loadFixTexts } from "../lessons-runner-db.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => DatabaseSync;
};

// ── Schema helpers ────────────────────────────────────────────────────────────

function createSchema(db: DatabaseSync): void {
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

/**
 * Insert a bug event whose entities_json lists ENTITY ids (ent_*), not event ids.
 * This mirrors real KB data shape.
 */
function insBugEvent(
  db: DatabaseSync,
  id: string,
  entityIds: string[],
  text = `bug text for ${id}`,
): void {
  db.prepare(
    `INSERT INTO events (id, ts, recorded_at, session_key, type, text, entities_json)
     VALUES (?, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 'sA', 'bug', ?, ?)`,
  ).run(id, text, JSON.stringify(entityIds));
}

/** Insert a fix/resolution event whose entities_json lists the fix entity id. */
function insFixEvent(
  db: DatabaseSync,
  id: string,
  entityIds: string[],
  text: string,
): void {
  db.prepare(
    `INSERT INTO events (id, ts, recorded_at, session_key, type, text, entities_json)
     VALUES (?, '2026-06-01T01:00:00Z', '2026-06-01T01:00:00Z', 'sB', 'fix', ?, ?)`,
  ).run(id, text, JSON.stringify(entityIds));
}

/** Insert a relation with ent_* endpoints (real KB shape). */
function insRelation(
  db: DatabaseSync,
  id: string,
  srcEntityId: string,
  type: string,
  dstEntityId: string,
): void {
  db.prepare(
    `INSERT INTO relations (id, src_entity_id, type, dst_entity_id, created_time)
     VALUES (?, ?, ?, ?, '2026-06-01T00:00:00Z')`,
  ).run(id, srcEntityId, type, dstEntityId);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadFixTexts — entity-chain traversal (real KB shape)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DB(":memory:");
    createSchema(db);
  });

  /**
   * T1 — REAL SHAPE: ent_* endpoints on both sides.
   *
   * Data:
   *   bug event "evt_bug1" → entities_json: ["ent_auth_module"]
   *   fix event "evt_fix1" → entities_json: ["ent_auth_fix"]
   *   relation: ent_auth_module --fixed-by--> ent_auth_fix
   *
   * Expected chain:
   *   evt_bug1.entities → [ent_auth_module]
   *   relation (ent_auth_module fixed-by ent_auth_fix) → other side = ent_auth_fix
   *   events with ent_auth_fix in entities_json → [evt_fix1]
   *   return [evt_fix1.text]
   */
  it("T1: returns fix event text via entity chain (ent_* endpoints on relations)", () => {
    insBugEvent(db, "evt_bug1", ["ent_auth_module"], "Auth module crashes on nil token");
    insFixEvent(db, "evt_fix1", ["ent_auth_fix"], "Added nil guard before token validation");
    insRelation(db, "rel1", "ent_auth_module", "fixed-by", "ent_auth_fix");

    const entityMap = loadEntityMap(db, ["evt_bug1"]);
    const texts = loadFixTexts(db, ["evt_bug1"], entityMap);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("Added nil guard before token validation");
  });

  /**
   * T2 — CAUSED relation (reverse direction).
   *
   * Data:
   *   bug event "evt_bug2" → entities_json: ["ent_payment"]
   *   fix event "evt_fix2" → entities_json: ["ent_rate_limiter"]
   *   relation: ent_payment --caused--> ent_rate_limiter  (the fix/effect entity)
   *
   * Expected: fix text reached from the dst side of 'caused'.
   */
  it("T2: returns fix text via caused relation (dst side = fix entity)", () => {
    insBugEvent(db, "evt_bug2", ["ent_payment"], "Payment service overloads rate limiter");
    insFixEvent(db, "evt_fix2", ["ent_rate_limiter"], "Throttle payment calls per second");
    insRelation(db, "rel2", "ent_payment", "caused", "ent_rate_limiter");

    const entityMap = loadEntityMap(db, ["evt_bug2"]);
    const texts = loadFixTexts(db, ["evt_bug2"], entityMap);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("Throttle payment calls per second");
  });

  /**
   * T3 — REVERSE caused: fix entity --caused--> bug entity.
   *
   * Data:
   *   bug event "evt_bug3" → entities_json: ["ent_serializer"]
   *   fix event "evt_fix3" → entities_json: ["ent_validator"]
   *   relation: ent_validator --caused--> ent_serializer  (reverse: fix entity → bug entity)
   *
   * Expected: fix text reached from the src side of 'caused' (the other endpoint).
   */
  it("T3: returns fix text via reverse caused relation (src side = fix entity)", () => {
    insBugEvent(db, "evt_bug3", ["ent_serializer"], "Serializer crashes on null input");
    insFixEvent(db, "evt_fix3", ["ent_validator"], "Validate before passing to serializer");
    insRelation(db, "rel3", "ent_validator", "caused", "ent_serializer");

    const entityMap = loadEntityMap(db, ["evt_bug3"]);
    const texts = loadFixTexts(db, ["evt_bug3"], entityMap);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("Validate before passing to serializer");
  });

  /**
   * T4 — MULTIPLE bug events in a cluster, one has a fix.
   *
   * Two bug events share the same bug entity. One fix entity linked via fixed-by.
   */
  it("T4: handles cluster with multiple bug events — finds fix through any of their entities", () => {
    insBugEvent(db, "evt_bug4a", ["ent_circuit"], "Circuit trips on 404");
    insBugEvent(db, "evt_bug4b", ["ent_circuit"], "Circuit trips on 404 again");
    insFixEvent(db, "evt_fix4", ["ent_status_filter"], "Added statusCodeFilter for 404");
    insRelation(db, "rel4", "ent_circuit", "fixed-by", "ent_status_filter");

    const entityMap = loadEntityMap(db, ["evt_bug4a", "evt_bug4b"]);
    const texts = loadFixTexts(db, ["evt_bug4a", "evt_bug4b"], entityMap);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("Added statusCodeFilter for 404");
  });

  /**
   * T5 — CIRCULARITY GUARD: fix entity happens to also be a bug event entity.
   *
   * The fix event ids are excluded from results to avoid returning bug events as fixes.
   */
  it("T5: excludes bug event texts from fix results (circularity guard)", () => {
    insBugEvent(db, "evt_bug5", ["ent_alpha"], "Alpha failure");
    // The fix event references ent_beta, but ent_beta also appears in another bug event
    insBugEvent(db, "evt_bug5b", ["ent_beta"], "Beta failure — this is also a bug");
    insFixEvent(db, "evt_fix5", ["ent_fix5"], "Real fix for alpha");
    insRelation(db, "rel5", "ent_alpha", "fixed-by", "ent_fix5");

    const entityMap = loadEntityMap(db, ["evt_bug5", "evt_bug5b"]);
    const texts = loadFixTexts(db, ["evt_bug5", "evt_bug5b"], entityMap);

    // Only the real fix, not the other bug text
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("Real fix for alpha");
    expect(texts).not.toContain("Beta failure — this is also a bug");
  });

  /**
   * T6 — DEDUPLICATION: same fix text reached through multiple paths.
   */
  it("T6: deduplicates fix texts when reached through multiple entity paths", () => {
    insBugEvent(db, "evt_bug6a", ["ent_comp_a"], "Component A failure");
    insBugEvent(db, "evt_bug6b", ["ent_comp_b"], "Component B failure");
    insFixEvent(db, "evt_fix6", ["ent_shared_fix"], "Shared fix for both components");
    insRelation(db, "rel6a", "ent_comp_a", "fixed-by", "ent_shared_fix");
    insRelation(db, "rel6b", "ent_comp_b", "fixed-by", "ent_shared_fix");

    const entityMap = loadEntityMap(db, ["evt_bug6a", "evt_bug6b"]);
    const texts = loadFixTexts(db, ["evt_bug6a", "evt_bug6b"], entityMap);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("Shared fix for both components");
  });

  /**
   * T7 — NO RELATIONS: returns [] when no fixed-by/caused relations exist.
   */
  it("T7: returns [] when no relations link bug entities to fix entities", () => {
    insBugEvent(db, "evt_bug7", ["ent_orphan"], "Orphan bug with no fix");

    const entityMap = loadEntityMap(db, ["evt_bug7"]);
    const texts = loadFixTexts(db, ["evt_bug7"], entityMap);

    expect(texts).toEqual([]);
  });

  /**
   * T8 — REGRESSION GUARD: old wrong shape (event ids as relation endpoints) yields [].
   *
   * This test verifies that IF someone seeds relations with evt_* ids as endpoints
   * (the OLD buggy pattern), loadFixTexts correctly returns [] — because no events
   * have those evt_* ids in their entities_json.
   *
   * This guards against circular tests that mirror the implementation bug.
   */
  it("T8: returns [] when relation endpoints are event ids (old wrong shape — regression guard)", () => {
    insBugEvent(db, "evt_bugR", ["ent_real_entity"], "Bug with real entity");
    insFixEvent(db, "evt_fixR", ["ent_real_fix"], "Real fix text");
    // WRONG shape: using EVENT ids as relation endpoints (mirrors old buggy code)
    insRelation(db, "relR", "evt_bugR", "fixed-by", "evt_fixR");

    const entityMap = loadEntityMap(db, ["evt_bugR"]);
    const texts = loadFixTexts(db, ["evt_bugR"], entityMap);

    // ent_real_entity is in the entity map, but no relation has ent_real_entity as endpoint
    // → fix entity chain yields nothing → []
    expect(texts).toEqual([]);
  });

  /**
   * T9 — EMPTY INPUT: always returns [].
   */
  it("T9: returns [] for empty bugEventIds", () => {
    const entityMap = new Map<string, string[]>();
    const texts = loadFixTexts(db, [], entityMap);
    expect(texts).toEqual([]);
  });
});
