/**
 * Live 05/10/2026: with the 400-event window the Mistake Notebook found "0 candidates"
 * for a week — 1,095 of 1,495 bug events were never examined, and 8 recurring-failure
 * clusters (e.g. Sofia appointments mismatch, 14 episodes in 2 sessions) sat outside
 * it. In the worker process the full corpus fits in the WORKER budget.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { selectFailureClusters } from "../bug-clusters.js";
import { fakeEmbeddingReader } from "../bug-embeddings.js";
import { MAX_PAIRWISE_BUG_EVENTS, WORKER_MAX_PAIRWISE_BUG_EVENTS } from "../bug-working-set.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };

const DIMS = 512;
const basis = (i: number): Float32Array => { const v = new Float32Array(DIMS); v[i] = 1; return v; };

function corpus(): { db: DatabaseSync; vectors: Map<string, Float32Array> } {
  const db = new DB(":memory:");
  db.prepare(
    `CREATE TABLE events (id TEXT PRIMARY KEY, ts TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
       session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', namespace TEXT NOT NULL DEFAULT 'default',
       project TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, text TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'und',
       entities_json TEXT NOT NULL DEFAULT '[]', source_message_ids_json TEXT NOT NULL DEFAULT '[]')`,
  ).run();
  db.prepare(
    `CREATE TABLE relations (id TEXT PRIMARY KEY, src_entity_id TEXT NOT NULL, type TEXT NOT NULL,
       dst_entity_id TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT 'default', valid_from TEXT, valid_to TEXT,
       support INTEGER NOT NULL DEFAULT 1, source_event_id TEXT, created_time TEXT NOT NULL DEFAULT '')`,
  ).run();
  const vectors = new Map<string, Float32Array>();
  const ins = (id: string, session: string, v: Float32Array) => {
    db.prepare("INSERT INTO events (id, ts, recorded_at, session_key, type, text) VALUES (?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', ?, 'bug', ?)")
      .run(id, session, `bug ${id}`);
    vectors.set(id, v);
  };
  // An OLD recurring failure: two similar bugs in two sessions (ids sort first).
  ins("a-old-1", "s-old-1", basis(0));
  ins("a-old-2", "s-old-2", basis(0));
  // 450 newer one-off failures, all different from each other.
  for (let i = 1; i <= 450; i++) ins(`b-new-${String(i).padStart(4, "0")}`, `s-new-${i}`, basis(i));
  return { db, vectors };
}

describe("failure clustering budget in the worker", () => {
  it("the 400 window never sees the old recurring failure; the worker budget does", () => {
    const { db, vectors } = corpus();
    const reader = fakeEmbeddingReader(vectors);
    const ids = (cap: number) => selectFailureClusters(db, { embeddingReader: reader, maxPairwise: cap }).map((c) => c.bugEventIds);
    expect(ids(MAX_PAIRWISE_BUG_EVENTS)).toEqual([]);
    expect(ids(WORKER_MAX_PAIRWISE_BUG_EVENTS)).toEqual([["a-old-1", "a-old-2"]]);
  });
});
