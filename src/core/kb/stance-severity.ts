/**
 * stance-severity — the graduated stance router for Pilastro A (Giudizio).
 *
 * Lorenzo chose option C (2026-07-01): a matched Mistake-Notebook lesson surfaces
 * as a SOFT, non-blocking note for ordinary process patterns, but escalates to a
 * HARD interrupt (block-before-acting, the Grounded-Trust machinery) ONLY when the
 * current action crosses a one-way door. This is the deterministic brain that
 * decides which — reused by the injection path (soft) and the interrupt renderer
 * (hard).
 *
 * Design guards (from the design, non-optional):
 *   - Right, not annoying. An under-attested lesson stays SILENT (a stance that
 *     cries wolf silences itself in a week). Conservative confidence + minimum
 *     cross-session evidence before it may speak at all.
 *   - One interrupt at a time. selectStanceToSurface returns AT MOST ONE hard
 *     stance (the best-attested); every other match falls through to soft notes.
 *   - Memory never breaks the conversation: soft is the default; hard is rare by
 *     construction (it needs BOTH an attested lesson AND a one-way-door action).
 *
 * Pure & total: no side effects, no LLM, no embeddings; never throws.
 */

import type { StakesLevel } from "./stakes.js";

export type StanceSeverity = "silent" | "soft" | "hard";

/** Below this confidence a lesson is not attested enough to surface at all. */
export const STANCE_MIN_CONFIDENCE = 0.6;
/** Minimum cross-session evidence before a lesson may fire. */
export const STANCE_MIN_EVIDENCE = 2;

/** The attestation a lesson carries (subset of LessonRow). */
export interface StanceAttestation {
  confidence: number;
  evidence_count: number;
}

/** The current action's stakes, as classified by stakes.ts. */
export interface ActionStakes {
  stakes: StakesLevel;
}

/**
 * Classify how a single matched lesson should surface against the current action.
 * silent → not attested enough; soft → note; hard → interrupt (one-way door).
 */
export function classifyStanceSeverity(
  lesson: StanceAttestation,
  action: ActionStakes,
): StanceSeverity {
  if (lesson.confidence < STANCE_MIN_CONFIDENCE || lesson.evidence_count < STANCE_MIN_EVIDENCE) {
    return "silent";
  }
  // Option C: hard interrupt ONLY when the action crosses a one-way door.
  if (action.stakes === "high") return "hard";
  return "soft";
}

/**
 * From all matched lessons, pick the SINGLE stance to interrupt on (one at a
 * time) plus the soft notes. At most one `hard` is returned — the highest-
 * confidence hard-eligible lesson; every other match (including the hard-eligible
 * ones not chosen) becomes a soft note, ranked by confidence descending.
 * Under-attested lessons are dropped entirely.
 */
export function selectStanceToSurface<T extends StanceAttestation>(
  lessons: readonly T[],
  action: ActionStakes,
): { hard: T | null; soft: T[] } {
  const hardEligible: T[] = [];
  const soft: T[] = [];

  for (const lesson of lessons) {
    const severity = classifyStanceSeverity(lesson, action);
    if (severity === "hard") hardEligible.push(lesson);
    else if (severity === "soft") soft.push(lesson);
    // silent → dropped
  }

  // Pick the best-attested hard stance; the rest fall through to soft.
  let hard: T | null = null;
  for (const lesson of hardEligible) {
    if (!hard || lesson.confidence > hard.confidence) {
      if (hard) soft.push(hard);
      hard = lesson;
    } else {
      soft.push(lesson);
    }
  }

  soft.sort((a, b) => b.confidence - a.confidence);
  return { hard, soft };
}
