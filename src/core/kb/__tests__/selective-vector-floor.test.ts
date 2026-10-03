import { describe, it, expect } from "vitest";
import { relevanceScore } from "../selective-recall.js";

// Live 2026-10-03: the one-word prompt "Riprova" pulled 5 unrelated events at
// cosine ~0.81-0.83 ("Inizio della reindezazione", "... — Procedi"). Qwen3-4B
// cosines for short prompts sit high across the board, so a raw cosine is not
// evidence by itself.
describe("vector-only hits need a meaningful prompt and a high cosine", () => {
  const gate = { minPoints: 2, anchoredMinPoints: 2 };

  it("a one-word prompt never injects on cosine alone", () => {
    expect(relevanceScore({ cosine: 0.83, entityMatch: false, points: 0, maxPoints: 1 }, gate)).toBe(0);
    expect(relevanceScore({ cosine: 0.95, entityMatch: false, points: 0, maxPoints: 2 }, gate)).toBe(0);
  });

  it("a richer prompt still needs a cosine above the vector-only floor", () => {
    expect(relevanceScore({ cosine: 0.82, entityMatch: false, points: 0, maxPoints: 5 }, gate)).toBe(0);
    expect(relevanceScore({ cosine: 0.9, entityMatch: false, points: 0, maxPoints: 5 }, gate)).toBeCloseTo(0.9);
  });

  it("lexical evidence keeps working and may still use the cosine", () => {
    const s = relevanceScore({ cosine: 0.83, ftsScore: 0.9, entityMatch: false, points: 4, maxPoints: 5 }, gate);
    expect(s).toBeGreaterThanOrEqual(0.83);
  });
});
