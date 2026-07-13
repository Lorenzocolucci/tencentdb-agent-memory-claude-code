/**
 * Integration: rollover capture against a REAL throwaway VectorStore (never the
 * live vectors.db). Proves the "changing of the guard" round-trip end-to-end on
 * the real store shape — the check that would have caught the original no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { _resetUlidStateForTest } from "../../kb/kb-queries.js";
import { captureRolloverRecap } from "../recap-rollover.js";

const DIMS = 4;

describe("captureRolloverRecap — real store round-trip", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-rollover-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isKbReady()).toBe(true);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function recapCount(): number {
    return store.listEventsBySession!("s1").filter((e) => e.type === "session_recap").length;
  }

  it("captures the previous session and is idempotent on re-run", () => {
    // Session A (the one that just ended) — has an anchored thread.
    store.insertEvent({ sessionKey: "s1", sessionId: "A", ts: "2026-06-30T10:00:00.000Z", type: "decision", text: "chose the rollover design", sourceMessageIds: ["ma"] });
    store.insertEvent({ sessionKey: "s1", sessionId: "A", ts: "2026-06-30T10:05:00.000Z", type: "task", text: "build recap-rollover next", sourceMessageIds: ["mb"] });
    // Session B (the one just opened) — no thread events yet at recall time.
    store.insertEvent({ sessionKey: "s1", sessionId: "B", ts: "2026-07-01T09:00:00.000Z", type: "observation", text: "opened a new chat" });

    captureRolloverRecap({ store, sessionKey: "s1", currentSessionId: "B", now: "2026-07-01T09:01:00.000Z" });

    const recap = store.latestEventBySessionKeyType!("s1", "session_recap");
    expect(recap).toBeDefined();
    expect(recap!.session_id).toBe("A");
    expect(recap!.text).toContain("chose the rollover design");
    expect(recapCount()).toBe(1);

    // Re-run (next turn / next new session): must NOT duplicate.
    captureRolloverRecap({ store, sessionKey: "s1", currentSessionId: "B", now: "2026-07-01T09:02:00.000Z" });
    expect(recapCount()).toBe(1);
  });

  it("does nothing when only the current session has events", () => {
    store.insertEvent({ sessionKey: "s1", sessionId: "B", ts: "2026-07-01T09:00:00.000Z", type: "decision", text: "only current" });
    captureRolloverRecap({ store, sessionKey: "s1", currentSessionId: "B", now: "2026-07-01T09:01:00.000Z" });
    expect(recapCount()).toBe(0);
  });
});
