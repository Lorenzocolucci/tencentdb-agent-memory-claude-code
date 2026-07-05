/**
 * Immune-system regression: restart amnesia.
 *
 * THE BUG: `sessionStates` is in-memory, rebuilt only by a /capture. After a
 * gateway restart, a session with un-extracted L0 backlog but no new capture
 * never resumes: `runL1` bails at `if (!state) return`, so `flushSession` is a
 * silent no-op and the backlog stays frozen (discovered days later by audit).
 *
 * THE FIX (two halves):
 *   - `start(restoredStates)` restores per-session state from the checkpoint and
 *     `recoverPendingSessions()` re-enqueues an L1 "recovery" pass for each —
 *     so a restored session re-extracts WITHOUT a new capture.
 *   - the gateway calls this eagerly at boot (resumeExtraction) and before every
 *     /session/end flush (handleSessionEnd), so a restart resumes backlogs.
 *
 * This test pins the pipeline-manager mechanism both halves rely on (no LLM).
 */
import { describe, it, expect } from "vitest";
import {
  MemoryPipelineManager,
  type PipelineConfig,
  type PipelineSessionState,
} from "./pipeline-manager.js";

function makeConfig(): PipelineConfig {
  return {
    everyNConversations: 5,
    enableWarmup: true,
    l1: { idleTimeoutSeconds: 600 },
    l2: {
      delayAfterL1Seconds: 9999,
      minIntervalSeconds: 9999,
      maxIntervalSeconds: 9999,
      sessionActiveWindowHours: 24,
    },
  };
}

function restoredState(): PipelineSessionState {
  return {
    conversation_count: 0,
    last_extraction_time: "",
    last_extraction_updated_time: "",
    last_active_time: 1_000,
    l2_pending_l1_count: 0,
    warmup_threshold: 0,
    l2_last_extraction_time: "",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

describe("MemoryPipelineManager — restart recovery", () => {
  it("recovery re-triggers L1 for a RESTORED session with NO new capture", async () => {
    const mgr = new MemoryPipelineManager(makeConfig());
    mgr.setPersister(async () => {});
    const ranFor: string[] = [];
    mgr.setL1Runner(async ({ sessionKey }) => {
      ranFor.push(sessionKey);
      return { processedCount: 0 };
    });

    // Simulate a restart: the checkpoint's pipeline_states are restored and the
    // pipeline starts. No capture arrives afterwards.
    const key = "sess-restored";
    mgr.start({ [key]: restoredState() });

    // The whole point: recovery must re-enqueue an L1 pass for the restored
    // backlog on its own — the runner reads un-extracted L0 by cursor.
    const ran = await waitFor(() => ranFor.includes(key));
    expect(ran, "recovery must re-trigger L1 for the restored session").toBe(true);

    await mgr.destroy();
  });

  it("without a restored/known session, flushSession is a silent no-op (the frozen backlog)", async () => {
    const mgr = new MemoryPipelineManager(makeConfig());
    mgr.setPersister(async () => {});
    const ranFor: string[] = [];
    mgr.setL1Runner(async ({ sessionKey }) => {
      ranFor.push(sessionKey);
      return { processedCount: 0 };
    });
    mgr.start(); // fresh gateway: empty sessionStates, nothing restored

    // runL1 bails on `!state` — this is exactly the amnesia the gateway now
    // works around by restoring state (start/recovery) before flushing.
    await mgr.flushSession("sess-never-captured");
    await new Promise((r) => setTimeout(r, 200));
    expect(ranFor).not.toContain("sess-never-captured");

    await mgr.destroy();
  });

  it("digestBacklogSession fully DRAINS an arbitrary session_key with NO state (backfill)", async () => {
    const mgr = new MemoryPipelineManager(makeConfig());
    mgr.setPersister(async () => {});
    const ranFor: string[] = [];
    // Simulate a 2-window session: first pass reads 50, second reads the tail 30,
    // third reads nothing (drained). digestBacklogSession must loop until 0.
    const passes = [50, 30, 0];
    let i = 0;
    mgr.setL1Runner(async ({ sessionKey }) => {
      ranFor.push(sessionKey);
      return { processedCount: passes[Math.min(i++, passes.length - 1)] };
    });
    mgr.start(); // no sessionState for the imported chat — backfill must NOT bail

    const res = await mgr.digestBacklogSession("chatimport_abc123");
    // Ran repeatedly (drain loop), summed the processed counts, stopped at 0.
    expect(ranFor.filter((s) => s === "chatimport_abc123").length).toBe(3);
    expect((res as { processedCount: number }).processedCount).toBe(80);

    await mgr.destroy();
  });
});
