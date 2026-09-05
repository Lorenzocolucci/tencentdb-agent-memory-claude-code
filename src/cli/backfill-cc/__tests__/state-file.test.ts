import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyState,
  mergeState,
  loadState,
  saveState,
  distinctReplayedKeys,
  type BackfillState,
  type SessionState,
} from "../state-file.js";

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: "replayed",
    sessionKey: "key-1",
    turnsTotal: 2,
    turnsSentBefore: 0,
    turnsSentAfter: 2,
    lastError: null,
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("mergeState", () => {
  it("does not mutate the input state (immutability)", () => {
    const existing = emptyState();
    const merged = mergeState(existing, { sessions: { s1: session() } });
    expect(existing.sessions).toEqual({});
    expect(merged.sessions.s1).toBeDefined();
  });

  it("lets a new update win over an existing entry with the same key", () => {
    const existing = mergeState(emptyState(), { sessions: { s1: session({ status: "failed" }) } });
    const merged = mergeState(existing, { sessions: { s1: session({ status: "replayed" }) } });
    expect(merged.sessions.s1.status).toBe("replayed");
  });

  it("preserves untouched keys from the existing state", () => {
    const existing = mergeState(emptyState(), {
      sessions: { s1: session(), s2: session({ sessionKey: "key-2" }) },
    });
    const merged = mergeState(existing, { sessions: { s1: session({ status: "partial" }) } });
    expect(merged.sessions.s1.status).toBe("partial");
    expect(merged.sessions.s2.sessionKey).toBe("key-2");
  });

  it("merges digest updates independently of session updates", () => {
    const existing = mergeState(emptyState(), { sessions: { s1: session() } });
    const merged = mergeState(existing, {
      digest: { "key-1": { status: "done", processedCount: 4, lastError: null, updatedAt: "now" } },
    });
    expect(merged.sessions.s1).toBeDefined();
    expect(merged.digest["key-1"].processedCount).toBe(4);
  });
});

describe("distinctReplayedKeys", () => {
  it("collects unique session_keys from replayed AND partial sessions only", () => {
    const state: BackfillState = {
      version: 1,
      sessions: {
        a: session({ sessionKey: "k1", status: "replayed" }),
        b: session({ sessionKey: "k1", status: "partial" }),
        c: session({ sessionKey: "k2", status: "failed" }),
        d: session({ sessionKey: null, status: "replayed" }),
      },
      digest: {},
    };
    expect(distinctReplayedKeys(state).sort()).toEqual(["k1"]);
  });
});

describe("loadState / saveState round-trip", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "backfill-cc-state-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns an empty state when the file does not exist yet", async () => {
    const state = await loadState(join(dataDir, "backfill-cc-state.json"));
    expect(state).toEqual(emptyState());
  });

  it("round-trips through disk", async () => {
    const path = join(dataDir, "backfill-cc-state.json");
    const written = mergeState(emptyState(), { sessions: { s1: session() } });
    await saveState(path, written);
    const read = await loadState(path);
    expect(read).toEqual(written);
  });

  it("writes atomically (no leftover .tmp file after a successful save)", async () => {
    const path = join(dataDir, "backfill-cc-state.json");
    await saveState(path, emptyState());
    await expect(readFile(`${path}.tmp`, "utf-8")).rejects.toThrow();
    await expect(readFile(path, "utf-8")).resolves.toContain('"version": 1');
  });
});
