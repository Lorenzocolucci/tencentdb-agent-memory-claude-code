/**
 * StandaloneLLMRunner — the ONE choke point every gateway LLM call goes through.
 *
 * Pins the transport-level fallback added 2026-09-05: when the primary provider
 * throws (dead model `moonshot-v1-auto`: 17/17 calls failed live, and the
 * distillation passes reported "no new lessons"), run() re-runs the SAME
 * generateText arguments on the fallback provider; only when both fail does it
 * log + rethrow. `ai` and `@ai-sdk/openai` are mocked: no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const createOpenAIMock = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (opts: { baseURL: string; apiKey: string; fetch?: unknown }) => {
    createOpenAIMock(opts);
    return {
      chat: (model: string) => ({ modelId: model, baseURL: opts.baseURL, apiKey: opts.apiKey }),
    };
  },
}));

import {
  StandaloneLLMRunner,
  StandaloneLLMRunnerFactory,
  LLMFallbackExhaustedError,
  type StandaloneLLMConfig,
} from "../llm-runner.js";

const PRIMARY = { baseUrl: "https://api.moonshot.ai/v1", apiKey: "k-primary", model: "moonshot-v1-auto" };
const FALLBACK = { baseUrl: "https://api.openai.com/v1", apiKey: "k-fallback", model: "gpt-5.4-mini", omitTemperature: true };

function okResult(text: string) {
  return { text, steps: [] as Array<{ toolCalls: unknown[] }> };
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

type Call = Record<string, unknown> & { model: { modelId: string; baseURL: string; apiKey: string } };
const callArg = (n: number): Call => generateTextMock.mock.calls[n]![0] as Call;

beforeEach(() => {
  generateTextMock.mockReset();
  createOpenAIMock.mockReset();
});

describe("StandaloneLLMRunner.run() fallback", () => {
  it("primary ok → fallback never touched", async () => {
    generateTextMock.mockResolvedValueOnce(okResult("  hello "));
    const logger = makeLogger();
    const runner = new StandaloneLLMRunner({ config: { ...PRIMARY, fallback: FALLBACK }, logger });

    const out = await runner.run({ prompt: "p", taskId: "t1" });

    expect(out).toBe("hello");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(callArg(0).model.modelId).toBe("moonshot-v1-auto");
    expect(callArg(0).model.apiKey).toBe("k-primary");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("primary throws → same arguments re-run on the fallback, temperature omitted, one warn WITH taskId", async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error("Not found the model moonshot-v1-auto or Permission denied"))
      .mockResolvedValueOnce(okResult('{"ok":true}'));
    const logger = makeLogger();
    const runner = new StandaloneLLMRunner({
      config: { ...PRIMARY, fallback: FALLBACK },
      enableTools: true,
      logger,
    });

    const out = await runner.run({
      prompt: "extract",
      systemPrompt: "sys",
      taskId: "lesson-distill",
      forceWriteTool: true,
      workspaceDir: process.cwd(),
    });

    expect(out).toBe('{"ok":true}');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    const first = callArg(0);
    const second = callArg(1);
    // Fallback provider + model, and a DIFFERENT provider instance (own key/base).
    expect(second.model.modelId).toBe("gpt-5.4-mini");
    expect(second.model.baseURL).toBe("https://api.openai.com/v1");
    expect(second.model.apiKey).toBe("k-fallback");
    // The SAME tools object, toolChoice, stopWhen, prompt and system.
    expect(second.tools).toBe(first.tools);
    expect(second.toolChoice).toBe("required");
    expect(second.stopWhen).toBe(first.stopWhen);
    expect(second.prompt).toBe("extract");
    expect(second.system).toBe("sys");
    expect(second.maxOutputTokens).toBe(first.maxOutputTokens);
    // Temperature: neither attempt sends one (moonshot: server-only legal
    // value; fallback: omitTemperature for the reasoning model).
    expect(first.temperature).toBeUndefined();
    expect(second.temperature).toBeUndefined();
    // A fresh abort signal (not the primary's, which may already be aborted).
    expect(second.abortSignal).not.toBe(first.abortSignal);
    expect(second.abortSignal).toBeInstanceOf(AbortSignal);
    // Exactly one warn, carrying the taskId and both model names; no error line.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnLine = String(logger.warn.mock.calls[0]![0]);
    expect(warnLine).toContain("taskId=lesson-distill");
    expect(warnLine).toContain("moonshot-v1-auto");
    expect(warnLine).toContain("gpt-5.4-mini");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("both fail → error line with taskId, rethrow carrying both causes", async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error("primary boom"))
      .mockRejectedValueOnce(new Error("fallback boom"));
    const logger = makeLogger();
    const runner = new StandaloneLLMRunner({ config: { ...PRIMARY, fallback: FALLBACK }, logger });

    const err = await runner.run({ prompt: "p", taskId: "usage-distill" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LLMFallbackExhaustedError);
    const e = err as LLMFallbackExhaustedError;
    expect(e.message).toContain("primary boom");
    expect(e.message).toContain("fallback boom");
    expect(e.primaryModel).toBe("moonshot-v1-auto");
    expect(e.fallbackModel).toBe("gpt-5.4-mini");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0]![0])).toContain("taskId=usage-distill");
  });

  it("no fallback configured → today's behaviour: one attempt, error line WITH taskId, rethrow as-is", async () => {
    const boom = new Error("dead model");
    generateTextMock.mockRejectedValueOnce(boom);
    const logger = makeLogger();
    const runner = new StandaloneLLMRunner({ config: { ...PRIMARY }, logger });

    await expect(runner.run({ prompt: "p", taskId: "kb-extraction" })).rejects.toBe(boom);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(String(logger.error.mock.calls[0]![0])).toContain("taskId=kb-extraction");
  });

  it("fallback overrides maxTokens/timeout when set, otherwise inherits the primary's", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(okResult("a"));
    const runner = new StandaloneLLMRunner({
      config: { ...PRIMARY, maxTokens: 500, fallback: { ...FALLBACK, maxTokens: 900 } },
    });
    await runner.run({ prompt: "p", taskId: "t" });
    expect(callArg(0).maxOutputTokens).toBe(500);
    expect(callArg(1).maxOutputTokens).toBe(900);
  });
});

describe("temperature policy at the primary", () => {
  it("Moonshot/Kimi host → no temperature sent even when the caller asks for one", async () => {
    generateTextMock.mockResolvedValueOnce(okResult("a"));
    const runner = new StandaloneLLMRunner({ config: { ...PRIMARY, temperature: 0.2 } });
    await runner.run({ prompt: "p", taskId: "t", temperature: 0.3 });
    expect(callArg(0).temperature).toBeUndefined();
  });

  it("other hosts honour the per-call value, then the config value", async () => {
    generateTextMock.mockResolvedValueOnce(okResult("a")).mockResolvedValueOnce(okResult("b"));
    const cfg: StandaloneLLMConfig = { baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o", temperature: 0.2 };
    const runner = new StandaloneLLMRunner({ config: cfg });
    await runner.run({ prompt: "p", taskId: "t", temperature: 0.7 });
    await runner.run({ prompt: "p", taskId: "t" });
    expect(callArg(0).temperature).toBe(0.7);
    expect(callArg(1).temperature).toBe(0.2);
  });

  it("omitTemperature sends none, on any host", async () => {
    generateTextMock.mockResolvedValueOnce(okResult("a"));
    const runner = new StandaloneLLMRunner({ config: { ...PRIMARY, omitTemperature: true } });
    await runner.run({ prompt: "p", taskId: "t" });
    expect(callArg(0).temperature).toBeUndefined();
  });

  it("Moonshot host gets a thinking-injecting fetch; OpenAI host gets none", async () => {
    generateTextMock.mockResolvedValueOnce(okResult("a")).mockResolvedValueOnce(okResult("b"));
    await new StandaloneLLMRunner({ config: { ...PRIMARY } }).run({ prompt: "p", taskId: "t" });
    await new StandaloneLLMRunner({ config: { ...FALLBACK } }).run({ prompt: "p", taskId: "t" });
    expect(typeof createOpenAIMock.mock.calls[0]![0].fetch).toBe("function");
    expect(createOpenAIMock.mock.calls[1]![0].fetch).toBeUndefined();
  });
});

describe("StandaloneLLMRunnerFactory.createFallbackRunner", () => {
  it("returns undefined without a fallback, else a runner on the fallback provider with no fallback of its own", async () => {
    expect(new StandaloneLLMRunnerFactory({ config: { ...PRIMARY } }).createFallbackRunner()).toBeUndefined();

    const factory = new StandaloneLLMRunnerFactory({ config: { ...PRIMARY, fallback: FALLBACK } });
    expect(factory.fallbackModel).toBe("gpt-5.4-mini");
    const fbRunner = factory.createFallbackRunner({ enableTools: false })!;
    generateTextMock.mockRejectedValueOnce(new Error("fb dead"));
    await expect(fbRunner.run({ prompt: "p", taskId: "t" })).rejects.toThrow("fb dead");
    // One attempt only: the fallback runner must never chain to itself.
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(callArg(0).model.modelId).toBe("gpt-5.4-mini");
    expect(callArg(0).temperature).toBeUndefined();
  });
});
