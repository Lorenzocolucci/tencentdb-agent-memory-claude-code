/**
 * Context Fingerprint (Idea 1) — situation similarity + tier classification.
 *
 * Matching is deterministic weighted overlap (no embeddings): files are the
 * spine (Jaccard), error signatures and an exact task-type match add weight.
 * Only axes that carry signal are counted, so when only files differ the score
 * IS the file Jaccard. classifyMatch maps a score to strong/medium/none — the
 * two-tier "voice" Lorenzo chose (assertive vs tentative vs silent).
 */

import { describe, it, expect } from "vitest";
import { scoreFingerprint, classifyMatch, type Fingerprint } from "../fingerprint-similarity.js";

const fp = (
  fileKeys: string[],
  errorSignatures: string[] = [],
  taskType = "",
): Fingerprint => ({ fileKeys, errorSignatures, taskType });

describe("scoreFingerprint", () => {
  it("scores 1 for identical files + matching task type", () => {
    expect(scoreFingerprint(fp(["a", "b"], [], "implement"), fp(["a", "b"], [], "implement"))).toBe(1);
  });

  it("scores file Jaccard when only files carry signal", () => {
    // {a,b} ∩ {a,c} = {a}; ∪ = {a,b,c} → 1/3
    expect(scoreFingerprint(fp(["a", "b"]), fp(["a", "c"]))).toBeCloseTo(1 / 3, 5);
  });

  it("scores 0 for fully disjoint files", () => {
    expect(scoreFingerprint(fp(["a"]), fp(["b"]))).toBe(0);
  });

  it("scores 0 when neither situation has any signal", () => {
    expect(scoreFingerprint(fp([]), fp([]))).toBe(0);
  });

  it("a matching error signature lifts a perfect file match to strong", () => {
    expect(scoreFingerprint(fp(["a"], ["e1"]), fp(["a"], ["e1"]))).toBe(1);
  });

  it("a task-type mismatch lowers but does not zero a perfect file match", () => {
    const s = scoreFingerprint(fp(["a"], [], "implement"), fp(["a"], [], "debug"));
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });

  it("ignores empty task type as an axis (no penalty)", () => {
    expect(scoreFingerprint(fp(["a", "b"]), fp(["a", "b"]))).toBe(1);
  });
});

describe("classifyMatch", () => {
  it("classifies at the default boundaries (strong>=0.6, medium>=0.3)", () => {
    expect(classifyMatch(0.6)).toBe("strong");
    expect(classifyMatch(0.59)).toBe("medium");
    expect(classifyMatch(0.3)).toBe("medium");
    expect(classifyMatch(0.29)).toBe("none");
    expect(classifyMatch(0)).toBe("none");
  });

  it("honors custom thresholds", () => {
    expect(classifyMatch(0.5, { strong: 0.9, medium: 0.4 })).toBe("medium");
    expect(classifyMatch(0.95, { strong: 0.9, medium: 0.4 })).toBe("strong");
  });
});
