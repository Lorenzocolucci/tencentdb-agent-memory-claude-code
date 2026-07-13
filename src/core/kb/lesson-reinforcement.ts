/**
 * lesson-reinforcement.ts — the confidence dynamics of the Mistake Notebook (B3).
 *
 * A lesson's confidence grows not only when the failure RECURS (evidence, the MNL
 * paper) but when the lesson is SUCCESSFULLY AVOIDED — the step beyond the paper
 * (Lorenzo's original idea). And how an avoidance is credited follows the
 * burned-child principle (mirror of Grounded Trust): demand EXPLICIT proof while
 * the lesson is young, trust IMPLICIT inference once it has earned it.
 *
 *   - phaseFor(avoidanceCount): < τ → "explicit" (B: only a confirmed avoidance
 *     counts); ≥ τ → "implicit" (A: exposure + no recurrence in-session infers it).
 *   - confidenceAfterAvoidance: moves a fraction toward the cap — diminishing
 *     returns, so the first confirmations matter most and it never overclaims.
 *   - confidenceAfterRecurrence: a relapse tempers confidence (the lesson did NOT
 *     fully protect), floored so a lesson is never fully discredited by one relapse.
 *
 * Pure & total: clamps every output into [FLOOR, CAP], never NaN, never throws.
 */

/** τ — confirmed avoidances needed before a lesson is trusted to self-credit. */
export const AVOIDANCE_PHASE_THRESHOLD = 3;

/** A lesson never reaches certainty: cap < 1 leaves room for a future relapse. */
export const CONFIDENCE_CAP = 0.99;
/** A relapse tempers but never erases: one bad day ≠ a worthless lesson. */
export const CONFIDENCE_FLOOR = 0.1;

/** Fraction of the remaining gap to the cap closed by one avoidance. */
const AVOIDANCE_GAIN = 0.25;
/** Fraction of current confidence shed by one relapse. */
const RECURRENCE_TEMPER = 0.2;

export type ReinforcementPhase = "explicit" | "implicit";

export function phaseFor(avoidanceCount: number): ReinforcementPhase {
  const n = Number.isFinite(avoidanceCount) ? avoidanceCount : 0;
  return n >= AVOIDANCE_PHASE_THRESHOLD ? "implicit" : "explicit";
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return CONFIDENCE_FLOOR;
  return Math.min(CONFIDENCE_CAP, Math.max(CONFIDENCE_FLOOR, v));
}

/** One successful avoidance: close a fraction of the gap to the cap (diminishing). */
export function confidenceAfterAvoidance(current: number): number {
  const c = clamp(current);
  return clamp(c + AVOIDANCE_GAIN * (CONFIDENCE_CAP - c));
}

/** One relapse: shed a fraction of current confidence, floored. */
export function confidenceAfterRecurrence(current: number): number {
  const c = clamp(current);
  return clamp(c * (1 - RECURRENCE_TEMPER));
}
