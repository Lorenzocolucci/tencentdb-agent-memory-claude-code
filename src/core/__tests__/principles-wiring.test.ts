/**
 * Per-project principles — live wiring through TdaiCore.handleBeforeRecall.
 *
 * The binding north-star injection (Track A slice 2) must now carry BOTH the
 * global working rules AND the current project's principles, selected by the
 * project name threaded from the hook (cwd basename). This pins that the project
 * file is injected, after the global, inside the binding <governing-principles>
 * block — and that omitting the project name falls back to global-only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiCore } from "../tdai-core.js";
import { parseConfig } from "../../config.js";
import type { HostAdapter, Logger, LLMRunnerFactory, RuntimeContext } from "../types.js";

function silentLogger(): Logger {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeAdapter(dataDir: string): HostAdapter {
  const ctx: RuntimeContext = {
    userId: "default_user",
    sessionId: "sid",
    sessionKey: "s1",
    platform: "gateway",
    workspaceDir: dataDir,
    dataDir,
  };
  const runnerFactory: LLMRunnerFactory = { createRunner: () => ({ run: async () => "" }) };
  return {
    hostType: "standalone",
    getRuntimeContext: () => ctx,
    getLogger: () => silentLogger(),
    getLLMRunnerFactory: () => runnerFactory,
  };
}

function internals(core: TdaiCore): { storeReady?: Promise<void> } {
  return core as unknown as { storeReady?: Promise<void> };
}

describe("per-project principles wiring (handleBeforeRecall)", () => {
  let dir: string;
  let core: TdaiCore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-principles-wire-"));
    fs.writeFileSync(path.join(dir, "principles.md"), "GLOBAL: determinismo assoluto.");
    fs.mkdirSync(path.join(dir, "principles"));
    fs.writeFileSync(path.join(dir, "principles", "sofia-ai.md"), "SOFIA: WhatsApp first, never break live.");

    const cfg = parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } });
    core = new TdaiCore({ hostAdapter: makeAdapter(dir), config: cfg });
    await core.initialize();
    await internals(core).storeReady;
  });

  afterEach(async () => {
    await core.destroy().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("injects global + project principles in the binding block for the named project", async () => {
    const result = await core.handleBeforeRecall("ciao", "s1", "Sofia-AI");
    const ctx = result.appendSystemContext ?? "";
    expect(ctx).toContain("<governing-principles>");
    expect(ctx.toUpperCase()).toContain("BINDING");
    expect(ctx).toContain("GLOBAL: determinismo assoluto.");
    expect(ctx).toContain("SOFIA: WhatsApp first, never break live.");
    // Global comes before the project's principles (more specific last).
    expect(ctx.indexOf("GLOBAL:")).toBeLessThan(ctx.indexOf("SOFIA:"));
  });

  it("falls back to global-only for an unknown project", async () => {
    const result = await core.handleBeforeRecall("ciao", "s1", "no-such-project");
    const ctx = result.appendSystemContext ?? "";
    expect(ctx).toContain("GLOBAL: determinismo assoluto.");
    expect(ctx).not.toContain("SOFIA:");
  });

  it("falls back to global-only when no project name is passed", async () => {
    const result = await core.handleBeforeRecall("ciao", "s1");
    const ctx = result.appendSystemContext ?? "";
    expect(ctx).toContain("GLOBAL: determinismo assoluto.");
    expect(ctx).not.toContain("SOFIA:");
  });
});
