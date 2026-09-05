/**
 * A dead model must never be reported as "no new lessons" (2026-09-05).
 *
 * Live: 5 distillation calls threw on `moonshot-v1-auto`; the gateway printed
 * "no new lessons (candidates=1)", "no new principles (candidates=26)",
 * "no new usage tendencies (candidates=6, rejected=2)" — all at debug level.
 * This pins: when a step's stats say the LLM threw, TdaiCore logs ONE `error`
 * line naming the count, the taskId and the message; and the "no new" line
 * prints the skipped counters instead of hiding them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiCore, logDistillationLlmFailures } from "../tdai-core.js";
import { parseConfig } from "../../config.js";
import type { HostAdapter, Logger, LLMRunnerFactory, RuntimeContext } from "../types.js";

const DEAD = "Not found the model moonshot-v1-auto or Permission denied";

function spyLogger(): Logger & { error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeAdapter(dataDir: string, logger: Logger): HostAdapter {
  const ctx: RuntimeContext = {
    userId: "default_user", sessionId: "sid", sessionKey: "s1", platform: "gateway", workspaceDir: dataDir, dataDir,
  };
  const runnerFactory: LLMRunnerFactory = {
    createRunner: () => ({ run: async () => { throw new Error(DEAD); } }),
  };
  return { hostType: "standalone", getRuntimeContext: () => ctx, getLogger: () => logger, getLLMRunnerFactory: () => runnerFactory };
}

interface Internals {
  bgTasks: Set<Promise<void>>;
  storeReady?: Promise<void>;
  scheduleBackgroundDistillation: () => void;
}
const internals = (core: TdaiCore): Internals => core as unknown as Internals;

describe("logDistillationLlmFailures", () => {
  it("is silent when nothing threw", () => {
    const logger = spyLogger();
    logDistillationLlmFailures(logger, "lessons", "lesson-distill", { candidates: 3, skippedLlmFailed: 0, llmErrors: [] });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("prints ONE error line: 'distillation LLM failed <n>/<m> clusters (<taskId>): <message>'", () => {
    const logger = spyLogger();
    logDistillationLlmFailures(logger, "usage", "usage-distill", { candidates: 6, skippedLlmFailed: 2, llmErrors: [DEAD] });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = String(logger.error.mock.calls[0]![0]);
    expect(line).toContain("[usage] distillation LLM failed 2/6 clusters (usage-distill): " + DEAD);
  });
});

describe("TdaiCore distillation steps", () => {
  let dir: string;
  let core: TdaiCore;
  let logger: ReturnType<typeof spyLogger>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-honesty-"));
    logger = spyLogger();
    const cfg = parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } });
    core = new TdaiCore({ hostAdapter: makeAdapter(dir, logger), config: cfg });
    await core.initialize();
    await internals(core).storeReady;
  });

  afterEach(async () => {
    await core.destroy().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a step whose LLM threw is logged at error level with taskId, not as 'no new lessons'", async () => {
    const store = core.getVectorStore()! as unknown as Record<string, unknown>;
    store.runLessonDistillation = async () => ({
      candidates: 1, inserted: 0, superseded: 0, skippedDuplicate: 0,
      skippedUndistillable: 0, skippedLlmFailed: 1, llmErrors: [DEAD],
    });
    store.runUsageDistillation = async () => ({
      candidates: 6, confirmed: 0, inserted: 0, skippedDuplicate: 0, skippedRejected: 2,
      skippedLlmFailed: 2, llmErrors: [DEAD],
    });

    internals(core).scheduleBackgroundDistillation();
    await Promise.all([...internals(core).bgTasks]);

    const errors = logger.error.mock.calls.map((c) => String(c[0]));
    expect(errors.some((l) => l.includes("[lessons] distillation LLM failed 1/1 clusters (lesson-distill): " + DEAD))).toBe(true);
    expect(errors.some((l) => l.includes("[usage] distillation LLM failed 2/6 clusters (usage-distill): " + DEAD))).toBe(true);

    // The "no new" lines now carry the skipped counters.
    const debugs = logger.debug.mock.calls.map((c) => String(c[0]));
    expect(debugs.some((l) => l.includes("[lessons] no new lessons") && l.includes("skippedLlmFailed=1"))).toBe(true);
    expect(debugs.some((l) => l.includes("[usage] no new usage tendencies") && l.includes("skippedLlmFailed=2"))).toBe(true);
  });

  it("with no failures no error line is emitted (the happy path stays quiet)", async () => {
    const store = core.getVectorStore()! as unknown as Record<string, unknown>;
    store.runLessonDistillation = async () => ({
      candidates: 0, inserted: 0, superseded: 0, skippedDuplicate: 0,
      skippedUndistillable: 0, skippedLlmFailed: 0, llmErrors: [],
    });
    store.runUsageDistillation = async () => ({
      candidates: 0, confirmed: 0, inserted: 0, skippedDuplicate: 0, skippedRejected: 0, skippedLlmFailed: 0, llmErrors: [],
    });
    internals(core).scheduleBackgroundDistillation();
    await Promise.all([...internals(core).bgTasks]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
