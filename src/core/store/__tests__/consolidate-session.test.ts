/**
 * Phase A — live wiring: VectorStore.consolidateSession integration.
 *
 * Proves the live seam end-to-end on a REAL throwaway VectorStore (never the
 * live vectors.db): a session's events + derived facts gain a lifecycle row
 * with reinforcement_count=1 after one pass. runConsolidation's internal logic
 * is unit-tested separately; this test pins that the store wrapper reaches the
 * real KB tables in the shared DB.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { getLifecycle } from "../../kb/lifecycle-writer.js";
import { _resetUlidStateForTest } from "../../kb/kb-queries.js";

const DIMS = 4;
const NOW = "2026-06-24T01:00:00.000Z";

describe("VectorStore.consolidateSession", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-consolidate-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isKbReady()).toBe(true);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reinforces the session's events and derived facts (real KB tables)", () => {
    const evt = store.insertEvent({ sessionKey: "sessA", ts: NOW, type: "fix", text: "fixed the bug" });
    const ent = store.resolveOrCreateEntity!({ type: "concept", name: "gateway", now: NOW });
    const fact = store.upsertFact!({
      entityId: ent.id,
      attribute: "status",
      value: "repaired",
      sourceEventId: evt.id,
      now: NOW,
    });

    const stats = store.consolidateSession!({ sessionKey: "sessA", now: NOW });

    expect(stats.eventsReinforced).toBe(1);
    expect(stats.factsReinforced).toBe(1);
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(getLifecycle(db, evt.id, "event")?.reinforcement_count).toBe(1);
    expect(getLifecycle(db, fact.id, "fact")?.reinforcement_count).toBe(1);
  });

  it("returns zeroed stats for a session with no events", () => {
    const stats = store.consolidateSession!({ sessionKey: "ghost", now: NOW });
    expect(stats).toEqual({
      eventsReinforced: 0,
      factsReinforced: 0,
      staled: 0,
      contradictionsFlagged: 0,
      contradictionsCleared: 0,
    });
  });
});
