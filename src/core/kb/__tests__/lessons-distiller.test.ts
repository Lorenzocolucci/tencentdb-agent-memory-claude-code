/**
 * Phase B part 3 — LLM lesson distiller.
 *
 * The LLM is injected (LLMRunner), so these run offline with a fake runner.
 * Pins:
 *   - a valid JSON response (even wrapped in ```json fences) parses into a
 *     DistilledLesson, confidence clamped to [0,1]
 *   - the prompt carries the bug text AND every fix text (the failure context)
 *   - a thrown runner, empty output, or garbage → null (memory never breaks)
 *   - missing required fields → null
 */

import { describe, it, expect, vi } from "vitest";
import { distillLesson, parseDistilledLesson, buildDistillPrompt } from "../lessons-distiller.js";
import type { DistillableCluster } from "../lessons-distiller.js";
import type { LLMRunner } from "../types.js";

const CLUSTER: DistillableCluster = {
  project: "Sofia AI",
  bugText: "Circuit breaker treats non-2xx as failures, blocking lookups on 404.",
  fixTexts: ["Fixed by adding errorFilter and statusCodeFilter."],
};

function runnerReturning(text: string): LLMRunner {
  return { run: vi.fn(async () => text) };
}

const VALID = JSON.stringify({
  domain: "circuit-breaker",
  trigger_pattern: "circuit breaker trips on non-error status codes",
  lesson_text: "Configure errorFilter/statusCodeFilter so 404 doesn't trip the breaker.",
  anti_patterns: ["treat all non-2xx as failure"],
  confidence: 1.7,
});

describe("buildDistillPrompt", () => {
  it("includes the bug text and every fix text", () => {
    const p = buildDistillPrompt(CLUSTER);
    expect(p).toContain("non-2xx as failures");
    expect(p).toContain("errorFilter and statusCodeFilter");
  });
});

describe("parseDistilledLesson", () => {
  it("parses JSON wrapped in markdown fences and clamps confidence", () => {
    const out = parseDistilledLesson("```json\n" + VALID + "\n```");
    expect(out).not.toBeNull();
    expect(out!.domain).toBe("circuit-breaker");
    expect(out!.antiPatterns).toEqual(["treat all non-2xx as failure"]);
    expect(out!.confidence).toBe(1); // clamped from 1.7
  });

  it("returns null on garbage, empty, or missing required fields", () => {
    expect(parseDistilledLesson("")).toBeNull();
    expect(parseDistilledLesson("not json at all")).toBeNull();
    expect(parseDistilledLesson(JSON.stringify({ domain: "d" }))).toBeNull(); // no trigger/text
  });
});

describe("distillLesson", () => {
  it("distills a cluster via the injected runner", async () => {
    const runner = runnerReturning(VALID);
    const out = await distillLesson(CLUSTER, runner);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(out?.triggerPattern).toContain("non-error status");
  });

  it("returns null when the runner throws (never propagates)", async () => {
    const runner: LLMRunner = {
      run: vi.fn(async () => {
        throw new Error("LLM timeout");
      }),
    };
    await expect(distillLesson(CLUSTER, runner)).resolves.toBeNull();
  });

  it("returns null when the runner yields unparseable output", async () => {
    const out = await distillLesson(CLUSTER, runnerReturning("sorry, I cannot help"));
    expect(out).toBeNull();
  });
});
