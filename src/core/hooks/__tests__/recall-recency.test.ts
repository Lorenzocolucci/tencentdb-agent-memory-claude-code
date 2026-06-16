import { describe, it, expect } from "vitest";
import {
  recencyDecay,
  applyRecencyBoost,
  RECENCY_WEIGHT,
  RECENCY_HALFLIFE_DAYS,
} from "../auto-recall.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("recencyDecay (RC3)", () => {
  const now = Date.parse("2026-06-16T00:00:00.000Z");

  it("returns 0 for missing or unparseable timestamps (relevance-only, never NaN)", () => {
    expect(recencyDecay(undefined, now)).toBe(0);
    expect(recencyDecay("", now)).toBe(0);
    expect(recencyDecay("not-a-date", now)).toBe(0);
  });

  it("returns ~1 for a memory created 'now'", () => {
    expect(recencyDecay(new Date(now).toISOString(), now)).toBeCloseTo(1, 5);
  });

  it("returns 0.5 at exactly one half-life", () => {
    const halfLifeAgo = new Date(now - RECENCY_HALFLIFE_DAYS * MS_PER_DAY).toISOString();
    expect(recencyDecay(halfLifeAgo, now)).toBeCloseTo(0.5, 5);
  });

  it("decays monotonically toward 0 as the memory ages", () => {
    const day10 = recencyDecay(new Date(now - 10 * MS_PER_DAY).toISOString(), now);
    const day40 = recencyDecay(new Date(now - 40 * MS_PER_DAY).toISOString(), now);
    const day100 = recencyDecay(new Date(now - 100 * MS_PER_DAY).toISOString(), now);
    expect(day10).toBeGreaterThan(day40);
    expect(day40).toBeGreaterThan(day100);
    expect(day100).toBeGreaterThan(0);
    expect(day100).toBeLessThan(0.1);
  });

  it("clamps future timestamps to a max factor of 1 (no >1 boost)", () => {
    const future = new Date(now + 100 * MS_PER_DAY).toISOString();
    expect(recencyDecay(future, now)).toBe(1);
  });
});

describe("applyRecencyBoost (RC3)", () => {
  const now = Date.parse("2026-06-16T00:00:00.000Z");

  it("leaves the RRF score unchanged when there is no timestamp", () => {
    expect(applyRecencyBoost(0.5, undefined, now)).toBe(0.5);
  });

  it("boosts a brand-new memory by at most RECENCY_WEIGHT", () => {
    const boosted = applyRecencyBoost(0.5, new Date(now).toISOString(), now);
    expect(boosted).toBeCloseTo(0.5 * (1 + RECENCY_WEIGHT), 5);
  });

  it("keeps relevance primary: a much-more-relevant old memory still outranks a barely-relevant new one", () => {
    // Old but high relevance vs. new but low relevance.
    const oldHighRrf = 0.9;
    const newLowRrf = 0.5;
    const oldTs = new Date(now - 365 * MS_PER_DAY).toISOString();
    const newTs = new Date(now).toISOString();
    const oldRanked = applyRecencyBoost(oldHighRrf, oldTs, now);
    const newRanked = applyRecencyBoost(newLowRrf, newTs, now);
    expect(oldRanked).toBeGreaterThan(newRanked);
  });

  it("acts as a tiebreaker: among equal-relevance results, the newer one ranks higher", () => {
    const rrf = 0.5;
    const newer = applyRecencyBoost(rrf, new Date(now - 1 * MS_PER_DAY).toISOString(), now);
    const older = applyRecencyBoost(rrf, new Date(now - 200 * MS_PER_DAY).toISOString(), now);
    expect(newer).toBeGreaterThan(older);
  });
});
