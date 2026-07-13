import { describe, it, expect, vi } from "vitest";
import { hasCjk, runWithoutCjk } from "../language-guard.js";
import type { LLMRunner } from "../../core/types.js";

describe("hasCjk", () => {
  it("detects Chinese and CJK, ignores Italian/English", () => {
    expect(hasCjk("优先考虑灵活可扩展的方案")).toBe(true);
    expect(hasCjk("能源dom charm parteci")).toBe(true); // mixed mojibake
    expect(hasCjk("Prezza a valore, non a ora.")).toBe(false);
    expect(hasCjk("Prefer local solutions")).toBe(false);
    expect(hasCjk("")).toBe(false);
  });
});

describe("runWithoutCjk", () => {
  const params = { systemPrompt: "base", prompt: "p", taskId: "t", timeoutMs: 1000 };

  it("returns the first output when it is already clean", async () => {
    const runner = { run: vi.fn().mockResolvedValue("Prezza a valore.") } as unknown as LLMRunner;
    const out = await runWithoutCjk(runner, params);
    expect(out).toBe("Prezza a valore.");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("re-runs with an escalating directive when CJK appears, then returns the clean rewrite", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce("优先考虑方案") // tainted
      .mockResolvedValueOnce("Prioritize the plan."); // clean rewrite
    const runner = { run } as unknown as LLMRunner;

    const out = await runWithoutCjk(runner, params, { maxRewrites: 2 });
    expect(out).toBe("Prioritize the plan.");
    expect(run).toHaveBeenCalledTimes(2);
    // The retry carried the escalation directive.
    expect(run.mock.calls[1][0].systemPrompt).toContain("FORBIDDEN");
  });

  it("gives up after maxRewrites and returns the last (still-tainted) output", async () => {
    const run = vi.fn().mockResolvedValue("还是中文"); // always CJK
    const runner = { run } as unknown as LLMRunner;
    const out = await runWithoutCjk(runner, params, { maxRewrites: 2 });
    expect(hasCjk(out)).toBe(true);
    expect(run).toHaveBeenCalledTimes(3); // 1 initial + 2 rewrites
  });
});
