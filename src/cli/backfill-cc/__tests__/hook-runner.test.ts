/**
 * These tests spawn small SYNTHETIC scripts under __fixtures__ — never the
 * real tdai-memory hook.mjs, never touching the live gateway or the live
 * data dir. They verify runHookStop's exit-code/timeout handling only.
 */
import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childTimeoutMs, runHookStop } from "../hook-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "__fixtures__");

describe("childTimeoutMs", () => {
  it("defaults to the 30s Stop-hook budget", () => {
    expect(childTimeoutMs({})).toBe(30_000);
  });

  it("covers two capture attempts plus slack when a capture timeout is given", () => {
    // 2026-09-05: the hook retries /capture once, so the kill budget must
    // outlive both attempts or the child dies mid-retry and nothing is saved.
    expect(childTimeoutMs({ captureTimeoutMs: 300_000 })).toBe(610_000);
  });

  it("an explicit timeoutMs wins over the derived one", () => {
    expect(childTimeoutMs({ timeoutMs: 200, captureTimeoutMs: 300_000 })).toBe(200);
  });
});

describe("runHookStop", () => {
  it("forwards captureTimeoutMs to the child as TDAI_CAPTURE_TIMEOUT_MS", async () => {
    const result = await runHookStop({
      hookPath: join(FIXTURES, "fake-hook-env.mjs"),
      sessionId: "s1",
      transcriptPath: "C:\\fake\\s1.jsonl",
      cwd: "C:\\fake",
      captureTimeoutMs: 300_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("TDAI_CAPTURE_TIMEOUT_MS=300000");
  });

  it("leaves TDAI_CAPTURE_TIMEOUT_MS alone when no capture timeout is given", async () => {
    const before = process.env.TDAI_CAPTURE_TIMEOUT_MS;
    delete process.env.TDAI_CAPTURE_TIMEOUT_MS;
    try {
      const result = await runHookStop({
        hookPath: join(FIXTURES, "fake-hook-env.mjs"),
        sessionId: "s1",
        transcriptPath: "C:\\fake\\s1.jsonl",
        cwd: "C:\\fake",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("TDAI_CAPTURE_TIMEOUT_MS=<unset>");
    } finally {
      if (before !== undefined) process.env.TDAI_CAPTURE_TIMEOUT_MS = before;
    }
  });

  it("resolves ok:true when the child exits 0", async () => {
    const result = await runHookStop({
      hookPath: join(FIXTURES, "fake-hook-ok.mjs"),
      sessionId: "s1",
      transcriptPath: "C:\\fake\\s1.jsonl",
      cwd: "C:\\fake",
    });
    expect(result).toEqual({ ok: true });
  });

  it("resolves ok:false with the stderr tail when the child exits non-zero", async () => {
    const result = await runHookStop({
      hookPath: join(FIXTURES, "fake-hook-fail.mjs"),
      sessionId: "s1",
      transcriptPath: "C:\\fake\\s1.jsonl",
      cwd: "C:\\fake",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exit 1");
      expect(result.error).toContain("simulated capture-failed");
    }
  });

  it("resolves ok:false and kills the child after timeoutMs when it never exits", async () => {
    const result = await runHookStop({
      hookPath: join(FIXTURES, "fake-hook-hang.mjs"),
      sessionId: "s1",
      transcriptPath: "C:\\fake\\s1.jsonl",
      cwd: "C:\\fake",
      timeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("timed out after 200ms");
    }
  }, 5_000);

  it("resolves ok:false with a spawn error for a non-existent node binary", async () => {
    const result = await runHookStop({
      hookPath: join(FIXTURES, "fake-hook-ok.mjs"),
      sessionId: "s1",
      transcriptPath: "C:\\fake\\s1.jsonl",
      cwd: "C:\\fake",
      nodeBin: "C:\\this\\binary\\does\\not\\exist.exe",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("spawn error");
    }
  });
});
