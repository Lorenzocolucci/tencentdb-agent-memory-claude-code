/**
 * Sinapsys foundations-schema tests.
 *
 * All tests run on a THROWAWAY in-memory DB (never the live vectors.db). They
 * pin the invariants that make the foundations safe to ship:
 *   - all five bricks are created
 *   - the ONLY existing-table change is relations.weight (additive)
 *   - re-running is idempotent (no throw, no duplicate column)
 *   - pre-existing relations rows survive the ALTER, weight defaults to 1.0
 *   - memory_lifecycle composite PK (owner_id, owner_kind) holds
 *   - a DB WITHOUT a relations table still gets the 4 new tables (best-effort)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };

/** Minimal stand-in for the live `relations` table (pre-foundations shape). */
function seedRelations(db: DatabaseSync): void {
  db.prepare(`
    CREATE TABLE relations (
      id TEXT PRIMARY KEY,
      src_entity_id TEXT NOT NULL,
      type TEXT NOT NULL,
      dst_entity_id TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'default',
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      support INTEGER NOT NULL DEFAULT 1,
      source_event_id TEXT,
      created_time TEXT NOT NULL,
      UNIQUE(namespace, src_entity_id, type, dst_entity_id)
    )
  `).run();
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name);
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

describe("initFoundationsSchema", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DB(":memory:");
    seedRelations(db);
  });

  it("creates all four new tables and returns true", () => {
    expect(initFoundationsSchema(db)).toBe(true);
    const names = tableNames(db);
    expect(names).toEqual(
      expect.arrayContaining(["memory_lifecycle", "lessons", "memory_audit", "context_fingerprints"]),
    );
  });

  it("adds the relations.weight column (the only existing-table change)", () => {
    initFoundationsSchema(db);
    expect(columns(db, "relations")).toContain("weight");
  });

  it("preserves pre-existing relations rows; new weight defaults to 1.0", () => {
    db.prepare(
      `INSERT INTO relations (id, src_entity_id, type, dst_entity_id, valid_from, created_time)
       VALUES ('rel_1','ent_a','uses','ent_b','2024-01-01','2024-01-01')`,
    ).run();
    initFoundationsSchema(db);
    const row = db.prepare("SELECT id, weight FROM relations WHERE id='rel_1'").get() as {
      id: string;
      weight: number;
    };
    expect(row.id).toBe("rel_1");
    expect(row.weight).toBe(1.0);
  });

  it("is idempotent: running twice does not throw and does not duplicate weight", () => {
    expect(initFoundationsSchema(db)).toBe(true);
    expect(initFoundationsSchema(db)).toBe(true);
    const weightCols = columns(db, "relations").filter((c) => c === "weight");
    expect(weightCols).toHaveLength(1);
  });

  it("enforces memory_lifecycle composite PK (owner_id, owner_kind)", () => {
    initFoundationsSchema(db);
    const ins = `INSERT INTO memory_lifecycle (owner_id, owner_kind, created_time, updated_time)
                 VALUES ('fact_1','fact','2024-01-01','2024-01-01')`;
    db.prepare(ins).run();
    // Same composite key -> UNIQUE/PK violation.
    expect(() => db.prepare(ins).run()).toThrow();
    // Same id, DIFFERENT kind -> allowed (distinct row).
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_lifecycle (owner_id, owner_kind, created_time, updated_time)
           VALUES ('fact_1','event','2024-01-01','2024-01-01')`,
        )
        .run(),
    ).not.toThrow();
  });

  it("adds the four stance track-record columns to lessons (Pilastro B, additive)", () => {
    initFoundationsSchema(db);
    const cols = columns(db, "lessons");
    expect(cols).toEqual(
      expect.arrayContaining([
        "stance_fire_count",
        "stance_confirmed_count",
        "stance_rejected_count",
        "stance_willingness",
      ]),
    );
  });

  it("defaults a fresh lesson to zero counts and WILLINGNESS_DEFAULT willingness", () => {
    initFoundationsSchema(db);
    db.prepare(
      `INSERT INTO lessons (id, domain, trigger_pattern, lesson_text, created_time, updated_time)
       VALUES ('les_1','deploy','{}','always verify live','2024-01-01','2024-01-01')`,
    ).run();
    const row = db
      .prepare(
        `SELECT stance_fire_count AS f, stance_confirmed_count AS c,
                stance_rejected_count AS r, stance_willingness AS w
           FROM lessons WHERE id='les_1'`,
      )
      .get() as { f: number; c: number; r: number; w: number };
    expect(row.f).toBe(0);
    expect(row.c).toBe(0);
    expect(row.r).toBe(0);
    expect(row.w).toBeCloseTo(0.7); // WILLINGNESS_DEFAULT
  });

  it("is idempotent for the stance columns (no duplicate on re-run)", () => {
    expect(initFoundationsSchema(db)).toBe(true);
    expect(initFoundationsSchema(db)).toBe(true);
    const willingnessCols = columns(db, "lessons").filter((c) => c === "stance_willingness");
    expect(willingnessCols).toHaveLength(1);
  });

  it("still creates the 4 new tables when relations is absent (best-effort)", () => {
    const fresh = new DB(":memory:");
    // No relations table: the guarded ALTER is skipped, tables still created.
    expect(initFoundationsSchema(fresh)).toBe(true);
    expect(tableNames(fresh)).toEqual(
      expect.arrayContaining(["memory_lifecycle", "lessons", "memory_audit", "context_fingerprints"]),
    );
  });
});
