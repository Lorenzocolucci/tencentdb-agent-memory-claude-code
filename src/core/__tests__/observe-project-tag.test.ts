/**
 * Live 03/10/2026: 241 of 594 events had project '' — mostly friction `bug`
 * events from sessions that never ran a recall (subagents, `claude -p`), so the
 * sessionKey → project registry was empty. The plugin already sends `project`
 * on /observe; the event must carry it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiCore } from "../tdai-core.js";
import { parseConfig } from "../../config.js";
import type { HostAdapter, Logger, LLMRunnerFactory, RuntimeContext } from "../types.js";

const silent: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function makeAdapter(dataDir: string): HostAdapter {
  const ctx: RuntimeContext = {
    userId: "default_user", sessionId: "sid", sessionKey: "s1", platform: "gateway", workspaceDir: dataDir, dataDir,
  };
  const runnerFactory: LLMRunnerFactory = { createRunner: () => ({ run: async () => "" }) };
  return { hostType: "standalone", getRuntimeContext: () => ctx, getLogger: () => silent, getLLMRunnerFactory: () => runnerFactory };
}

function projectsByType(core: TdaiCore): Array<{ type: string; project: string }> {
  const db = (core.getVectorStore() as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db;
  return db.prepare("SELECT type, project FROM events ORDER BY recorded_at").all() as Array<{ type: string; project: string }>;
}

describe("/observe events carry the project of the tool call", () => {
  let dir: string;
  let core: TdaiCore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-observe-project-"));
    const cfg = parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } });
    core = new TdaiCore({ hostAdapter: makeAdapter(dir), config: cfg });
    await core.initialize();
    await (core as unknown as { storeReady?: Promise<void> }).storeReady;
  });

  afterEach(async () => {
    await core.destroy().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a failure in a session that never recalled is tagged with the request project", async () => {
    await core.handleToolObservation({
      sessionKey: "never-recalled",
      toolName: "Bash",
      toolInput: { command: "npm run build" },
      toolOutputIsError: true,
      toolOutputText: "Exit code 2",
      project: "Tutor-Agent",
    });
    expect(projectsByType(core)).toEqual([{ type: "bug", project: "Tutor-Agent" }]);
  });

  it("a destructive success is tagged too (through the session registry)", async () => {
    await core.handleToolObservation({
      sessionKey: "never-recalled-2",
      toolName: "Bash",
      toolInput: { command: "git checkout -- src/app.ts" },
      toolOutputIsError: false,
      toolOutputText: "Updated 1 path from the index",
      toolRisk: "destructive",
      project: "Sofia-AI",
    });
    expect(projectsByType(core)).toEqual([{ type: "observation", project: "Sofia-AI" }]);
  });

  it("without a project nothing is invented (user-level '')", async () => {
    await core.handleToolObservation({
      sessionKey: "no-project",
      toolName: "Bash",
      toolInput: { command: "ls missing" },
      toolOutputIsError: true,
      toolOutputText: "No such file",
    });
    expect(projectsByType(core)).toEqual([{ type: "bug", project: "" }]);
  });
});
