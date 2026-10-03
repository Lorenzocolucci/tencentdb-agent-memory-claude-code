/**
 * The evidence bar depends on what the ledger says a memory of that class is worth
 * (measured 2026-10-03 on 44k judged injections): a same-project event from the last
 * days is used ~60% of the times it is shown, an empty-project fact ~1%. So a recent
 * project event needs less shared evidence, a memory of unknown project needs more
 * (or an entity of the prompt anchoring it), and nothing else changes.
 */
import { describe, expect, it } from "vitest";
import { candidateClass, relevanceScore } from "../selective-recall.js";

const GATE = { minPoints: 4, anchoredMinPoints: 3, recentEventMinPoints: 1, unknownProjectMinPoints: 6 };

describe("candidateClass", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const days = 14;

  it("a same-project event inside the window is a recent project event", () => {
    expect(candidateClass({ kind: "event", ts: "2026-09-30T12:00:00Z", project: "Argus", userLevel: false }, "argus", now, days)).toBe("recent-project-event");
  });

  it("an older or other-kind same-project memory is default", () => {
    expect(candidateClass({ kind: "event", ts: "2026-09-01T12:00:00Z", project: "Argus", userLevel: false }, "Argus", now, days)).toBe("default");
    expect(candidateClass({ kind: "fact", ts: "2026-09-30T12:00:00Z", project: "Argus", userLevel: false }, "Argus", now, days)).toBe("default");
  });

  it("an empty-project, non user-level memory is unknown-project; user-level is default", () => {
    expect(candidateClass({ kind: "fact", ts: "2026-09-30T12:00:00Z", project: "", userLevel: false }, "Argus", now, days)).toBe("unknown-project");
    expect(candidateClass({ kind: "fact", ts: "2026-09-30T12:00:00Z", project: "", userLevel: true }, "Argus", now, days)).toBe("default");
  });

  it("without a current project or with the window off nothing is special", () => {
    expect(candidateClass({ kind: "event", ts: "2026-09-30T12:00:00Z", project: "Argus", userLevel: false }, undefined, now, days)).toBe("default");
    expect(candidateClass({ kind: "event", ts: "2026-09-30T12:00:00Z", project: "Argus", userLevel: false }, "Argus", now, 0)).toBe("default");
  });
});

describe("relevanceScore by candidate class", () => {
  it("a recent project event clears the bar with one shared word, scoring like an anchored hit", () => {
    const e = { entityMatch: false, points: 1, maxPoints: 6 };
    expect(relevanceScore(e, GATE)).toBe(0); // default class: 1 point < 4
    const s = relevanceScore({ ...e, cls: "recent-project-event" as const }, GATE);
    expect(s).toBeGreaterThanOrEqual(0.72);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("a recent project event with no shared word still scores 0 (no lexical evidence, no cosine)", () => {
    expect(relevanceScore({ entityMatch: false, points: 0, maxPoints: 6, cls: "recent-project-event" }, GATE)).toBe(0);
  });

  it("an unknown-project memory needs strong evidence unless an entity of the prompt anchors it", () => {
    const base = { entityMatch: false, points: 4, maxPoints: 8, ftsScore: 0.9, cls: "unknown-project" as const };
    expect(relevanceScore(base, GATE)).toBe(0); // 4 < 6
    expect(relevanceScore({ ...base, points: 6 }, GATE)).toBeGreaterThan(0);
    expect(relevanceScore({ ...base, entityMatch: true, points: 3 }, GATE)).toBeGreaterThan(0); // anchored: 3
  });

  it("an unknown-project memory is never shown on a bare cosine", () => {
    expect(relevanceScore({ entityMatch: false, points: 0, maxPoints: 8, cosine: 0.95, cls: "unknown-project" }, GATE)).toBe(0);
    expect(relevanceScore({ entityMatch: false, points: 0, maxPoints: 8, cosine: 0.95 }, GATE)).toBeCloseTo(0.95);
  });

  it("the default class behaves exactly as before", () => {
    const e = { entityMatch: false, points: 4, maxPoints: 8, ftsScore: 0.9 };
    expect(relevanceScore({ ...e, cls: "default" as const }, GATE)).toBe(relevanceScore(e, { minPoints: 4, anchoredMinPoints: 3 }));
  });
});
