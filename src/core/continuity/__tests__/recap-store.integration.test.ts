/**
 * Integration: the two recap store queries against a REAL throwaway VectorStore
 * (never the live vectors.db). Harness mirrors consolidate-session.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { _resetUlidStateForTest } from "../../kb/kb-queries.js";

const DIMS = 4;

describe("recap store queries", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-recap-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isKbReady()).toBe(true);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("listEventsBySession returns only that session's events", () => {
    store.insertEvent({ sessionKey: "s1", ts: "2026-06-29T10:00:00.000Z", type: "decision", text: "a" });
    store.insertEvent({ sessionKey: "s1", ts: "2026-06-29T10:01:00.000Z", type: "task", text: "b" });
    store.insertEvent({ sessionKey: "s2", ts: "2026-06-29T10:02:00.000Z", type: "fix", text: "c" });

    const s1 = store.listEventsBySession!("s1");
    expect(s1).toHaveLength(2);
    expect(s1.every((e) => e.session_key === "s1")).toBe(true);
  });

  it("latestEventByProjectType returns the newest matching event", () => {
    store.insertEvent({ sessionKey: "s1", ts: "2026-06-29T10:00:00.000Z", project: "p", type: "session_recap", text: "old" });
    store.insertEvent({ sessionKey: "s2", ts: "2026-06-29T12:00:00.000Z", project: "p", type: "session_recap", text: "new" });
    store.insertEvent({ sessionKey: "s3", ts: "2026-06-29T13:00:00.000Z", project: "other", type: "session_recap", text: "wrongproj" });

    const latest = store.latestEventByProjectType!("p", "session_recap");
    expect(latest?.text).toBe("new");
  });

  it("latestEventByProjectType returns undefined when nothing matches", () => {
    expect(store.latestEventByProjectType!("nope", "session_recap")).toBeUndefined();
  });
});
