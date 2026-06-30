import { describe, it, expect } from "vitest";
import {
  phaseFor,
  confidenceAfterAvoidance,
  confidenceAfterRecurrence,
  AVOIDANCE_PHASE_THRESHOLD,
  CONFIDENCE_CAP,
  CONFIDENCE_FLOOR,
} from "../lesson-reinforcement.js";

describe("lesson reinforcement — confidence math (B3)", () => {
  it("phaseFor: below τ = explicit (B), at/above τ = implicit (A)", () => {
    expect(phaseFor(0)).toBe("explicit");
    expect(phaseFor(AVOIDANCE_PHASE_THRESHOLD - 1)).toBe("explicit");
    expect(phaseFor(AVOIDANCE_PHASE_THRESHOLD)).toBe("implicit");
    expect(phaseFor(AVOIDANCE_PHASE_THRESHOLD + 5)).toBe("implicit");
  });

  it("an avoidance raises confidence but never above the cap (diminishing returns)", () => {
    const a = confidenceAfterAvoidance(0.5);
    expect(a).toBeGreaterThan(0.5);
    expect(a).toBeLessThanOrEqual(CONFIDENCE_CAP);
    // already near the cap → still ≤ cap, still ≥ current
    const b = confidenceAfterAvoidance(CONFIDENCE_CAP);
    expect(b).toBeLessThanOrEqual(CONFIDENCE_CAP);
    expect(b).toBeGreaterThanOrEqual(CONFIDENCE_CAP - 1e-9);
  });

  it("repeated avoidances converge toward the cap, each step smaller", () => {
    let c = 0.5;
    const step1 = confidenceAfterAvoidance(c) - c;
    c = confidenceAfterAvoidance(c);
    const step2 = confidenceAfterAvoidance(c) - c;
    expect(step2).toBeLessThan(step1); // diminishing
    // converges
    for (let i = 0; i < 100; i++) c = confidenceAfterAvoidance(c);
    expect(c).toBeGreaterThan(0.95);
    expect(c).toBeLessThanOrEqual(CONFIDENCE_CAP);
  });

  it("a recurrence tempers confidence but never below the floor", () => {
    const a = confidenceAfterRecurrence(0.8);
    expect(a).toBeLessThan(0.8);
    expect(a).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
    let c = 0.8;
    for (let i = 0; i < 100; i++) c = confidenceAfterRecurrence(c);
    expect(c).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
  });

  it("is total: clamps junk input into [floor, cap], never NaN", () => {
    expect(Number.isFinite(confidenceAfterAvoidance(NaN))).toBe(true);
    expect(confidenceAfterAvoidance(2)).toBeLessThanOrEqual(CONFIDENCE_CAP);
    expect(confidenceAfterRecurrence(-5)).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
  });
});
