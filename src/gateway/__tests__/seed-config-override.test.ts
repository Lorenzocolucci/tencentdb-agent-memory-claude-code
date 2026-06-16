/**
 * Security regression test for FIX 3 — /seed config_override credential/endpoint
 * exfiltration (key exfil / SSRF).
 *
 * BUG: the /seed handler deep-merged arbitrary body.config_override into the
 * resolved pluginConfig, which carries the llm/embedding apiKey + baseUrl. An
 * authenticated caller could override llm.baseUrl to redirect traffic (and the
 * bundled API key) to an attacker-controlled server.
 *
 * FIX: sanitizeConfigOverride() strips apiKey / baseUrl / proxyUrl from the llm
 * and embedding sub-objects of config_override before the merge. This test
 * verifies the sanitizer AND the resulting merge: the resolved llm.baseUrl /
 * apiKey come from the base config, NOT from the override.
 */
import { describe, it, expect } from "vitest";
import { sanitizeConfigOverride } from "../server.js";

describe("sanitizeConfigOverride — strips credential/endpoint keys", () => {
  it("removes apiKey / baseUrl / proxyUrl from llm and embedding sub-objects", () => {
    const override = {
      llm: { baseUrl: "https://evil.example/v1", apiKey: "stolen", model: "x", maxTokens: 4096 },
      embedding: { baseUrl: "https://evil.example/emb", apiKey: "stolen2", dimensions: 1024 },
      extraction: { maxMemoriesPerSession: 200 },
    };
    const { sanitized, stripped } = sanitizeConfigOverride(override);

    // Forbidden keys gone from the sanitized copy.
    expect((sanitized.llm as Record<string, unknown>).baseUrl).toBeUndefined();
    expect((sanitized.llm as Record<string, unknown>).apiKey).toBeUndefined();
    expect((sanitized.embedding as Record<string, unknown>).baseUrl).toBeUndefined();
    expect((sanitized.embedding as Record<string, unknown>).apiKey).toBeUndefined();

    // Safe tuning keys preserved.
    expect((sanitized.llm as Record<string, unknown>).model).toBe("x");
    expect((sanitized.llm as Record<string, unknown>).maxTokens).toBe(4096);
    expect((sanitized.embedding as Record<string, unknown>).dimensions).toBe(1024);
    expect((sanitized.extraction as Record<string, unknown>).maxMemoriesPerSession).toBe(200);

    // Stripped paths reported (for the security log).
    expect(stripped).toContain("llm.baseUrl");
    expect(stripped).toContain("llm.apiKey");
    expect(stripped).toContain("embedding.baseUrl");
    expect(stripped).toContain("embedding.apiKey");

    // Input not mutated (immutability).
    expect(override.llm.baseUrl).toBe("https://evil.example/v1");
  });

  it("is a no-op for empty / missing override", () => {
    expect(sanitizeConfigOverride(undefined).stripped).toEqual([]);
    expect(sanitizeConfigOverride(null).stripped).toEqual([]);
    expect(sanitizeConfigOverride({}).sanitized).toEqual({});
  });

  it("after merge, llm.baseUrl/apiKey come from the BASE config, not the override", () => {
    // Reproduce the handler's merge with a sanitized override.
    const baseConfig: Record<string, unknown> = {
      llm: {
        enabled: true,
        baseUrl: "https://api.moonshot.cn/v1", // resolved gateway value
        apiKey: "REAL-GATEWAY-KEY",
        model: "kimi",
        maxTokens: 4096,
      },
    };
    const attackerOverride = {
      llm: { baseUrl: "https://evil.example/v1", apiKey: "ATTACKER-KEY", maxTokens: 8192 },
    };

    const { sanitized } = sanitizeConfigOverride(attackerOverride);

    // Same deep-merge the handler performs.
    const merged: Record<string, unknown> = { ...baseConfig };
    for (const key of Object.keys(sanitized)) {
      const baseVal = merged[key];
      const overVal = sanitized[key];
      if (baseVal && typeof baseVal === "object" && !Array.isArray(baseVal) &&
          overVal && typeof overVal === "object" && !Array.isArray(overVal)) {
        merged[key] = { ...(baseVal as Record<string, unknown>), ...(overVal as Record<string, unknown>) };
      } else {
        merged[key] = overVal;
      }
    }

    const mergedLlm = merged.llm as Record<string, unknown>;
    // Endpoint + key must NOT have been hijacked.
    expect(mergedLlm.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(mergedLlm.apiKey).toBe("REAL-GATEWAY-KEY");
    // A legitimate, non-credential tuning override still applies.
    expect(mergedLlm.maxTokens).toBe(8192);
  });
});
