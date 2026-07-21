import { describe, it, expect } from "vitest";
import {
  nameTokens,
  nameSimilarity,
  cosine,
  aggregateEntityVector,
  classifyBand,
  findCandidatePairs,
  buildClusters,
  type RecEntity,
  type CandidatePair,
} from "../entity-reconciliation.js";

const vec = (...xs: number[]) => Float32Array.from(xs);

describe("nameTokens", () => {
  it("lowercases, keeps len>=3 alnum, drops stopwords + dups", () => {
    expect(nameTokens("costi di OpenAI")).toEqual(["costi", "openai"]);
    expect(nameTokens("OpenAI OpenAI")).toEqual(["openai"]);
    expect(nameTokens("A e il")).toEqual([]);
  });
});

describe("nameSimilarity", () => {
  it("exact normalized match → 1", () => {
    expect(nameSimilarity("OpenAI", "openai")).toBe(1);
  });
  it("partial token overlap → Jaccard", () => {
    expect(nameSimilarity("costi OpenAI", "OpenAI")).toBeCloseTo(0.5, 6); // {costi,openai} ∩ {openai} = 1/2
  });
  it("no overlap → 0", () => {
    expect(nameSimilarity("Sofia", "OpenAI")).toBe(0);
  });
  it("numeric/version tokens DISCRIMINATE (not treated as identical)", () => {
    // {gpt,4} vs {gpt,3,5} → 1/4 = 0.25, NOT 1.0
    expect(nameSimilarity("GPT-4", "GPT-3.5")).toBeLessThan(0.5);
    // {sessione} vs {sessione,13} → 0.5, NOT 1.0
    expect(nameSimilarity("sessione", "sessione 13")).toBeCloseTo(0.5, 6);
    // pure case/spacing variants stay 1.0
    expect(nameSimilarity("GPT-4", "gpt 4")).toBe(1);
  });
});

describe("cosine", () => {
  it("identical direction → 1, orthogonal → 0", () => {
    expect(cosine(vec(1, 0, 0), vec(2, 0, 0))).toBeCloseTo(1, 6);
    expect(cosine(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 6);
  });
  it("length mismatch or zero vector → 0 (never NaN)", () => {
    expect(cosine(vec(1, 0), vec(1, 0, 0))).toBe(0);
    expect(cosine(vec(0, 0), vec(1, 1))).toBe(0);
  });
});

describe("aggregateEntityVector", () => {
  it("mean-pools then L2-normalizes", () => {
    const out = aggregateEntityVector([vec(1, 0), vec(0, 1)])!;
    // mean = (0.5,0.5) → normalized ≈ (0.707,0.707)
    expect(out[0]).toBeCloseTo(0.7071, 3);
    expect(out[1]).toBeCloseTo(0.7071, 3);
  });
  it("empty → null", () => {
    expect(aggregateEntityVector([])).toBeNull();
  });
});

describe("classifyBand", () => {
  it("respects 0.95 / 0.85 boundaries", () => {
    expect(classifyBand(0.96)).toBe("auto");
    expect(classifyBand(0.95)).toBe("auto");
    expect(classifyBand(0.9)).toBe("ask");
    expect(classifyBand(0.85)).toBe("ask");
    expect(classifyBand(0.84)).toBe("skip");
  });
});

describe("findCandidatePairs", () => {
  const ents: RecEntity[] = [
    { id: "e1", type: "topic", name: "OpenAI", importance: 50, vector: vec(1, 0, 0) },
    { id: "e2", type: "topic", name: "openai", importance: 50, vector: vec(1, 0, 0) }, // dup name → auto
    { id: "e3", type: "topic", name: "costi OpenAI", importance: 50, vector: vec(0.98, 0.2, 0) }, // shares "openai" token, high cosine → ask/auto via cosine
    { id: "e4", type: "topic", name: "Sofia", importance: 50, vector: vec(0, 1, 0) }, // no shared token → not compared
    { id: "e5", type: "person", name: "OpenAI", importance: 50, vector: vec(1, 0, 0) }, // different TYPE → not merged with e1
  ];

  it("blocks by same-type + shared token, bands by max(cosine,nameSim)", () => {
    const { pairs } = findCandidatePairs(ents);
    // e1/e2 exact name → auto. e1/e3 & e2/e3 via shared "openai" token + cosine.
    const key = (p: { aId: string; bId: string }) => [p.aId, p.bId].sort().join("|");
    const got = new Set(pairs.map(key));
    expect(got.has("e1|e2")).toBe(true);
    expect(pairs.find((p) => key(p) === "e1|e2")!.band).toBe("auto");
    expect(got.has("e1|e3") || got.has("e2|e3")).toBe(true);
    // Cross-type OpenAI (e5) is never paired with e1 (different type).
    expect(got.has("e1|e5")).toBe(false);
    // Sofia shares no token → never compared.
    expect([...got].some((k) => k.includes("e4"))).toBe(false);
  });

  it("dedups a pair that shares multiple tokens (emitted once)", () => {
    const two: RecEntity[] = [
      { id: "a", type: "t", name: "Studio Immigrato Milano", importance: 50, vector: null },
      { id: "b", type: "t", name: "Studio Immigrato Milano", importance: 50, vector: null },
    ];
    const { pairs } = findCandidatePairs(two);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].band).toBe("auto"); // identical names → nameSim 1
  });

  it("clusters transitively via connected components; ask edge makes cluster 'ask'", () => {
    const pair = (aId: string, bId: string, band: "auto" | "ask", score: number): CandidatePair => ({
      aId, bId, aName: aId, bName: bId, type: "topic", cosine: score, nameSim: score, score, band,
    });
    // Component 1: a~b~c all auto → auto cluster of 3.
    // Component 2: x~y auto, y~z ask → ask cluster of 3 (one ask edge taints it).
    const clusters = buildClusters([
      pair("a", "b", "auto", 0.99),
      pair("b", "c", "auto", 0.97),
      pair("x", "y", "auto", 0.98),
      pair("y", "z", "ask", 0.9),
    ]);
    expect(clusters).toHaveLength(2);
    const byMembers = (m: string) => clusters.find((c) => c.members.includes(m))!;
    expect(byMembers("a").members).toEqual(["a", "b", "c"]);
    expect(byMembers("a").band).toBe("auto");
    expect(byMembers("x").members).toEqual(["x", "y", "z"]);
    expect(byMembers("x").band).toBe("ask"); // one ask edge → whole cluster asks
  });

  it("drops glue tokens (high doc-freq) from blocking to prevent transitive drift", () => {
    // "token" is shared by many (glue); "openai"/"stripe" are rare (distinctive).
    const ents: RecEntity[] = [
      { id: "o1", type: "c", name: "OpenAI token", importance: 50, vector: null },
      { id: "o2", type: "c", name: "OpenAI key", importance: 50, vector: null },
      { id: "s1", type: "c", name: "Stripe token", importance: 50, vector: null },
      { id: "s2", type: "c", name: "Stripe secret", importance: 50, vector: null },
      { id: "x1", type: "c", name: "Twilio token", importance: 50, vector: null },
    ];
    // With maxDocFreq=2, "token" (df=3) is glue → dropped. o1~s1~x1 must NOT link.
    const { pairs, droppedGlueTokens } = findCandidatePairs(ents, { maxDocFreq: 2, askThreshold: 0.3 });
    expect(droppedGlueTokens.some((g) => g.token === "token" && g.docFreq === 3)).toBe(true);
    // "openai" (df=2) still blocks o1~o2; no cross-vendor pair via "token".
    const linked = (a: string, b: string) =>
      pairs.some((p) => (p.aId === a && p.bId === b) || (p.aId === b && p.bId === a));
    expect(linked("o1", "s1")).toBe(false); // NOT linked via glue "token"
    expect(linked("s1", "x1")).toBe(false);
  });

  it("reports oversized blocks instead of silently skipping (no O(n²) blowup)", () => {
    const many: RecEntity[] = Array.from({ length: 10 }, (_, i) => ({
      id: `x${i}`, type: "t", name: `shared token${i}`, importance: 50, vector: null,
    }));
    const { pairs, skippedBlocks } = findCandidatePairs(many, { maxBlockSize: 5 });
    // All 10 share the token "shared" → one block of 10 > 5 → skipped + reported.
    expect(skippedBlocks.some((b) => b.key.endsWith("shared") && b.size === 10)).toBe(true);
    expect(pairs.every((p) => !p.aName.includes("shared") || p.nameSim < 1)).toBe(true);
  });
});
