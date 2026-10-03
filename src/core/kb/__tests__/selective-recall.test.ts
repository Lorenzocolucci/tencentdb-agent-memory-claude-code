/**
 * Phase 3 building blocks: what counts as evidence, the relevance gate, the capped
 * associative tail, the per-session de-dup log, the chronic-noise cache.
 * NON-circular: each case states the behaviour the live audit asked for.
 */
import { describe, it, expect } from "vitest";
import {
  ChronicNoiseCache,
  RecentInjectionLog,
  distinctiveTokens,
  evidencePoints,
  projectsConflict,
  relevanceScore,
  resolveSelective,
  selectAssociative,
  totalPoints,
  withSubject,
} from "../selective-recall.js";
import { parseConfig } from "../../../config.js";

const GATE = { minPoints: 4, anchoredMinPoints: 3 };

describe("distinctiveTokens", () => {
  it("keeps whole words of 4+ chars and drops filler, short words and numbers", () => {
    expect(distinctiveTokens("Ciao, ok procedi: ricrea i template del WABA 2026 per favore")).toEqual([
      "ricrea", "template", "waba",
    ]);
  });
  it("a prompt made only of filler has no distinctive words (so it retrieves nothing)", () => {
    expect(distinctiveTokens("ok procedi adesso, grazie")).toEqual([]);
  });
  it("folds diacritics and case, de-duplicates, and caps long pasted prompts", () => {
    expect(distinctiveTokens("Gateway GATEWAY gatewày")).toEqual(["gateway"]);
    const long = Array.from({ length: 60 }, (_, i) => `parola${i}x`).join(" ");
    expect(distinctiveTokens(long).length).toBe(14);
  });
});

describe("evidence points and the relevance gate", () => {
  const rare = new Set(["waba"]);
  it("a rare word is worth 2 points, a common one 1; only whole words count", () => {
    expect(evidencePoints(["waba", "template"], "creati template sul nuovo WABA", rare)).toBe(3);
    expect(evidencePoints(["gate"], "il gateway è su", rare)).toBe(0); // substring is not a word
    expect(totalPoints(["waba", "template", "piano"], rare)).toBe(4);
  });
  it("one shared generic word is NOT a lexical match; enough shared evidence is", () => {
    const base = { entityMatch: false, ftsScore: 0.8, maxPoints: 8 };
    expect(relevanceScore({ ...base, points: 1 }, GATE)).toBe(0);
    expect(relevanceScore({ ...base, points: 3 }, GATE)).toBe(0); // un-anchored needs 4
    expect(relevanceScore({ ...base, points: 4 }, GATE)).toBeGreaterThan(0.45);
  });
  it("an entity named by the prompt lowers the evidence needed (anchored)", () => {
    const e = { entityMatch: true, ftsScore: 0.8, maxPoints: 8 };
    expect(relevanceScore({ ...e, points: 2 }, GATE)).toBe(0);
    expect(relevanceScore({ ...e, points: 3 }, GATE)).toBeGreaterThan(0.45);
  });
  // 2026-10-03 (approved by Lorenzo): reversed. Live, a bare cosine of ~0.8 matched
  // unrelated memories for short prompts ("Riprova"); without lexical evidence a
  // vector hit needs a richer prompt and a cosine >= VECTOR_ONLY_MIN_COSINE.
  it("a vector hit without lexical evidence does not inject at a mid cosine", () => {
    expect(relevanceScore({ entityMatch: false, cosine: 0.71, points: 0, maxPoints: 3 }, GATE)).toBe(0);
  });
  it("the score is a real number, not the old constant 0.50 for every rank-0 hit", () => {
    const hi = relevanceScore({ entityMatch: false, ftsScore: 0.95, points: 6, maxPoints: 6 }, GATE);
    const lo = relevanceScore({ entityMatch: false, ftsScore: 0.5, points: 4, maxPoints: 9 }, GATE);
    expect(hi).toBeGreaterThan(lo);
    expect(hi).not.toBeCloseTo(0.5, 2);
  });
});

describe("projectsConflict", () => {
  it("different non-empty labels conflict, case-insensitively; empty (user-level) never does", () => {
    expect(projectsConflict("Sofia-AI", "Tutor-Agent")).toBe(true);
    expect(projectsConflict("Sofia-AI", "sofia-ai")).toBe(false);
    expect(projectsConflict("", "Tutor-Agent")).toBe(false);
    expect(projectsConflict("Sofia-AI", undefined)).toBe(false);
  });
  it("a generic label (web, a worktree name) is not treated as unknown", () => {
    expect(projectsConflict("web", "IMMIGRATO-EXCEL")).toBe(true);
    expect(projectsConflict("wizardly-bassi-226986", "Sofia-AI")).toBe(true);
  });
});

describe("withSubject", () => {
  it("prefixes the subject unless the text already names it", () => {
    expect(withSubject("Sofia", "Deciso il piano")).toBe("Sofia — Deciso il piano");
    expect(withSubject("Sofia", "Sofia risponde in testo")).toBe("Sofia risponde in testo");
    expect(withSubject(undefined, "x")).toBe("x");
  });
});

describe("selectAssociative", () => {
  const cfg = { maxAssociative: 3, minAssociativeActivation: 0.3, minAssociativeSeeds: 2 };
  const item = (id: string, activation: number, seedCount?: number) => ({ id, activation, seedCount });
  it("normalizes against the strongest, drops weak ones and caps the tail", () => {
    const out = selectAssociative(
      [item("a", 0.8, 3), item("b", 0.6, 2), item("c", 0.5, 2), item("d", 0.4, 2), item("weak", 0.1, 4)],
      cfg,
    );
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(out[0]!.normalizedActivation).toBe(1);
    expect(out.every((x) => x.normalizedActivation >= 0.3)).toBe(true);
  });
  it("requires convergence: an item reached from one seed only is dropped", () => {
    expect(selectAssociative([item("a", 1, 1), item("b", 0.9, 2)], cfg).map((x) => x.id)).toEqual(["b"]);
  });
  it("nothing active → nothing", () => {
    expect(selectAssociative([], cfg)).toEqual([]);
    expect(selectAssociative([item("a", 0, 5)], cfg)).toEqual([]);
  });
});

describe("RecentInjectionLog", () => {
  it("remembers owners for the last N turns of a session, then lets them back in", () => {
    const log = new RecentInjectionLog(2);
    log.commit("s1", ["event:a"]);
    log.commit("s1", ["event:b"]);
    expect([...log.recent("s1")].sort()).toEqual(["event:a", "event:b"]);
    log.commit("s1", []); // a silent turn still ages the window
    expect([...log.recent("s1")]).toEqual(["event:b"]);
    log.commit("s1", []);
    expect(log.recent("s1").size).toBe(0);
  });
  it("sessions are independent and the number of sessions is bounded", () => {
    const log = new RecentInjectionLog(5, 2);
    log.commit("s1", ["x"]);
    log.commit("s2", ["y"]);
    log.commit("s3", ["z"]);
    expect(log.recent("s1").size).toBe(0); // evicted
    expect(log.recent("s3").has("z")).toBe(true);
  });
});

describe("ChronicNoiseCache", () => {
  const cfg = { chronicNoiseMinInjections: 20, chronicNoiseCacheMs: 600_000 };
  it("reads the ledger once per window and serves the cached set after", () => {
    let calls = 0;
    const store = { chronicNoiseOwnerKeys: (n: number) => { calls++; expect(n).toBe(20); return ["fact:f1"]; } };
    const cache = new ChronicNoiseCache();
    expect(cache.keys(store, cfg, 1_000).has("fact:f1")).toBe(true);
    cache.keys(store, cfg, 1_000 + 599_000);
    expect(calls).toBe(1);
    cache.keys(store, cfg, 1_000 + 601_000);
    expect(calls).toBe(2);
  });
  it("fails open: an unreadable ledger excludes nothing", () => {
    const cache = new ChronicNoiseCache();
    expect(cache.keys({ chronicNoiseOwnerKeys: () => { throw new Error("locked"); } }, cfg).size).toBe(0);
    expect(cache.keys({}, cfg).size).toBe(0);
  });
});

describe("resolveSelective / parseConfig", () => {
  it("parseConfig turns it ON by default with the plan's numbers", () => {
    const s = resolveSelective(parseConfig({}).recall);
    expect(s).not.toBeNull();
    expect(s).toMatchObject({ maxLines: 5, maxAssociative: 3, minAssociativeActivation: 0.3, minAssociativeSeeds: 2, maxFactsPerEntity: 2, dedupTurns: 10, chronicNoiseMinInjections: 20, chronicNoiseCacheMs: 600_000 });
  });
  it("can be rolled back by config, and a hand-built recall block is legacy", () => {
    expect(resolveSelective(parseConfig({ recall: { selective: { enabled: false } } }).recall)).toBeNull();
    expect(resolveSelective({})).toBeNull();
  });
});
