import { describe, it, expect, vi } from "vitest";
import { replayTranscript } from "../replay-loop.js";

describe("replayTranscript", () => {
  it("does nothing and returns replayed for a 0-turn transcript (never spawns the hook)", async () => {
    const invokeHook = vi.fn();
    const result = await replayTranscript({
      turns: 0,
      cursorBefore: null,
      invokeHook,
      getCursorTurns: async () => null,
      pace: async () => {},
    });
    expect(result.status).toBe("replayed");
    expect(result.iterations).toBe(0);
    expect(invokeHook).not.toHaveBeenCalled();
  });

  it("is a no-op when the cursor already covers all turns", async () => {
    const invokeHook = vi.fn();
    const result = await replayTranscript({
      turns: 3,
      cursorBefore: 3,
      invokeHook,
      getCursorTurns: async () => 3,
      pace: async () => {},
    });
    expect(result.status).toBe("replayed");
    expect(invokeHook).not.toHaveBeenCalled();
  });

  it("succeeds after one hook call that advances the cursor to the target", async () => {
    const invokeHook = vi.fn().mockResolvedValue({ ok: true });
    const result = await replayTranscript({
      turns: 1,
      cursorBefore: null,
      invokeHook,
      getCursorTurns: async () => 1,
      pace: async () => {},
    });
    expect(result.status).toBe("replayed");
    expect(result.iterations).toBe(1);
    expect(result.turnsSentBefore).toBe(0);
    expect(result.turnsSentAfter).toBe(1);
  });

  it("keeps calling the hook (MAX_CAPTURE_TURNS=50 cap in the real hook) until the cursor catches up", async () => {
    let cursor = 0;
    const invokeHook = vi.fn().mockImplementation(async () => {
      cursor += 50;
      return { ok: true };
    });
    const result = await replayTranscript({
      turns: 120,
      cursorBefore: null,
      invokeHook,
      getCursorTurns: async () => cursor,
      pace: async () => {},
    });
    expect(result.status).toBe("replayed");
    expect(invokeHook).toHaveBeenCalledTimes(3);
    expect(result.turnsSentAfter).toBe(150);
  });

  it("stops immediately and marks failed when the hook invocation itself errors", async () => {
    const invokeHook = vi.fn().mockResolvedValue({ ok: false, error: "spawn error: ENOENT" });
    const getCursorTurns = vi.fn();
    const result = await replayTranscript({
      turns: 2,
      cursorBefore: null,
      invokeHook,
      getCursorTurns,
      pace: async () => {},
    });
    expect(result.status).toBe("failed");
    expect(result.lastError).toBe("spawn error: ENOENT");
    expect(invokeHook).toHaveBeenCalledTimes(1);
    expect(getCursorTurns).not.toHaveBeenCalled();
  });

  it("marks partial after the iteration cap when the cursor never catches up", async () => {
    const invokeHook = vi.fn().mockResolvedValue({ ok: true });
    const pace = vi.fn().mockResolvedValue(undefined);
    const result = await replayTranscript({
      turns: 1000,
      cursorBefore: null,
      invokeHook,
      getCursorTurns: async () => 5, // never advances — simulates a stuck hook
      maxIterations: 20,
      pace,
    });
    expect(result.status).toBe("partial");
    expect(invokeHook).toHaveBeenCalledTimes(20);
    expect(result.lastError).toContain("stuck at 5/1000");
    // pace is called BETWEEN iterations only: 19 times for 20 iterations.
    expect(pace).toHaveBeenCalledTimes(19);
  });
});
