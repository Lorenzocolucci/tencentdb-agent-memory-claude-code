/**
 * Three-tier token weighting (an IDF approximation): a word few KB documents mention is
 * worth 2 points, an ordinary one 1, and a word thousands of documents mention ("deploy",
 * "test", "agent" in a coding memory) only half — it is in every project's history, so
 * sharing it is weak evidence. The third tier is optional: without the set, scores are
 * exactly the two-tier ones.
 */
import { describe, expect, it } from "vitest";
import { evidencePoints, totalPoints, VERY_COMMON_TOKEN_POINTS } from "../selective-recall.js";

describe("three-tier token weights", () => {
  const tokens = ["waba", "deploy", "template"];
  const rare = new Set(["waba"]);
  const veryCommon = new Set(["deploy"]);

  it("a very common word is worth half a point", () => {
    expect(VERY_COMMON_TOKEN_POINTS).toBe(0.5);
    expect(evidencePoints(tokens, "deploy del template", rare, veryCommon)).toBe(1.5);
    expect(evidencePoints(tokens, "waba deploy template", rare, veryCommon)).toBe(3.5);
    expect(totalPoints(tokens, rare, veryCommon)).toBe(3.5);
  });

  it("without the very-common set the weights are the old two-tier ones", () => {
    expect(evidencePoints(tokens, "deploy del template", rare)).toBe(2);
    expect(totalPoints(tokens, rare)).toBe(4);
  });

  it("rare wins if a word is in both sets", () => {
    expect(evidencePoints(["waba"], "waba", rare, new Set(["waba"]))).toBe(2);
  });
});
