/**
 * The distillation passes must NEVER run on the caller's stack.
 *
 * THE BUG THIS PINS (measured on the live DB, 2026-08-22)
 * ------------------------------------------------------
 * `scheduleBackgroundDistillation` launched three `(async () => …)()` tasks and
 * called them "detached". They were not. An async function body runs
 * SYNCHRONOUSLY until its first `await`, and `await store.runLessonDistillation(…)`
 * must first EVALUATE that call — whose own body reaches `selectFailureClusters`,
 * a fully synchronous clustering pass that took **6.2 s** over 1.699 bug events.
 * Three of those ran back to back on the caller's stack.
 *
 * The caller is the FIRST TURN of every session (gated on bannerEmitted). So
 * /recall answered in 274 ms internally but ~11.500 ms at the socket, blowing
 * the plugin's 6 s budget: the session-open injection — banner included — was
 * silently dropped in every project.
 *
 * A timing assertion would be flaky. What is deterministic, and what actually
 * regressed, is WHEN the store methods are first touched: not in the same
 * synchronous turn as the scheduling call.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiCore } from "../tdai-core.js";
import { parseConfig } from "../../config.js";
import type { HostAdapter, Logger, LLMRunnerFactory, RuntimeContext } from "../types.js";

const SESSION = "sessDeferral";

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

interface Internals {
  bgTasks: Set<Promise<void>>;
  storeReady?: Promise<void>;
  scheduleBackgroundDistillation: () => void;
}

function internals(core: TdaiCore): Internals {
  return core as unknown as Internals;
}

describe("scheduleBackgroundDistillation runs off the caller's stack", () => {
  let dir: string;
  let core: TdaiCore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-distill-"));
    const cfg = parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } });
    core = new TdaiCore({ hostAdapter: makeAdapter(dir, silentLogger()), config: cfg });
    await core.initialize();
    await internals(core).storeReady;
  });

  afterEach(async () => {
    await core.destroy().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("touches no heavy store method in the same synchronous turn", async () => {
    const store = core.getVectorStore()! as unknown as Record<string, unknown>;
    const touched: string[] = [];

    for (const name of ["runLessonDistillation", "runUsageDistillation", "listRecentEvents"]) {
      const original = store[name];
      if (typeof original !== "function") continue;
      store[name] = (...args: unknown[]) => {
        touched.push(name);
        return (original as (...a: unknown[]) => unknown).apply(store, args);
      };
    }

    internals(core).scheduleBackgroundDistillation();

    // THE ASSERTION: scheduling must return without having entered any of them.
    // Before the fix, `selectFailureClusters` had already run to completion here.
    expect(touched).toEqual([]);

    // …and the work must still actually happen once the loop is free.
    await Promise.all([...internals(core).bgTasks]);
    expect(touched.length).toBeGreaterThan(0);
  });

  it("does not re-run within the cooldown — it used to fire on EVERY session open", async () => {
    const store = core.getVectorStore()! as unknown as Record<string, unknown>;
    let calls = 0;
    const original = store.runLessonDistillation;
    if (typeof original === "function") {
      store.runLessonDistillation = (...args: unknown[]) => {
        calls++;
        return (original as (...a: unknown[]) => unknown).apply(store, args);
      };
    }

    internals(core).scheduleBackgroundDistillation();
    await Promise.all([...internals(core).bgTasks]);
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);

    // Three more session opens in quick succession: all must be free.
    for (let i = 0; i < 3; i++) internals(core).scheduleBackgroundDistillation();
    await Promise.all([...internals(core).bgTasks]);
    expect(calls).toBe(afterFirst);
  });

  it("registers one bgTask per step so a shutdown drain awaits each", async () => {
    const before = internals(core).bgTasks.size;
    internals(core).scheduleBackgroundDistillation();
    expect(internals(core).bgTasks.size).toBeGreaterThan(before);
    await Promise.all([...internals(core).bgTasks]);
  });
});
