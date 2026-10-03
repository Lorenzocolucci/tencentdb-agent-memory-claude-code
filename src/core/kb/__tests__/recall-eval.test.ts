import { describe, expect, it } from "vitest";
import {
  ChronicNoiseTimeline,
  isMachinePrompt,
  scoreQuery,
  splitOf,
  stratifiedSample,
  summarize,
} from "../recall-eval.js";

describe("recall-eval: machine prompts", () => {
  it("drops harness-generated prompts and keeps typed ones", () => {
    expect(isMachinePrompt("<task-notification>\n<task-id>x</task-id>")).toBe(true);
    expect(isMachinePrompt("  <system-reminder>hi</system-reminder>")).toBe(true);
    expect(isMachinePrompt("[Request interrupted by user]")).toBe(true);
    expect(isMachinePrompt("perche il deploy di argus fallisce")).toBe(false);
    expect(isMachinePrompt("<3 grazie")).toBe(false);
  });
});

describe("recall-eval: deterministic split and sampling", () => {
  it("assigns the same split to the same key and roughly the requested share to holdout", () => {
    expect(splitOf("a", 7, 0.3)).toBe(splitOf("a", 7, 0.3));
    const keys = Array.from({ length: 2000 }, (_, i) => `q${i}`);
    const hold = keys.filter((k) => splitOf(k, 7, 0.3) === "holdout").length / keys.length;
    expect(hold).toBeGreaterThan(0.26);
    expect(hold).toBeLessThan(0.34);
  });

  it("the split is independent of the sampling order (a capped sample is not all holdout)", () => {
    const items = Array.from({ length: 2000 }, (_, i) => ({ p: `P${i % 5}`, k: `key-${i}` }));
    const s = stratifiedSample(items, (x) => x.p, (x) => x.k, { perProject: 100, minPerProject: 1, seed: 42 });
    const hold = s.filter((x) => splitOf(x.k, 42, 0.3) === "holdout").length / s.length;
    expect(hold).toBeGreaterThan(0.22);
    expect(hold).toBeLessThan(0.38);
  });

  it("caps per project, drops thin projects, and is stable for a seed", () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => ({ p: "A", k: `a${i}` })),
      ...Array.from({ length: 3 }, (_, i) => ({ p: "B", k: `b${i}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ p: "C", k: `c${i}` })),
    ];
    const opts = { perProject: 4, minPerProject: 5, seed: 1 };
    const s1 = stratifiedSample(items, (x) => x.p, (x) => x.k, opts);
    const s2 = stratifiedSample(items, (x) => x.p, (x) => x.k, opts);
    expect(s1).toEqual(s2);
    expect(s1.filter((x) => x.p === "A")).toHaveLength(4);
    expect(s1.filter((x) => x.p === "B")).toHaveLength(0);
    expect(s1.filter((x) => x.p === "C")).toHaveLength(4);
  });
});

describe("recall-eval: scoring", () => {
  const labels = new Map([
    ["event:e1", true],
    ["event:e2", false],
    ["fact:f1", true],
  ]);

  it("counts used and labeled returns; unlabeled returns are neither", () => {
    const s = scoreQuery(["event:e1", "event:e2", "fact:zz", "event:e1"], labels, { crossProject: 0, ms: 5 });
    expect(s).toMatchObject({ returned: 3, labeledReturned: 2, usedReturned: 1, used: 2 });
  });

  it("summarizes micro recall, precision, silence and latency", () => {
    const a = scoreQuery(["event:e1", "event:e2"], labels, { crossProject: 0, ms: 10 });
    const b = scoreQuery([], labels, { crossProject: 0, ms: 20 });
    const c = scoreQuery(["fact:x"], new Map(), { crossProject: 1, ms: 30 });
    const sum = summarize([a, b, c]);
    expect(sum.queries).toBe(3);
    expect(sum.recallUsed).toBeCloseTo(1 / 4, 4); // 1 used returned of 2+2 used
    expect(sum.turnRecall).toBeCloseTo(0.5, 4); // a hits, b misses; c has no used owner
    expect(sum.precision).toBeCloseTo(0.5, 4);
    expect(sum.silentPct).toBeCloseTo(33.3, 1);
    expect(sum.crossProjectLines).toBe(1);
    expect(sum.linesPerTurn).toBe(1);
  });

  it("eligible recall only counts the used owners recall may show (not another project's)", () => {
    const eligible = new Set(["event:e1"]); // f1 is labeled with another project
    const a = scoreQuery(["event:e1"], labels, { crossProject: 0, ms: 1, eligibleUsed: eligible });
    expect(a).toMatchObject({ used: 2, usedEligible: 1, usedEligibleReturned: 1 });
    const sum = summarize([a]);
    expect(sum.recallUsed).toBeCloseTo(0.5, 4);
    expect(sum.recallEligible).toBeCloseTo(1, 4);
  });

  it("judged precision covers every returned owner, labeled or not", () => {
    const a = scoreQuery(["event:e1", "fact:new1", "fact:new2"], labels, { crossProject: 0, ms: 1, judgedUsed: 2 });
    const b = scoreQuery([], labels, { crossProject: 0, ms: 1, judgedUsed: 0 });
    const c = scoreQuery(["fact:x"], labels, { crossProject: 0, ms: 1 }); // no reply: excluded
    expect(summarize([a, b, c]).judgedPrecision).toBeCloseTo(2 / 3, 4);
    expect(summarize([c]).judgedPrecision).toBeNull();
  });

  it("precision is null when nothing labeled came back", () => {
    expect(summarize([scoreQuery(["fact:x"], labels, { crossProject: 0, ms: 1 })]).precision).toBeNull();
  });
});

describe("recall-eval: point-in-time chronic noise", () => {
  it("uses only verdicts before the prompt, and a single use clears an owner", () => {
    const rows = [
      ...[1, 2, 3].map((t) => ({ key: "event:noisy", atMs: t, used: false })),
      { key: "event:late", atMs: 1, used: false },
      { key: "event:late", atMs: 2, used: false },
      { key: "event:late", atMs: 10, used: false },
      { key: "event:good", atMs: 1, used: false },
      { key: "event:good", atMs: 2, used: true },
      { key: "event:good", atMs: 3, used: false },
    ];
    const t = new ChronicNoiseTimeline(rows);
    expect([...t.keysAt(5, 3)].sort()).toEqual(["event:noisy"]);
    expect([...t.keysAt(11, 3)].sort()).toEqual(["event:late", "event:noisy"]);
    expect(t.keysAt(2, 3).size).toBe(0);
  });
});
