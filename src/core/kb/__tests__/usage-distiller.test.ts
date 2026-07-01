/**
 * Slice A3 — usage distiller (LLM precision gate). Proves: confirms a genuine
 * tendency, rejects noise, rejects true-but-empty, rejects residual CJK, never
 * throws. The runner is injected so this is offline-deterministic.
 */
import { describe, it, expect, vi } from "vitest";
import {
  distillUsageCluster,
  parseDistilledUsage,
  buildUsagePrompt,
} from "../usage-distiller.js";

const runnerReturning = (s: string) => ({ run: vi.fn().mockResolvedValue(s) }) as any;
const cluster = { project: "sofia", texts: ["aspetta la mia risposta", "non partire finché non rispondo"] };

describe("parseDistilledUsage", () => {
  it("parses a confirmed tendency", () => {
    const p = parseDistilledUsage('{"is_tendency": true, "tendency_text": "Tende ad attendere conferma.", "confidence": 0.8}');
    expect(p).toEqual({ isTendency: true, tendencyText: "Tende ad attendere conferma.", confidence: 0.8 });
  });
  it("parses a rejection", () => {
    const p = parseDistilledUsage('{"is_tendency": false, "tendency_text": "", "confidence": 0.2}');
    expect(p).toEqual({ isTendency: false, tendencyText: "", confidence: 0.2 });
  });
  it("rejects true-but-empty (a confirmed tendency must carry a statement)", () => {
    expect(parseDistilledUsage('{"is_tendency": true, "tendency_text": "", "confidence": 0.9}')).toBeNull();
  });
  it("returns null on garbage", () => {
    expect(parseDistilledUsage("not json")).toBeNull();
    expect(parseDistilledUsage("")).toBeNull();
  });
});

describe("buildUsagePrompt", () => {
  it("frames the texts as cross-session observations", () => {
    const p = buildUsagePrompt(cluster);
    expect(p).toContain("OBSERVATION 1: aspetta la mia risposta");
    expect(p).toContain("OBSERVATION 2:");
    expect(p).toContain("across different sessions");
  });
});

describe("distillUsageCluster", () => {
  it("returns the cleaned tendency when the LLM confirms", async () => {
    const runner = runnerReturning('{"is_tendency": true, "tendency_text": "Tende ad attendere la conferma prima di procedere.", "confidence": 0.82}');
    const out = await distillUsageCluster(cluster, runner);
    expect(out).not.toBeNull();
    expect(out!.tendencyText).toContain("attendere");
  });

  it("returns null when the LLM rejects the cluster as noise", async () => {
    const runner = runnerReturning('{"is_tendency": false, "tendency_text": "", "confidence": 0.1}');
    expect(await distillUsageCluster(cluster, runner)).toBeNull();
  });

  it("rejects a residual-CJK tendency rather than store garbage", async () => {
    const runner = runnerReturning('{"is_tendency": true, "tendency_text": "倾向于等待确认", "confidence": 0.9}');
    // runWithoutCjk retries then returns the still-CJK output; distiller rejects.
    expect(await distillUsageCluster(cluster, runner)).toBeNull();
  });

  it("never throws when the runner fails", async () => {
    const runner = { run: vi.fn().mockRejectedValue(new Error("boom")) } as any;
    expect(await distillUsageCluster(cluster, runner)).toBeNull();
  });
});
