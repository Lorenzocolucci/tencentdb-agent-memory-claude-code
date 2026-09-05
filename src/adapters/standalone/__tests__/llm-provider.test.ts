/**
 * Kimi/Moonshot reasoning control — the `thinking` body injection and the
 * temperature rule, proven on the OUTGOING request body:
 *  1. the pure fetch wrapper (fake base fetch), and
 *  2. the real @ai-sdk/openai provider driven by StandaloneLLMRunner with
 *     globalThis.fetch stubbed — so the SDK's own body construction is under test,
 *     not a mock of it. No network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createThinkingFetch,
  isMoonshotHost,
  resolveThinking,
  resolveTemperature,
} from "../llm-provider.js";
import { StandaloneLLMRunner } from "../llm-runner.js";

function chatCompletion(content: string): Response {
  const body = {
    id: "cmpl-1",
    object: "chat.completion",
    created: 1,
    model: "kimi-k2.6",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isMoonshotHost / resolveThinking / resolveTemperature", () => {
  it("recognises moonshot and kimi hosts only", () => {
    expect(isMoonshotHost("https://api.moonshot.ai/v1")).toBe(true);
    expect(isMoonshotHost("https://api.moonshot.cn/v1")).toBe(true);
    expect(isMoonshotHost("https://kimi.example.com/v1")).toBe(true);
    expect(isMoonshotHost("https://api.openai.com/v1")).toBe(false);
    expect(isMoonshotHost(undefined)).toBe(false);
    // Not fooled by the word in the PATH.
    expect(isMoonshotHost("https://api.openai.com/moonshot")).toBe(false);
  });

  it("defaults thinking to disabled on moonshot, nothing elsewhere; explicit wins", () => {
    expect(resolveThinking(undefined, "https://api.moonshot.ai/v1")).toBe("disabled");
    expect(resolveThinking(undefined, "https://api.openai.com/v1")).toBeUndefined();
    expect(resolveThinking("enabled", "https://api.moonshot.ai/v1")).toBe("enabled");
    expect(resolveThinking("disabled", "https://api.openai.com/v1")).toBe("disabled");
  });

  it("sends NO temperature to moonshot (each Kimi mode allows exactly one value: 1 / 0.6)", () => {
    expect(resolveTemperature({ baseUrl: "https://api.moonshot.ai/v1", requested: 0.3 })).toBeUndefined();
    expect(resolveTemperature({ baseUrl: "https://api.moonshot.ai/v1", omitTemperature: true })).toBeUndefined();
    expect(resolveTemperature({ baseUrl: "https://api.openai.com/v1", requested: 0.3, configured: 0.5 })).toBe(0.3);
    expect(resolveTemperature({ baseUrl: "https://api.openai.com/v1", configured: 0.5 })).toBe(0.5);
    expect(resolveTemperature({ baseUrl: "https://api.openai.com/v1" })).toBe(1);
  });
});

describe("createThinkingFetch (pure)", () => {
  it("injects thinking into a chat/completions JSON body and leaves everything else intact", async () => {
    const base = vi.fn(async () => chatCompletion("ok"));
    const f = createThinkingFetch("disabled", base);
    await f("https://api.moonshot.ai/v1/chat/completions", {
      method: "POST",
      headers: { a: "b" },
      body: JSON.stringify({ model: "kimi-k2.6", messages: [{ role: "user", content: "hi" }], temperature: 1 }),
    });
    const [url, init] = base.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ a: "b" });
    const sent = JSON.parse(init.body as string);
    expect(sent.thinking).toEqual({ type: "disabled" });
    expect(sent.model).toBe("kimi-k2.6");
    expect(sent.temperature).toBe(1);
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("passes non-chat URLs, non-string bodies and unparsable bodies through untouched", async () => {
    const base = vi.fn(async () => chatCompletion("ok"));
    const f = createThinkingFetch("enabled", base);
    await f("https://api.moonshot.ai/v1/embeddings", { method: "POST", body: '{"input":"x"}' });
    await f("https://api.moonshot.ai/v1/chat/completions", { method: "POST", body: "not json" });
    await f("https://api.moonshot.ai/v1/chat/completions", { method: "GET" });
    expect((base.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe('{"input":"x"}');
    expect((base.mock.calls[1] as unknown as [string, RequestInit])[1].body).toBe("not json");
    expect((base.mock.calls[2] as unknown as [string, RequestInit])[1].body).toBeUndefined();
  });

  it("uses globalThis.fetch lazily when no base fetch is given", async () => {
    const stub = vi.fn(async () => chatCompletion("ok"));
    vi.stubGlobal("fetch", stub);
    const f = createThinkingFetch("disabled");
    await f("https://api.moonshot.ai/v1/chat/completions", { method: "POST", body: "{}" });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(JSON.parse((stub.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ thinking: { type: "disabled" } });
  });
});

describe("through the real @ai-sdk/openai provider", () => {
  it("moonshot host: the outgoing chat/completions body carries thinking=disabled and NO temperature", async () => {
    const stub = vi.fn(async () => chatCompletion("answer"));
    vi.stubGlobal("fetch", stub);
    const runner = new StandaloneLLMRunner({
      config: { baseUrl: "https://api.moonshot.ai/v1", apiKey: "k", model: "kimi-k2.6", temperature: 0.2 },
    });

    const out = await runner.run({ prompt: "say hi", systemPrompt: "be brief", taskId: "probe", maxTokens: 64 });

    expect(out).toBe("answer");
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string | URL, RequestInit];
    expect(String(url)).toBe("https://api.moonshot.ai/v1/chat/completions");
    const sent = JSON.parse(init.body as string);
    expect(sent.thinking).toEqual({ type: "disabled" });
    expect("temperature" in sent).toBe(false);
    expect(sent.model).toBe("kimi-k2.6");
    expect(sent.max_tokens).toBe(64);
    expect(sent.messages[0]).toEqual({ role: "system", content: "be brief" });
  });

  it("explicit thinking=enabled is honoured; openai host sends no thinking field at all", async () => {
    const stub = vi.fn(async () => chatCompletion("x"));
    vi.stubGlobal("fetch", stub);
    await new StandaloneLLMRunner({
      config: { baseUrl: "https://api.moonshot.ai/v1", apiKey: "k", model: "kimi-k2.7-code-highspeed", thinking: "enabled" },
    }).run({ prompt: "p", taskId: "t" });
    await new StandaloneLLMRunner({
      config: { baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-5.4-mini", omitTemperature: true },
    }).run({ prompt: "p", taskId: "t" });
    const first = JSON.parse((stub.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const second = JSON.parse((stub.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(first.thinking).toEqual({ type: "enabled" });
    expect("thinking" in second).toBe(false);
    expect("temperature" in second).toBe(false);
  });
});
