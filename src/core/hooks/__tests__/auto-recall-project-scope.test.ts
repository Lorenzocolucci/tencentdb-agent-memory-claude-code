/**
 * applyProjectScope — down-weight recalled EVENTS from OTHER projects so the
 * current project's work ranks first. Soft (not a filter), facts/laws neutral.
 * NON-circular: the fake store returns fixed per-id project tags; the assertion
 * is the resulting order/scores.
 */
import { describe, it, expect } from "vitest";
import { applyProjectScope } from "../auto-recall.js";

type R = { owner_id: string; owner_kind: string; score: number; text: string };
const r = (id: string, kind: string, score: number): R => ({ owner_id: id, owner_kind: kind, score, text: id });

function store(projById: Record<string, string>): any {
  return { getEventProjects: (ids: string[]) => Object.fromEntries(ids.filter((i) => projById[i]).map((i) => [i, projById[i]])) };
}

describe("applyProjectScope", () => {
  it("re-ranks: a lower-scored CURRENT-project event beats a higher-scored OTHER-project event", () => {
    const results = [r("tutor-ev", "event", 0.60), r("sofia-ev", "event", 0.50)];
    const s = store({ "tutor-ev": "Tutor-Agent", "sofia-ev": "Sofia-AI" });
    const out = applyProjectScope(results as any, "Sofia-AI", s);
    // tutor-ev penalized 0.60*0.5=0.30 → sofia-ev (0.50) now first.
    expect(out[0].owner_id).toBe("sofia-ev");
    expect(out[1].owner_id).toBe("tutor-ev");
    expect(out[1].score).toBeCloseTo(0.30, 5);
  });

  it("leaves facts/entities (no per-event project) untouched", () => {
    const results = [r("fact-1", "fact", 0.4), r("ent-1", "entity", 0.3)];
    const out = applyProjectScope(results as any, "Sofia-AI", store({}));
    expect(out.map((x) => x.owner_id)).toEqual(["fact-1", "ent-1"]);
    expect(out[0].score).toBe(0.4);
  });

  it("no projectName → unchanged (never scopes blindly)", () => {
    const results = [r("a", "event", 0.5)];
    const out = applyProjectScope(results as any, undefined, store({ a: "X" }));
    expect(out[0].score).toBe(0.5);
  });

  it("same-project events keep full score", () => {
    const results = [r("s1", "event", 0.5)];
    const out = applyProjectScope(results as any, "Sofia-AI", store({ s1: "Sofia-AI" }));
    expect(out[0].score).toBe(0.5);
  });
});
