/**
 * Pilastro A — Fase 1 (brain): graduated stance severity router.
 *
 * Lorenzo chose option C (2026-07-01): a matched lesson surfaces as a SOFT note
 * for process patterns, but as a HARD interrupt (block-before-acting) only when
 * the current action crosses a one-way door. This pure router encodes that:
 *
 *   silent  — the lesson is not attested enough to speak (anti "cry wolf")
 *   soft    — attested lesson, no one-way door → a non-blocking note
 *   hard    — attested lesson AND the action is high-stakes → interrupt
 *
 * Deterministic, no LLM, no embeddings. Reuses stakes.ts as the one-way-door
 * signal and the lesson's confidence + evidence_count as attestation.
 *
 * Pins:
 *   - under-confidence or under-evidence → silent (conservative)
 *   - attested + high-stakes action → hard
 *   - attested + no-stakes action → soft
 *   - selectStanceToSurface: at most ONE hard (highest confidence), rest soft
 */

import { describe, it, expect } from "vitest";
import {
  classifyStanceSeverity,
  selectStanceToSurface,
  STANCE_MIN_CONFIDENCE,
  STANCE_MIN_EVIDENCE,
} from "../stance-severity.js";

const attested = { confidence: 0.9, evidence_count: 3 };

describe("stance-severity — classifyStanceSeverity", () => {
  it("silent when confidence is below the floor (cry-wolf guard)", () => {
    expect(
      classifyStanceSeverity({ confidence: STANCE_MIN_CONFIDENCE - 0.01, evidence_count: 5 }, { stakes: "high" }),
    ).toBe("silent");
  });

  it("silent when cross-session evidence is below the floor", () => {
    expect(
      classifyStanceSeverity({ confidence: 0.95, evidence_count: STANCE_MIN_EVIDENCE - 1 }, { stakes: "high" }),
    ).toBe("silent");
  });

  it("hard when attested AND the action crosses a one-way door (high stakes)", () => {
    expect(classifyStanceSeverity(attested, { stakes: "high" })).toBe("hard");
  });

  it("soft when attested but the action is not a one-way door", () => {
    expect(classifyStanceSeverity(attested, { stakes: "none" })).toBe("soft");
  });
});

describe("stance-severity — selectStanceToSurface (one interrupt at a time)", () => {
  it("returns at most ONE hard — the highest-confidence — and the rest as soft", () => {
    const lessons = [
      { id: "a", confidence: 0.7, evidence_count: 3 },
      { id: "b", confidence: 0.95, evidence_count: 4 }, // strongest → the hard one
      { id: "c", confidence: 0.5, evidence_count: 5 }, // below confidence floor → silent
    ];
    const out = selectStanceToSurface(lessons, { stakes: "high" });
    expect(out.hard?.id).toBe("b");
    // a is attested + high-stakes so it is ALSO hard-eligible, but only one hard
    // surfaces; the non-selected hard-eligible ones fall through to soft.
    expect(out.soft.map((l) => l.id)).toEqual(["a"]);
  });

  it("no hard when the action is not high-stakes → all attested become soft, ranked", () => {
    const lessons = [
      { id: "a", confidence: 0.7, evidence_count: 3 },
      { id: "b", confidence: 0.95, evidence_count: 4 },
    ];
    const out = selectStanceToSurface(lessons, { stakes: "none" });
    expect(out.hard).toBeNull();
    expect(out.soft.map((l) => l.id)).toEqual(["b", "a"]); // confidence-desc
  });

  it("drops under-attested lessons entirely (neither hard nor soft)", () => {
    const lessons = [{ id: "weak", confidence: 0.3, evidence_count: 1 }];
    const out = selectStanceToSurface(lessons, { stakes: "high" });
    expect(out.hard).toBeNull();
    expect(out.soft).toEqual([]);
  });
});

describe("stance-severity — Pilastro B track record (willingness feedback)", () => {
  it("SUPPRESSES a well-attested stance that repeatedly cried wolf (silent)", () => {
    // High confidence + one-way door would be hard, but a bad track record silences it.
    expect(classifyStanceSeverity({ ...attested, willingness: 0.1 }, { stakes: "high" })).toBe("silent");
  });

  it("DEMOTES a poor-but-not-suppressed track record to soft (no hard until re-earned)", () => {
    expect(classifyStanceSeverity({ ...attested, willingness: 0.35 }, { stakes: "high" })).toBe("soft");
  });

  it("a trusted track record still fires hard on a one-way door", () => {
    expect(classifyStanceSeverity({ ...attested, willingness: 0.8 }, { stakes: "high" })).toBe("hard");
  });

  it("legacy lessons (no willingness) behave as before — trusted", () => {
    expect(classifyStanceSeverity(attested, { stakes: "high" })).toBe("hard");
  });

  it("selectStanceToSurface: a suppressed stance is dropped; a demoted one falls to soft", () => {
    const lessons = [
      { id: "suppressed", confidence: 0.95, evidence_count: 5, willingness: 0.1 },
      { id: "demoted", confidence: 0.9, evidence_count: 4, willingness: 0.35 },
      { id: "trusted", confidence: 0.85, evidence_count: 3, willingness: 0.8 },
    ];
    const out = selectStanceToSurface(lessons, { stakes: "high" });
    expect(out.hard?.id).toBe("trusted"); // only the trusted one earns the interrupt
    expect(out.soft.map((l) => l.id)).toEqual(["demoted"]); // demoted → soft; suppressed → dropped
  });
});
