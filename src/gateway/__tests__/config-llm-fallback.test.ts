/**
 * Gateway config — `llm.fallback` and `llm.thinking` plumbing (2026-09-05).
 *
 * Before this the fallback was read straight from process.env inside tdai-core
 * and was invisible to the config layer. Each test pins TDAI_GATEWAY_CONFIG to
 * its own temp file so the live yaml in the default data dir is never read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGatewayConfig } from "../config.js";

const FALLBACK_ENV = [
  "TDAI_FALLBACK_LLM_BASE_URL",
  "TDAI_FALLBACK_LLM_API_KEY",
  "TDAI_FALLBACK_LLM_MODEL",
  "TDAI_FALLBACK_LLM_MAX_TOKENS",
  "TDAI_FALLBACK_LLM_TIMEOUT_MS",
  "TDAI_FALLBACK_LLM_THINKING",
  "TDAI_LLM_THINKING",
  "TDAI_LLM_BASE_URL",
  "OPENAI_API_KEY",
];

let dir: string;

function writeYaml(text: string): void {
  const p = path.join(dir, "tdai-gateway.yaml");
  fs.writeFileSync(p, text, "utf-8");
  vi.stubEnv("TDAI_GATEWAY_CONFIG", p);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cfg-"));
  for (const k of FALLBACK_ENV) vi.stubEnv(k, "");
  writeYaml("llm:\n  model: primary-model\n");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadGatewayConfig — llm.fallback", () => {
  it("no key anywhere → no fallback (fail-closed, as before)", () => {
    const cfg = loadGatewayConfig();
    expect(cfg.llm.fallback).toBeUndefined();
  });

  it("OPENAI_API_KEY alone enables the default fallback: openai / gpt-5.4-mini / temperature omitted", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    const cfg = loadGatewayConfig();
    expect(cfg.llm.fallback).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-openai",
      model: "gpt-5.4-mini",
      omitTemperature: true,
      maxTokens: undefined,
      timeoutMs: undefined,
      thinking: undefined,
    });
  });

  it("TDAI_FALLBACK_LLM_* env vars override the defaults and win over OPENAI_API_KEY", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("TDAI_FALLBACK_LLM_API_KEY", "k-fb");
    vi.stubEnv("TDAI_FALLBACK_LLM_BASE_URL", "https://api.moonshot.ai/v1");
    vi.stubEnv("TDAI_FALLBACK_LLM_MODEL", "kimi-k3");
    vi.stubEnv("TDAI_FALLBACK_LLM_MAX_TOKENS", "2000");
    vi.stubEnv("TDAI_FALLBACK_LLM_THINKING", "disabled");
    const cfg = loadGatewayConfig();
    expect(cfg.llm.fallback).toMatchObject({
      baseUrl: "https://api.moonshot.ai/v1",
      apiKey: "k-fb",
      model: "kimi-k3",
      maxTokens: 2000,
      thinking: "disabled",
      omitTemperature: true,
    });
  });

  it("the yaml llm.fallback block is accepted (env still wins per field)", () => {
    writeYaml(
      "llm:\n  model: primary-model\n  thinking: disabled\n  fallback:\n" +
        "    apiKey: yaml-key\n    model: yaml-model\n    baseUrl: https://yaml.example/v1\n" +
        "    omitTemperature: false\n    timeoutMs: 5000\n",
    );
    vi.stubEnv("TDAI_FALLBACK_LLM_MODEL", "env-model");
    const cfg = loadGatewayConfig();
    expect(cfg.llm.thinking).toBe("disabled");
    expect(cfg.llm.fallback).toMatchObject({
      apiKey: "yaml-key",
      model: "env-model",
      baseUrl: "https://yaml.example/v1",
      omitTemperature: false,
      timeoutMs: 5000,
    });
  });
});

describe("loadGatewayConfig — llm.thinking", () => {
  it("is undefined by default (the runner decides by host) and parses only disabled/enabled", () => {
    expect(loadGatewayConfig().llm.thinking).toBeUndefined();
    vi.stubEnv("TDAI_LLM_THINKING", "Enabled");
    expect(loadGatewayConfig().llm.thinking).toBe("enabled");
    vi.stubEnv("TDAI_LLM_THINKING", "banana");
    expect(loadGatewayConfig().llm.thinking).toBeUndefined();
  });
});
