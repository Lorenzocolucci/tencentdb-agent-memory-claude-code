/**
 * Context Fingerprint (Idea 1) — live wiring through TdaiCore.handleToolObservation.
 *
 * Proves the end-to-end magic on the REAL store: touching a file with memory
 * surfaces it AND learns a fingerprint of the moment; then, in a DIFFERENT
 * session, touching only a *neighbouring* file (one that shares the situation
 * but has no memory of its own) brings the original memory unbidden — because
 * the SITUATION resembles the past one. This is proactive injection by shape,
 * cross-session, not by query.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiCore } from "../tdai-core.js";
import { parseConfig } from "../../config.js";
import type { HostAdapter, Logger, LLMRunnerFactory, RuntimeContext } from "../types.js";

const FILE_A = "C:\\Sofia-AI\\src\\services\\circuit-breaker.ts";
const FILE_B = "C:\\Sofia-AI\\src\\services\\retry-policy.ts"; // neighbour, unknown to the KB
const NOW = "2026-06-24T10:00:00.000Z";

function silentLogger(): Logger {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeAdapter(dataDir: string, logger: Logger): HostAdapter {
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
    getLogger: () => logger,
    getLLMRunnerFactory: () => runnerFactory,
  };
}

function internals(core: TdaiCore): { storeReady?: Promise<void> } {
  return core as unknown as { storeReady?: Promise<void> };
}

describe("Context Fingerprint wiring (handleToolObservation)", () => {
  let dir: string;
  let core: TdaiCore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-fp-wiring-"));
    const cfg = parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } });
    core = new TdaiCore({ hostAdapter: makeAdapter(dir, silentLogger()), config: cfg });
    await core.initialize();
    await internals(core).storeReady;

    // Seed FILE_A with memory so single-file injection fires for it.
    const store = core.getVectorStore()!;
    const ent = store.resolveOrCreateEntity!({ type: "file", name: FILE_A, now: NOW });
    store.upsertFact!({ entityId: ent.id, attribute: "behavior", value: "retries capped at 3", now: NOW });
  });

  afterEach(async () => {
    await core.destroy().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("learns a fingerprint when memory surfaces, then surfaces it in a similar later situation", async () => {
    const store = core.getVectorStore()!;

    // ── Session 1: touch the neighbour (unknown → silent), then FILE_A (memory) ──
    const silent = await core.handleToolObservation({ sessionKey: "s1", toolName: "Read", toolInput: { file_path: FILE_B } });
    expect(silent.inject).toBeUndefined(); // FILE_B unknown → no noise

    const hit = await core.handleToolObservation({ sessionKey: "s1", toolName: "Read", toolInput: { file_path: FILE_A } });
    expect(hit.inject).toContain("file-memory");
    expect(hit.inject).toContain("retries capped at 3");

    // A fingerprint of the moment was learned: situation {FILE_B, FILE_A} → owner(FILE_A).
    const fps = store.queryContextFingerprints!("default", 10);
    expect(fps).toHaveLength(1);
    expect(fps[0].fileKeys.length).toBe(2);
    expect(fps[0].matchedOwnerIds.length).toBe(1);

    // ── Session 2: touch ONLY the neighbour (still unknown). Single-file stays
    //    silent, but the SITUATION resembles session 1 → FILE_A's memory comes. ──
    const magic = await core.handleToolObservation({ sessionKey: "s2", toolName: "Read", toolInput: { file_path: FILE_B } });
    expect(magic.inject).toContain("situation-memory");
    expect(magic.inject).toContain("retries capped at 3"); // memory from a file never opened in s2
    // Files overlap (0.5) + matching task-type ("explore") lifts the score to the
    // strong tier (0.6) → assertive voice. The tentative/medium voice is covered
    // in the fingerprint-injection unit test.
    expect(magic.inject!.toLowerCase()).toContain("situation like this");
  });

  it("does not re-inject the same file twice in one session (dedup)", async () => {
    const first = await core.handleToolObservation({ sessionKey: "s1", toolName: "Read", toolInput: { file_path: FILE_A } });
    expect(first.inject).toContain("file-memory");
    const second = await core.handleToolObservation({ sessionKey: "s1", toolName: "Read", toolInput: { file_path: FILE_A } });
    expect(second.inject).toBeUndefined();
  });

  it("stays fully silent for an unknown file with no situation history", async () => {
    const res = await core.handleToolObservation({ sessionKey: "s1", toolName: "Read", toolInput: { file_path: FILE_B } });
    expect(res.inject).toBeUndefined();
  });
});
