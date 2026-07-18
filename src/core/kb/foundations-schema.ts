/**
 * Sinapsys Foundations schema — the structural layer the upper floors
 * (Phases A–E + the 3 sellable angles) build on. See docs/SINAPSYS_FOUNDATIONS.md.
 *
 * ADDITIVE & BEST-EFFORT, exactly like VectorStore.initKbSchema():
 *   - every CREATE TABLE uses IF NOT EXISTS
 *   - the ONLY change to an existing table is one additive column
 *     (relations.weight), guarded so re-running is idempotent
 *   - the live KB (entities/facts/events/relations) keeps working untouched
 *   - any failure is logged and returns false; it NEVER throws (memory must
 *     never break on the critical path)
 *
 * Why a separate "living" layer (memory_lifecycle) instead of columns on
 * facts/events: `events` is APPEND-ONLY and `facts` is NO-DELETE (supersession
 * only). The mutable lifecycle state (permanence, decay, tier) must live in its
 * own table so those invariants stay intact. The consolidation engine writes
 * HERE, never on the source rows.
 *
 * Note: DDL is issued via prepare(sql).run() (one statement each) rather than a
 * single multi-statement call — keeps each statement explicit and reviewable.
 */

import type { DatabaseSync } from "node:sqlite";
import { WILLINGNESS_DEFAULT } from "./stance-track-record.js";

/** Minimal logger shape (decoupled from the host logger type). */
export interface FoundationsLogger {
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

const TAG = "[memory-tdai][foundations]";

/** Whether `table` already has a column named `column` (idempotent ALTER guard). */
function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/** Whether `table` exists (the weight ALTER must skip cleanly if relations is absent). */
function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
  return row != null;
}

/**
 * Create the five foundation bricks. Returns true on success, false (logged) on
 * any failure — caller treats a false as "foundations unavailable" without
 * aborting the base KB.
 */
export function initFoundationsSchema(db: DatabaseSync, logger?: FoundationsLogger): boolean {
  // Run one DDL statement (no parameters, no user input — these are static
  // schema strings) and discard the result handle.
  const ddl = (sql: string): void => {
    db.prepare(sql).run();
  };

  try {
    // ── Brick 1 — memory_lifecycle ─────────────────────────────────────────
    // The "living" layer over each memory unit (fact/event/lesson). One row per
    // (owner_id, owner_kind). The consolidation engine (Phase A) owns writes here.
    ddl(`
      CREATE TABLE IF NOT EXISTS memory_lifecycle (
        owner_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        permanence_score REAL NOT NULL DEFAULT 0,
        salience REAL NOT NULL DEFAULT 0,
        reinforcement_count INTEGER NOT NULL DEFAULT 0,
        last_reinforced_at TEXT,
        tier TEXT NOT NULL DEFAULT 'short',
        state TEXT NOT NULL DEFAULT 'active',
        retention_class TEXT NOT NULL DEFAULT 'default',
        function_importance REAL NOT NULL DEFAULT 0.5,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        decay_at TEXT,
        namespace TEXT NOT NULL DEFAULT 'default',
        created_time TEXT NOT NULL,
        updated_time TEXT NOT NULL,
        PRIMARY KEY (owner_id, owner_kind)
      )
    `);
    ddl("CREATE INDEX IF NOT EXISTS idx_life_tier_state ON memory_lifecycle(namespace, tier, state)");
    ddl("CREATE INDEX IF NOT EXISTS idx_life_decay ON memory_lifecycle(decay_at)");
    // Grounded Trust (Phase 3): getPendingAsks runs each recall turn. Without an
    // index this json_extract filter full-scans memory_lifecycle every turn (0
    // pending = scan to end), slowing recall. Expression index → O(log n + matches);
    // pending rows are rare (conservative gate), so the lookup is tiny.
    ddl(
      "CREATE INDEX IF NOT EXISTS idx_life_gate_state ON memory_lifecycle(json_extract(provenance_json, '$.gate_state'))",
    );

    // ── Brick 2 — lessons (Mistake Notebook, Phase B) ──────────────────────
    // Distilled procedural strategies from successes AND failures. Versioned for
    // "accept-if-improves": a better lesson supersedes the prior version.
    ddl(`
      CREATE TABLE IF NOT EXISTS lessons (
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
      )
    `);
    ddl("CREATE INDEX IF NOT EXISTS idx_lessons_domain ON lessons(namespace, domain, superseded_by)");

    // ── Brick 3 — memory_audit (self-evolution WITHOUT corruption) ─────────
    // Append-only trail of every automatic mutation. This is the audit log
    // A-MEM lacks (sellable angle #1).
    ddl(`
      CREATE TABLE IF NOT EXISTS memory_audit (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        operation TEXT NOT NULL,
        actor TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        reason TEXT,
        namespace TEXT NOT NULL DEFAULT 'default'
      )
    `);
    ddl("CREATE INDEX IF NOT EXISTS idx_audit_owner ON memory_audit(owner_id, owner_kind, ts)");
    ddl("CREATE INDEX IF NOT EXISTS idx_audit_ts ON memory_audit(ts)");

    // ── Brick 4 — context_fingerprints (proactive injection, Phase C) ──────
    // The situation signature (files/errors/task) used to inject memories
    // without an explicit query (sellable angle #3).
    ddl(`
      CREATE TABLE IF NOT EXISTS context_fingerprints (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        ts TEXT NOT NULL,
        files_json TEXT NOT NULL DEFAULT '[]',
        error_signatures_json TEXT NOT NULL DEFAULT '[]',
        task_type TEXT NOT NULL DEFAULT '',
        tool_sequence_json TEXT NOT NULL DEFAULT '[]',
        matched_owner_ids_json TEXT NOT NULL DEFAULT '[]',
        namespace TEXT NOT NULL DEFAULT 'default'
      )
    `);
    ddl("CREATE INDEX IF NOT EXISTS idx_fp_session ON context_fingerprints(session_key, ts)");
    ddl("CREATE INDEX IF NOT EXISTS idx_fp_task ON context_fingerprints(task_type)");

    // ── Brick 5 — relations.weight (spreading activation, Phase D) ─────────
    // The ONLY change to an existing table. Skipped cleanly if relations is
    // absent (the 4 new tables don't depend on it); guarded so re-running is a
    // no-op when the column already exists.
    if (tableExists(db, "relations") && !columnExists(db, "relations", "weight")) {
      ddl("ALTER TABLE relations ADD COLUMN weight REAL NOT NULL DEFAULT 1.0");
    }

    // ── Brick 6 — lessons reinforcement (B3) ───────────────────────────────
    // A lesson's confidence grows on successful AVOIDANCE, not only on recurrence
    // (the step beyond MNL). exposure_count = times the lesson resurfaced into a
    // matching situation; avoidance_count = times it was credited as avoided (drives
    // the explicit→implicit phase switch); last_exposed_session_id/at scope the
    // implicit "exposed-and-not-relapsed-this-session" inference. Additive + guarded.
    if (tableExists(db, "lessons")) {
      if (!columnExists(db, "lessons", "exposure_count")) {
        ddl("ALTER TABLE lessons ADD COLUMN exposure_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!columnExists(db, "lessons", "avoidance_count")) {
        ddl("ALTER TABLE lessons ADD COLUMN avoidance_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!columnExists(db, "lessons", "last_exposed_session_id")) {
        ddl("ALTER TABLE lessons ADD COLUMN last_exposed_session_id TEXT");
      }
      if (!columnExists(db, "lessons", "last_exposed_at")) {
        ddl("ALTER TABLE lessons ADD COLUMN last_exposed_at TEXT");
      }
    }

    // ── Brick 7 — stance track record (Pilastro B) ─────────────────────────
    // Distinct from B3 (which tracks whether the FAILURE recurred). This tracks
    // whether the STANCE itself was right to fire an interrupt: when a hard
    // interrupt fires and Lorenzo CONFIRMS it mattered → willingness rises; when
    // he REJECTS it as a false alarm → willingness falls, and a stance that
    // repeatedly cries wolf suppresses itself. stance_willingness drives
    // classifyStanceSeverity's suppress/demote/trusted tiers. Legacy rows default
    // to WILLINGNESS_DEFAULT (trusted) → no behaviour change until signals arrive.
    // Additive + guarded, exactly like Brick 6.
    if (tableExists(db, "lessons")) {
      if (!columnExists(db, "lessons", "stance_fire_count")) {
        ddl("ALTER TABLE lessons ADD COLUMN stance_fire_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!columnExists(db, "lessons", "stance_confirmed_count")) {
        ddl("ALTER TABLE lessons ADD COLUMN stance_confirmed_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!columnExists(db, "lessons", "stance_rejected_count")) {
        ddl("ALTER TABLE lessons ADD COLUMN stance_rejected_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!columnExists(db, "lessons", "stance_willingness")) {
        ddl(
          `ALTER TABLE lessons ADD COLUMN stance_willingness REAL NOT NULL DEFAULT ${WILLINGNESS_DEFAULT}`,
        );
      }
    }

    // ── Brick 8 — contradiction flag (L4 v1 Consolidation Engine) ──────────
    // Two ACTIVE (HEAD) facts about the SAME (entity_id, attribute) with
    // DIFFERENT values should never coexist under normal writes — upsertFact's
    // supersession algorithm collapses them into one HEAD. This column is the
    // safety net for whatever bypasses that invariant (migration, manual
    // insert, race). NEVER used to delete/mutate a fact — the consolidation
    // engine only ever marks/clears this JSON flag. NULL = no known conflict.
    // Additive + guarded, exactly like Brick 6/7.
    if (tableExists(db, "memory_lifecycle") && !columnExists(db, "memory_lifecycle", "contradiction_json")) {
      ddl("ALTER TABLE memory_lifecycle ADD COLUMN contradiction_json TEXT");
    }

    logger?.debug?.(`${TAG} foundations schema ready`);
    return true;
  } catch (err) {
    logger?.warn?.(
      `${TAG} foundations schema NOT available: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
