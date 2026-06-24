/**
 * Phase B (B2a+) — LLM lesson distiller.
 *
 * B2a contract changes tested here:
 *   - DistillableCluster.bugTexts (string[]) replaces the old bugText (string).
 *   - trigger_pattern is NOT in the LLM JSON contract; parseDistilledLesson
 *     succeeds without it.
 *   - DistilledLesson has no triggerPattern field.
 *   - Prompt shows all bug texts as "RECURRENCE N:" lines.
 *   - Parser still robust to fences, garbage, missing optional trigger_pattern.
 *
 * The LLM is injected (LLMRunner), so these run offline with a fake runner.
 * Pins:
 *   - a valid JSON response (even wrapped in ```json fences) parses into a
 *     DistilledLesson, confidence clamped to [0,1]
 *   - the prompt carries ALL bug texts as recurrences AND fix texts
 *   - a thrown runner, empty output, or garbage → null (memory never breaks)
 *   - missing required fields (domain, lesson_text) → null
 */

import { describe, it, expect, vi } from "vitest";
import { distillLesson, parseDistilledLesson, buildDistillPrompt } from "../lessons-distiller.js";
import type { DistillableCluster } from "../lessons-distiller.js";
import type { LLMRunner } from "../types.js";

// B2a cluster shape: bugTexts[] (multiple recurrences) + fixTexts[]
const CLUSTER: DistillableCluster = {
  project: "Sofia AI",
  bugTexts: [
    "Circuit breaker treats non-2xx as failures, blocking lookups on 404.",
    "Circuit breaker trips again on 404 in a different session.",
  ],
  fixTexts: ["Fixed by adding errorFilter and statusCodeFilter."],
};

function runnerReturning(text: string): LLMRunner {
  return { run: vi.fn(async () => text) };
}

// Valid JSON WITHOUT trigger_pattern (B2a contract)
const VALID = JSON.stringify({
  domain: "circuit-breaker",
  lesson_text: "Configure errorFilter/statusCodeFilter so 404 doesn't trip the breaker.",
  anti_patterns: ["treat all non-2xx as failure"],
  confidence: 1.7,
});

// Backward compat: JSON WITH trigger_pattern — parser ignores it, still succeeds
const VALID_WITH_TRIGGER = JSON.stringify({
  domain: "circuit-breaker",
  trigger_pattern: "some LLM trigger text",
  lesson_text: "Configure errorFilter/statusCodeFilter.",
  anti_patterns: [],
  confidence: 0.9,
});

describe("buildDistillPrompt", () => {
  it("includes all bug texts as RECURRENCE lines", () => {
    const p = buildDistillPrompt(CLUSTER);
    expect(p).toContain("RECURRENCE 1:");
    expect(p).toContain("RECURRENCE 2:");
    expect(p).toContain("non-2xx as failures");
    expect(p).toContain("different session");
  });

  it("includes fix texts in the FIX(ES) section", () => {
    const p = buildDistillPrompt(CLUSTER);
    expect(p).toContain("errorFilter and statusCodeFilter");
  });

  it("indicates unknown resolution when fixTexts is empty", () => {
    const p = buildDistillPrompt({ ...CLUSTER, fixTexts: [] });
    expect(p).toContain("unknown");
  });
});

describe("parseDistilledLesson", () => {
  it("parses JSON without trigger_pattern (B2a contract)", () => {
    const out = parseDistilledLesson(VALID);
    expect(out).not.toBeNull();
    expect(out!.domain).toBe("circuit-breaker");
    expect(out!.lessonText).toContain("errorFilter");
    expect(out!.antiPatterns).toEqual(["treat all non-2xx as failure"]);
    expect(out!.confidence).toBe(1); // clamped from 1.7
  });

  it("parses JSON wrapped in markdown fences and clamps confidence", () => {
    const out = parseDistilledLesson("```json\n" + VALID + "\n```");
    expect(out).not.toBeNull();
    expect(out!.domain).toBe("circuit-breaker");
    expect(out!.confidence).toBe(1); // clamped from 1.7
  });

  it("parses JSON WITH trigger_pattern (backward compat — field is ignored)", () => {
    const out = parseDistilledLesson(VALID_WITH_TRIGGER);
    expect(out).not.toBeNull();
    expect(out!.domain).toBe("circuit-breaker");
    // DistilledLesson has no triggerPattern field in B2a
    expect(out).not.toHaveProperty("triggerPattern");
  });

  it("returns null on garbage, empty, or missing required fields", () => {
    expect(parseDistilledLesson("")).toBeNull();
    expect(parseDistilledLesson("not json at all")).toBeNull();
    // Missing lesson_text → null
    expect(parseDistilledLesson(JSON.stringify({ domain: "d" }))).toBeNull();
    // Missing domain → null
    expect(parseDistilledLesson(JSON.stringify({ lesson_text: "x" }))).toBeNull();
  });
});

describe("distillLesson", () => {
  it("distills a cluster via the injected runner", async () => {
    const runner = runnerReturning(VALID);
    const out = await distillLesson(CLUSTER, runner);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(out?.domain).toBe("circuit-breaker");
    expect(out?.lessonText).toContain("errorFilter");
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
