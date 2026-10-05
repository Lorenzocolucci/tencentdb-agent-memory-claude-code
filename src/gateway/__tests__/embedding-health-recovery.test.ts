/**
 * Live 05/10/2026: /health said embedding "failing" for minutes after DeepInfra answered
 * 200 again — an open breaker returned "failing" without probing, and only a successful
 * call closes it. Exercises the real checkEmbeddingLiveness with a fake embedding service.
 */
import { describe, it, expect } from "vitest";
import { TdaiGateway } from "../server.js";

function gatewayWith(svc: { embed: () => Promise<number[]>; getHealth: () => { healthy: boolean } }) {
  const g = Object.create(TdaiGateway.prototype) as Record<string, unknown>;
  g.core = { getEmbeddingService: () => svc };
  g.logger = { warn() {}, info() {}, error() {} };
  g.embeddingHealthCache = null;
  g.embeddingProbeInFlight = null;
  return g as unknown as { checkEmbeddingLiveness(): Promise<boolean>; embeddingHealthCache: { ok: boolean; at: number } | null };
}

describe("embedding health recovers from an open breaker", () => {
  it("probes despite an open breaker, and a successful probe reports healthy", async () => {
    let open = true;
    let probes = 0;
    const g = gatewayWith({
      embed: async () => { probes++; open = false; return [0.1, 0.2]; }, // success closes the breaker
      getHealth: () => ({ healthy: !open }),
    });
    expect(await g.checkEmbeddingLiveness()).toBe(true);
    expect(probes).toBe(1);
  });

  it("while the last probe is fresh, an open breaker is authoritative (no probe storm)", async () => {
    let probes = 0;
    const g = gatewayWith({ embed: async () => { probes++; return [0.1]; }, getHealth: () => ({ healthy: false }) });
    g.embeddingHealthCache = { ok: true, at: Date.now() };
    expect(await g.checkEmbeddingLiveness()).toBe(false);
    expect(probes).toBe(0);
  });

  it("a failing probe still reports failing", async () => {
    const g = gatewayWith({ embed: async () => { throw new Error("timeout"); }, getHealth: () => ({ healthy: false }) });
    expect(await g.checkEmbeddingLiveness()).toBe(false);
  });
});
