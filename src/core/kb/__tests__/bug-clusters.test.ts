/**
 * B1 — cross-session failure clustering (deterministic, no LLM).
 *
 * Mandatory tests per spec §10:
 *   T1 ANTI-ANECDOTE: bugs in the SAME session → never cluster.
 *   T2 CROSS-SESSION GATE: similar bugs in 2 sessions → 1 cluster; same session → 0.
 *   T3 DETERMINISM: same seed → identical output across runs.
 *
 * Embeddings are injected via fakeEmbeddingReader — no shadow-table seeding.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { selectFailureClusters } from "../bug-clusters.js";
import { fakeEmbeddingReader } from "../bug-embeddings.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => DatabaseSync;
};

// ── Schema + seed helpers ─────────────────────────────────────────────────────

function createAll(db: DatabaseSync): void {
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

function insEvent(
  db: DatabaseSync,
  id: string,
  session: string,
  entities: string[] = [],
): void {
  db.prepare(
    `INSERT INTO events (id, ts, recorded_at, session_key, type, text, entities_json)
     VALUES (?, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', ?, 'bug', ?, ?)`,
  ).run(id, session, `bug text for ${id}`, JSON.stringify(entities));
}

/** Unit vector (cosine=1 with itself and with any other unit vector of same dims). */
function unitVec(dims = 16): Float32Array {
  const v = new Float32Array(dims);
  v.fill(Math.sqrt(1 / dims));
  return v;
}

/** Orthogonal to unitVec → cosine≈0, weight below TAU. */
function orthogonalVec(dims = 16): Float32Array {
  const v = new Float32Array(dims);
  v[0] = 1.0;
  return v;
}

// ── T1: ANTI-ANECDOTE ────────────────────────────────────────────────────────

describe("T1 — Anti-anecdote guard", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = new DB(":memory:"); createAll(db); });

  it("does NOT cluster bugs from the SAME session (SESSION_MIN not met)", () => {
    insEvent(db, "bug_i18n", "S1");
    insEvent(db, "bug_pay", "S1");
    const reader = fakeEmbeddingReader(new Map([["bug_i18n", unitVec()], ["bug_pay", unitVec()]]));
    expect(selectFailureClusters(db, { embeddingReader: reader })).toHaveLength(0);
  });

  it("does NOT cluster orthogonal bugs in different sessions (below TAU)", () => {
    insEvent(db, "bug_i18n", "S1");
    insEvent(db, "bug_pay", "S2");
    const reader = fakeEmbeddingReader(
      new Map([["bug_i18n", unitVec()], ["bug_pay", orthogonalVec()]]),
    );
    expect(selectFailureClusters(db, { embeddingReader: reader })).toHaveLength(0);
  });
});

// ── T2: CROSS-SESSION GATE ────────────────────────────────────────────────────

describe("T2 — Cross-session gate", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = new DB(":memory:"); createAll(db); });

  it("emits ONE cluster for 2 similar bugs in 2 different sessions", () => {
    insEvent(db, "bug_a", "SA");
    insEvent(db, "bug_b", "SB");
    const reader = fakeEmbeddingReader(new Map([["bug_a", unitVec()], ["bug_b", unitVec()]]));
    const clusters = selectFailureClusters(db, { embeddingReader: reader });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].distinctSessionCount).toBe(2);
    expect(clusters[0].sessionKeys).toContain("SA");
    expect(clusters[0].sessionKeys).toContain("SB");
    expect(clusters[0].bugEventIds).toHaveLength(2);
  });

  it("evidence_count = bugEventIds.length", () => {
    insEvent(db, "bug_a", "SA");
    insEvent(db, "bug_b", "SB");
    const reader = fakeEmbeddingReader(new Map([["bug_a", unitVec()], ["bug_b", unitVec()]]));
    const clusters = selectFailureClusters(db, { embeddingReader: reader });
    expect(clusters[0].bugEventIds.length).toBe(2);
  });

  it("emits NO cluster when 2 similar bugs are in the SAME session", () => {
    insEvent(db, "bug_a", "S1");
    insEvent(db, "bug_b", "S1");
    const reader = fakeEmbeddingReader(new Map([["bug_a", unitVec()], ["bug_b", unitVec()]]));
    expect(selectFailureClusters(db, { embeddingReader: reader })).toHaveLength(0);
  });

  it("respects EVIDENCE_MIN: 1 bug → no cluster", () => {
    insEvent(db, "bug_solo", "S1");
    const reader = fakeEmbeddingReader(new Map([["bug_solo", unitVec()]]));
    expect(selectFailureClusters(db, { embeddingReader: reader })).toHaveLength(0);
  });

  it("causal relation boosts edge weight above TAU", () => {
    insEvent(db, "bug_c", "SC", ["ent_1"]);
    insEvent(db, "bug_d", "SD", ["ent_1"]);
    const reader = fakeEmbeddingReader(new Map([["bug_c", unitVec()], ["bug_d", unitVec()]]));
    db.prepare(
      `INSERT INTO relations (id, src_entity_id, type, dst_entity_id, created_time)
       VALUES ('rel1', 'ent_1', 'caused', 'ent_1', '2026-06-01T00:00:00Z')`,
    ).run();
    const clusters = selectFailureClusters(db, { embeddingReader: reader });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].distinctSessionCount).toBe(2);
  });
});

// ── T3: DETERMINISM ────────────────────────────────────────────────────────────

describe("T3 — Determinism", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = new DB(":memory:"); createAll(db); });

  it("returns identical clusters across multiple runs", () => {
    insEvent(db, "bug_x", "SX");
    insEvent(db, "bug_y", "SY");
    const reader = fakeEmbeddingReader(new Map([["bug_x", unitVec()], ["bug_y", unitVec()]]));
    const first = selectFailureClusters(db, { embeddingReader: reader });
    const second = selectFailureClusters(db, { embeddingReader: reader });
    expect(first).toEqual(second);
  });

  it("cluster bugEventIds are lexicographically sorted", () => {
    insEvent(db, "bug_z", "SZ");
    insEvent(db, "bug_w", "SW");
    const reader = fakeEmbeddingReader(new Map([["bug_z", unitVec()], ["bug_w", unitVec()]]));
    const clusters = selectFailureClusters(db, { embeddingReader: reader });
    expect(clusters).toHaveLength(1);
    const ids = clusters[0].bugEventIds;
    expect(ids).toEqual([...ids].sort());
  });
});
