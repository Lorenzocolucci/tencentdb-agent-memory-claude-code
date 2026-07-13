/**
 * stance-track-record — Pilastro B ("crescere dall'errore"): the willingness
 * dynamics of a stance/lesson that FIRES an interrupt.
 *
 * Distinct from lesson-reinforcement (B3), which tracks whether the FAILURE
 * recurred. This tracks whether the STANCE itself was right to speak: when a
 * hard interrupt fires and the user CONFIRMS it mattered → willingness rises;
 * when the user REJECTS it as a false alarm → willingness falls, and a stance
 * that repeatedly cries wolf SUPPRESSES itself (a tombstone on firing — the
 * lesson is not deleted, just silenced until it re-earns trust). Symmetric: a
 * stance wrong once but later confirmed climbs back.
 *
 * Pure & total: clamps into [FLOOR, CAP], never NaN, never throws.
 */

/** A never-fired stance starts trusted-but-not-certain (innocent until it cries wolf). */
export const WILLINGNESS_DEFAULT = 0.7;
/** Willingness never reaches certainty (room for a future false alarm). */
export const WILLINGNESS_CAP = 0.99;
/** A stance is never fully erased by rejections — it can always climb back. */
export const WILLINGNESS_FLOOR = 0.05;

/** Below this, the stance is SUPPRESSED: it may not surface at all (cry-wolf tombstone). */
export const SUPPRESS_BELOW = 0.25;
/** Below this (but above SUPPRESS_BELOW), the stance may NOT fire HARD — soft only, until it re-earns trust. */
export const DEMOTE_BELOW = 0.45;

/** Fraction of the remaining gap to the cap closed by one confirmation (diminishing). */
const CONFIRM_GAIN = 0.25;
/** Fraction of current willingness shed by one rejection — stronger than confirm gain:
 *  a hard interrupt is intrusive, so false alarms are costly and silence quickly. */
const REJECT_TEMPER = 0.35;

function clamp(v: number): number {
  if (!Number.isFinite(v)) return WILLINGNESS_FLOOR;
  return Math.min(WILLINGNESS_CAP, Math.max(WILLINGNESS_FLOOR, v));
}

/** One confirmed fire: close a fraction of the gap to the cap. */
export function willingnessAfterConfirm(current: number): number {
  const w = clamp(current);
  return clamp(w + CONFIRM_GAIN * (WILLINGNESS_CAP - w));
}

/** One rejected fire (false alarm): shed a fraction of current willingness, floored. */
export function willingnessAfterReject(current: number): number {
  const w = clamp(current);
  return clamp(w * (1 - REJECT_TEMPER));
}

export type WillingnessTier = "suppressed" | "demoted" | "trusted";

/** Map a willingness value to how much the stance is allowed to do. */
export function willingnessTier(willingness: number): WillingnessTier {
  const w = clamp(willingness);
  if (w < SUPPRESS_BELOW) return "suppressed";
  if (w < DEMOTE_BELOW) return "demoted";
  return "trusted";
}
