import { describe, it, expect, vi } from "vitest";
import { digestKey, planDigestKeys } from "../digest-driver.js";

describe("digestKey", () => {
  it("returns done on the first successful attempt, with no retry", async () => {
    const postDigestForKey = vi.fn().mockResolvedValue({ processedCount: 12 });
    const result = await digestKey("key-1", { postDigestForKey, stallMs: 1000 });
    expect(result).toEqual({ status: "done", processedCount: 12, error: null, retried: false });
    expect(postDigestForKey).toHaveBeenCalledTimes(1);
  });

  it("retries EXACTLY once after a failed first attempt, and succeeds on the retry", async () => {
    const postDigestForKey = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 500: boom"))
      .mockResolvedValueOnce({ processedCount: 7 });
    const onProgress = vi.fn();
    const result = await digestKey("key-1", { postDigestForKey, stallMs: 1000, onProgress });
    expect(result).toEqual({ status: "done", processedCount: 7, error: null, retried: true });
    expect(postDigestForKey).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0][0]).toContain("boom");
  });

  it("fails after the retry also fails, and calls postDigestForKey exactly twice", async () => {
    const postDigestForKey = vi.fn().mockRejectedValue(new Error("still down"));
    const result = await digestKey("key-1", { postDigestForKey, stallMs: 1000 });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("still down");
    expect(result.retried).toBe(true);
    expect(postDigestForKey).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled call via the AbortSignal after stallMs and treats it as a failed attempt", async () => {
    // A "stalled" call never resolves/rejects on its own; it only reacts to abort.
    const postDigestForKey = vi.fn().mockImplementation(
      (_key: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by stall watchdog")), { once: true });
        }),
    );
    const result = await digestKey("key-1", { postDigestForKey, stallMs: 10 });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("aborted by stall watchdog");
    expect(postDigestForKey).toHaveBeenCalledTimes(2);
  });
});

describe("planDigestKeys", () => {
  it("returns only keys not already marked done", () => {
    const keys = planDigestKeys(["a", "b", "c"], { a: { status: "done" }, b: { status: "failed" } }, false);
    expect(keys.sort()).toEqual(["b", "c"]);
  });

  it("returns ALL keys when --force is set, including already-done ones", () => {
    const keys = planDigestKeys(["a", "b"], { a: { status: "done" } }, true);
    expect(keys.sort()).toEqual(["a", "b"]);
  });

  it("returns all keys unchanged when the digest state is empty", () => {
    expect(planDigestKeys(["a", "b"], {}, false)).toEqual(["a", "b"]);
  });
});
