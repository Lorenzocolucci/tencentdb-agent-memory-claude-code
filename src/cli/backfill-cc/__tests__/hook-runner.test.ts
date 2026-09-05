/**
 * These tests spawn small SYNTHETIC scripts under __fixtures__ — never the
 * real tdai-memory hook.mjs, never touching the live gateway or the live
 * data dir. They verify runHookStop's exit-code/timeout handling only.
 */
import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHookStop } from "../hook-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "__fixtures__");

describe("runHookStop", () => {
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
