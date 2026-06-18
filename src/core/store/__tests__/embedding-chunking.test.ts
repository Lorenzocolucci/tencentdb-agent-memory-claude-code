import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent } from "undici";
import { OpenAIEmbeddingService } from "../embedding.js";

const DIMS = 4;

/**
 * Capture of one POST /embeddings call body, so tests can assert what inputs
 * were actually sent (mirrors the old fetchMock.mock.calls inspection).
 */
const sentInputs: string[][] = [];

/**
 * Build an undici MockAgent that answers POST /v1/embeddings with an
 * OpenAI-compatible response returning ONE vector per input text (the real API
 * contract). The service no longer uses global fetch — it uses undici.request
 * with an injected dispatcher — so we mock at the dispatcher layer instead.
 */
function makeMockAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get("https://api.test");
  pool
    .intercept({ path: "/v1/embeddings", method: "POST" })
    .reply(200, (opts) => {
      const body = JSON.parse(String(opts.body ?? "{}")) as { input: string[] };
      sentInputs.push(body.input);
      return {
        data: body.input.map((_text, index) => ({
          index,
          embedding: Array.from({ length: DIMS }, (_v, i) => (i + 1) / 10 + index * 0.01),
        })),
      };
    })
    .persist();
  return agent;
}

let mockAgent: MockAgent;

function makeService(overrides: Record<string, unknown> = {}): OpenAIEmbeddingService {
  return new OpenAIEmbeddingService(
    {
      provider: "openai",
      baseUrl: "https://api.test/v1",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: DIMS,
      chunkSize: 2000,
      chunkOverlap: 200,
      maxChunksPerText: 50,
      ...overrides,
    },
    undefined,
    () => mockAgent,
  );
}

describe("OpenAIEmbeddingService.embedChunks", () => {
  beforeEach(() => {
    sentInputs.length = 0;
    mockAgent = makeMockAgent();
  });

  afterEach(async () => {
    await mockAgent.close();
  });

  it("a >5000-char text produces MULTIPLE chunk vectors", async () => {
    const svc = makeService();
    const longText = "x".repeat(5001);
    const vectors = await svc.embedChunks(longText);
    // chunkSize 2000, overlap 200 → stride 1800 → 3 chunks for 5001 chars.
    expect(vectors.length).toBeGreaterThan(1);
    for (const v of vectors) expect(v).toHaveLength(DIMS);
  });

  it("a short text produces exactly ONE chunk vector", async () => {
    const svc = makeService();
    const vectors = await svc.embedChunks("a short memory");
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(DIMS);
  });

  it("empty input produces zero chunk vectors", async () => {
    const svc = makeService();
    expect(await svc.embedChunks("")).toEqual([]);
    expect(await svc.embedChunks("   ")).toEqual([]);
  });

  it("warns and bounds output when maxChunksPerText cap is hit (no silent drop)", async () => {
    const warnings: string[] = [];
    const svc = new OpenAIEmbeddingService(
      {
        provider: "openai",
        baseUrl: "https://api.test/v1",
        apiKey: "k",
        model: "m",
        dimensions: DIMS,
        chunkSize: 100,
        chunkOverlap: 0,
        maxChunksPerText: 3,
      },
      { info: () => {}, warn: (m) => warnings.push(m), error: () => {}, debug: () => {} },
      () => mockAgent,
    );
    const vectors = await svc.embedChunks("q".repeat(1000)); // needs 10 chunks, capped at 3
    expect(vectors).toHaveLength(3);
    expect(warnings.some((w) => /maxChunks=3/.test(w))).toBe(true);
  });

  it("embed() still returns a SINGLE vector (backward-compatible)", async () => {
    const svc = makeService();
    const v = await svc.embed("x".repeat(5001));
    expect(v).toHaveLength(DIMS);
  });

  it("does not silently truncate: long text covered by chunks reflects in fetch input", async () => {
    const svc = makeService();
    await svc.embedChunks("x".repeat(5001));
    // The request inputs together must cover beyond the old 5000 cap.
    const allInputs = sentInputs.flat();
    const totalChars = allInputs.reduce((s, t) => s + t.length, 0);
    // With overlap the summed chunk length exceeds the original (proves full coverage + overlap).
    expect(totalChars).toBeGreaterThan(5001);
  });
});
