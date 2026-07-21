/**
 * Cura #2 Phase 2b — entity-merge-plan (pure render/parse/plan) tests.
 * No DB: exercises the report format + decision logic that gates every merge.
 */

import { describe, it, expect } from "vitest";
import type { EntityCluster } from "../entity-reconciliation.js";
import {
  renderReport,
  parseReport,
  toMergePlans,
  pickKeep,
  type EntityMeta,
} from "../entity-merge-plan.js";

const META = new Map<string, EntityMeta>([
  ["c1", { name: "OpenAI", type: "topic", factCount: 42, importance: 80, createdTime: "2026-01-01T00:00:00Z" }],
  ["s1", { name: "Open AI", type: "topic", factCount: 3, importance: 50, createdTime: "2026-02-01T00:00:00Z" }],
  ["s2", { name: "OpenAI Inc", type: "topic", factCount: 8, importance: 50, createdTime: "2026-03-01T00:00:00Z" }],
  ["x1", { name: "OpenRouter", type: "topic", factCount: 1, importance: 50, createdTime: "2026-04-01T00:00:00Z" }],
]);

const autoCluster: EntityCluster = {
  members: ["c1", "s1", "s2"], memberNames: ["OpenAI", "Open AI", "OpenAI Inc"],
  type: "topic", size: 3, band: "auto", maxScore: 0.98, minScore: 0.96,
};
const askCluster: EntityCluster = {
  members: ["c1", "s1", "x1"], memberNames: ["OpenAI", "Open AI", "OpenRouter"],
  type: "topic", size: 3, band: "ask", maxScore: 0.93, minScore: 0.86,
};

describe("entity-merge-plan: pickKeep", () => {
  it("picks highest importance, then most facts", () => {
    expect(pickKeep(["c1", "s1", "s2"], META)).toBe("c1"); // c1 has importance 80
  });
  it("ties on importance broken by factCount", () => {
    expect(pickKeep(["s1", "s2"], META)).toBe("s2"); // same imp 50, s2 has 8 > 3 facts
  });
});

describe("entity-merge-plan: render + parse round-trip", () => {
  it("AUTO cluster renders decision OK + keep=canonical and parses to a plan", () => {
    const md = renderReport({
      clusters: [autoCluster], meta: META, topAsk: 30,
      totals: { entities: 4, entitiesWithVector: 4 }, generatedAt: "2026-07-21T00:00:00Z",
    });
    expect(md).toContain("[AUTO]");
    expect(md).toContain("keep    c1");
    expect(md).toMatch(/merge\s+s2/);

    const parsed = parseReport(md);
    const auto = parsed.filter((c) => c.band === "auto");
    expect(auto).toHaveLength(1);
    expect(auto[0].decision).toBe("OK");
    expect(auto[0].canonicalId).toBe("c1");
    expect(new Set(auto[0].satelliteIds)).toEqual(new Set(["s1", "s2"]));

    const plans = toMergePlans(parsed, { autoOnly: true });
    expect(plans).toEqual([{ canonicalId: "c1", satelliteIds: expect.arrayContaining(["s1", "s2"]) }]);
  });

  it("ASK cluster defaults to decision NO → no plan until edited", () => {
    const md = renderReport({
      clusters: [askCluster], meta: META, topAsk: 30,
      totals: { entities: 4, entitiesWithVector: 4 }, generatedAt: "2026-07-21T00:00:00Z",
    });
    expect(md).toContain("[ASK]");
    expect(md).toContain("decision: NO");

    const parsed = parseReport(md);
    expect(parsed[0].decision).toBe("NO");
    expect(toMergePlans(parsed, { autoOnly: false })).toEqual([]);
  });
});

describe("entity-merge-plan: editing semantics", () => {
  it("decision OK on an ASK cluster produces a plan", () => {
    const edited = [
      "### cluster=c1 type=topic n=3 score=0.86-0.93 [ASK]",
      "decision: OK",
      "  keep    c1  facts=42 imp=80  \"OpenAI\"",
      "  merge   s1  facts=3 imp=50  \"Open AI\"",
      "  merge   x1  facts=1 imp=50  \"OpenRouter\"",
    ].join("\n");
    const plans = toMergePlans(parseReport(edited), { autoOnly: false });
    expect(plans).toEqual([{ canonicalId: "c1", satelliteIds: ["s1", "x1"] }]);
  });

  it("'exclude' drops a stranger from the merge", () => {
    const edited = [
      "### cluster=c1 type=topic n=3 score=0.86-0.93 [ASK]",
      "decision: OK",
      "  keep    c1  facts=42 imp=80  \"OpenAI\"",
      "  merge   s1  facts=3 imp=50  \"Open AI\"",
      "  exclude x1  facts=1 imp=50  \"OpenRouter\"",
    ].join("\n");
    const parsed = parseReport(edited);
    expect(parsed[0].excludedIds).toEqual(["x1"]);
    const plans = toMergePlans(parsed, { autoOnly: false });
    expect(plans).toEqual([{ canonicalId: "c1", satelliteIds: ["s1"] }]);
  });

  it("moving 'keep' changes the canonical", () => {
    const edited = [
      "### cluster=c1 type=topic n=2 score=0.90-0.90 [ASK]",
      "decision: OK",
      "  merge   c1  facts=42 imp=80  \"OpenAI\"",
      "  keep    s1  facts=3 imp=50  \"Open AI\"",
    ].join("\n");
    const plans = toMergePlans(parseReport(edited), { autoOnly: false });
    expect(plans).toEqual([{ canonicalId: "s1", satelliteIds: ["c1"] }]);
  });

  it("auto-only ignores an OK'd ASK cluster", () => {
    const md = [
      "### cluster=a1 type=topic n=2 score=0.96-0.96 [AUTO]",
      "decision: OK",
      "  keep    c1  facts=42 imp=80  \"OpenAI\"",
      "  merge   s2  facts=8 imp=50  \"OpenAI Inc\"",
      "### cluster=b1 type=topic n=2 score=0.88-0.88 [ASK]",
      "decision: OK",
      "  keep    c1  facts=42 imp=80  \"OpenAI\"",
      "  merge   x1  facts=1 imp=50  \"OpenRouter\"",
    ].join("\n");
    const parsed = parseReport(md);
    expect(toMergePlans(parsed, { autoOnly: true })).toEqual([{ canonicalId: "c1", satelliteIds: ["s2"] }]);
    expect(toMergePlans(parsed, { autoOnly: false })).toHaveLength(2);
  });
});

describe("entity-merge-plan: fail-loud validation", () => {
  it("OK with two keeps throws", () => {
    const bad = [
      "### cluster=c1 type=topic n=2 score=0.9-0.9 [ASK]",
      "decision: OK",
      "  keep c1  facts=1 imp=1  \"a\"",
      "  keep s1  facts=1 imp=1  \"b\"",
    ].join("\n");
    expect(() => parseReport(bad)).toThrow(/exactly one 'keep'/);
  });

  it("OK with no merge members throws", () => {
    const bad = [
      "### cluster=c1 type=topic n=1 score=0.9-0.9 [ASK]",
      "decision: OK",
      "  keep c1  facts=1 imp=1  \"a\"",
    ].join("\n");
    expect(() => parseReport(bad)).toThrow(/no 'merge' members/);
  });

  it("NO cluster with a single keep does not throw and yields no plan", () => {
    const ok = [
      "### cluster=c1 type=topic n=2 score=0.9-0.9 [ASK]",
      "decision: NO",
      "  keep c1  facts=1 imp=1  \"a\"",
      "  merge s1  facts=1 imp=1  \"b\"",
    ].join("\n");
    const parsed = parseReport(ok);
    expect(parsed[0].decision).toBe("NO");
    expect(toMergePlans(parsed, { autoOnly: false })).toEqual([]);
  });
});
