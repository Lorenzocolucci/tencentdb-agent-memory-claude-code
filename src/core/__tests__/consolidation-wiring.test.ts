/**
 * Phase A — live wiring integration: TdaiCore.handleSessionEnd → consolidation.
 *
 * The scheduler (policy) and the store wrapper are unit-tested elsewhere; this
 * pins the one production line the live wiring added — that handleSessionEnd
 * registers a consolidation task into bgTasks (synchronously, so a shutdown
 * drain can await it) and that the deferred sweep actually reinforces the
 * session's events on the REAL store. It also pins that destroy() drains the
 * in-flight sweep before closing the DB.
 *
 * Without this test a future refactor could drop the register/bgTasks binding —
 * reintroducing the "close the DB mid-sweep" race — with every other test still
 * green.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { TdaiCore } from "../tdai-core.js";
import { parseConfig } from "../../config.js";
import { getLifecycle } from "../kb/lifecycle-writer.js";
import type { HostAdapter, Logger, LLMRunnerFactory, RuntimeContext } from "../types.js";
import type { IMemoryStore } from "../store/types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };

const SESSION = "sessA";

function silentLogger(): Logger {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeAdapter(dataDir: string, logger: Logger): HostAdapter {
  const ctx: RuntimeContext = {
    userId: "default_user",
    sessionId: "sid",
    sessionKey: SESSION,
    platform: "gateway",
    workspaceDir: dataDir,
    dataDir,
  };
  const runnerFactory: LLMRunnerFactory = {
    createRunner: () => ({ run: async () => "" }),
  };
  return {
    hostType: "standalone",
    getRuntimeContext: () => ctx,
    getLogger: () => logger,
    getLLMRunnerFactory: () => runnerFactory,
  };
}

/** Reach the private internals the assertions need (test-only). */
function internals(core: TdaiCore): { bgTasks: Set<Promise<void>>; storeReady?: Promise<void> } {
  return core as unknown as { bgTasks: Set<Promise<void>>; storeReady?: Promise<void> };
}

function rawDb(store: IMemoryStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

describe("TdaiCore.handleSessionEnd → consolidation wiring", () => {
  let dir: string;
  let core: TdaiCore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-wiring-"));
    // extraction disabled → no scheduler, so this test isolates the
    // consolidation path; embedding "none" → offline, KB still ready.
    const cfg = parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } });
    const logger = silentLogger();
    core = new TdaiCore({ hostAdapter: makeAdapter(dir, logger), config: cfg });
    await core.initialize();
    await internals(core).storeReady; // store fully ready before we touch it
  });

  afterEach(async () => {
    await core.destroy().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers a consolidation task in bgTasks and reinforces the session's events", async () => {
    const store = core.getVectorStore()!;
    const evt = store.insertEvent!({ sessionKey: SESSION, ts: new Date().toISOString(), type: "fix", text: "t" });

    await core.handleSessionEnd(SESSION);

    // Registration is synchronous: by the time handleSessionEnd resolves the
    // task is already tracked (the sweep itself is still deferred).
    const tasks = [...internals(core).bgTasks];
    expect(tasks).toHaveLength(1);
    // Not reinforced yet — the sweep runs on a later macrotask.
    expect(getLifecycle(rawDb(store), evt.id, "event")).toBeNull();

    await tasks[0]; // let the deferred sweep run

    expect(getLifecycle(rawDb(store), evt.id, "event")?.reinforcement_count).toBe(1);
    // Task removed itself once done.
    expect(internals(core).bgTasks.size).toBe(0);
  });

  it("destroy() drains the in-flight sweep before closing the DB (write is committed)", async () => {
    const dbPath = path.join(dir, "vectors.db");
    const store = core.getVectorStore()!;
    const evt = store.insertEvent!({ sessionKey: SESSION, ts: new Date().toISOString(), type: "fix", text: "t" });

    // Fire-and-forget: do NOT await the task here — hand straight to destroy().
    await core.handleSessionEnd(SESSION);
    await core.destroy(); // must await the in-flight sweep before close()

    // Re-open the (now closed) DB file: the reinforcement must be persisted,
    // which can only be true if the sweep completed BEFORE close().
    const check = new DB(dbPath);
    try {
      const row = check
        .prepare("SELECT reinforcement_count FROM memory_lifecycle WHERE owner_id = ? AND owner_kind = 'event'")
        .get(evt.id) as { reinforcement_count: number } | undefined;
      expect(row?.reinforcement_count).toBe(1);
    } finally {
      check.close();
    }
  });

  it("is a no-op for an empty session key (nothing registered)", async () => {
    await core.handleSessionEnd("");
    expect(internals(core).bgTasks.size).toBe(0);
  });
});
