/**
 * Characterization test for the "stranded tail" mechanism behind the seed bug.
 *
 * THE BUG (seed-runtime.ts): after feeding a session's rounds, the seed only
 * WAITS for L1 to go idle. But a final conversation below the (warm-up-raised)
 * trigger threshold is never extracted by waiting — it sits buffered until an
 * idle timer (600s) or an explicit flush. The seed gave up before the timer,
 * so the last conversation was LOST and 5 min were wasted per session.
 *
 * THE FIX: the seed must call `flushSession()` — the same production path that
 * `handleSessionEnd` uses — which enqueues a final L1 unconditionally.
 *
 * This test pins both halves at the mechanism level (no LLM): waiting strands
 * the tail; flushSession rescues it. It guards against re-introducing a
 * wait-only finalization.
 */
import { describe, it, expect } from "vitest";
import {
  MemoryPipelineManager,
  type PipelineConfig,
  type CapturedMessage,
} from "./pipeline-manager.js";

function makeConfig(): PipelineConfig {
  return {
    everyNConversations: 5,
    enableWarmup: true, // threshold climbs 1 → 2 → 4 → 5, creating the sub-threshold tail
    l1: { idleTimeoutSeconds: 600 }, // long, so the idle timer never rescues during the test
    l2: {
      delayAfterL1Seconds: 9999,
      minIntervalSeconds: 9999,
      maxIntervalSeconds: 9999,
      sessionActiveWindowHours: 24,
    },
  };
}

function msg(content: string): CapturedMessage {
  return { role: "user", content, timestamp: new Date().toISOString() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

describe("MemoryPipelineManager — sub-threshold tail extraction", () => {
  it("waiting strands the last sub-threshold conversation; flushSession rescues it", async () => {
    const mgr = new MemoryPipelineManager(makeConfig());
    mgr.setPersister(async () => {}); // noop persister
    const extracted: string[] = [];
    mgr.setL1Runner(async ({ msg: messages }) => {
      for (const m of messages) extracted.push(m.content);
      return { processedCount: messages.length };
    });
    mgr.start();

    const key = "sess-tail";

    // Conv 1: warm-up threshold = 1 → triggers L1 immediately.
    await mgr.notifyConversation(key, [msg("ALPHA")]);
    const alphaDone = await waitFor(() => extracted.includes("ALPHA"));
    expect(alphaDone).toBe(true);

    // Conv 2: threshold is now 2 → below it → buffered, NOT triggered. This is
    // the tail. Give the pipeline a moment; waiting alone must NOT extract it.
    await mgr.notifyConversation(key, [msg("OMEGA")]);
    await new Promise((r) => setTimeout(r, 300));
    expect(extracted).toContain("ALPHA");
    expect(extracted).not.toContain("OMEGA"); // BUG mechanism: tail stranded by waiting

    // FIX: flushSession forces the final L1 and drains it.
    await mgr.flushSession(key);
    expect(extracted).toContain("OMEGA"); // tail rescued

    await mgr.destroy();
  });
});
