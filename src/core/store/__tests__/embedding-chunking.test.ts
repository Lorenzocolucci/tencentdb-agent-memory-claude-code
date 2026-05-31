import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIEmbeddingService } from "../embedding.js";

const DIMS = 4;

/**
 * Stub the global fetch with an OpenAI-compatible embeddings response that
 * returns ONE vector per input text (the real API contract).  This lets us
 * assert the chunk cardinality embedChunks() produces.
 */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
    const data = body.input.map((_text, index) => ({
      index,
      embedding: Array.from({ length: DIMS }, (_v, i) => (i + 1) / 10 + index * 0.01),
    }));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data }),
      text: async () => "",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function makeService(overrides: Record<string, unknown> = {}): OpenAIEmbeddingService {
  return new OpenAIEmbeddingService({
    provider: "openai",
    baseUrl: "https://api.test/v1",
    apiKey: "test-key",
    model: "text-embedding-3-small",
    dimensions: DIMS,
    chunkSize: 2000,
    chunkOverlap: 200,
    maxChunksPerText: 50,
    ...overrides,
  });
}

describe("OpenAIEmbeddingService.embedChunks", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    // The last fetch call's inputs together must cover beyond the old 5000 cap.
    const allInputs = fetchMock.mock.calls.flatMap(
      (c) => (JSON.parse(String((c[1] as { body: string }).body)).input as string[]),
    );
    const totalChars = allInputs.reduce((s, t) => s + t.length, 0);
    // With overlap the summed chunk length exceeds the original (proves full coverage + overlap).
    expect(totalChars).toBeGreaterThan(5001);
  });
});
