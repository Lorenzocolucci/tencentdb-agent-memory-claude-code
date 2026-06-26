/**
 * distinctiveness-scorer — combines termRarity + isolation + affectSalience.
 *
 * Formula (from spec):
 *   distinctiveness(m) = w_rarity    * termRarity(m, corpus)
 *                      + w_isolation * isolation(m, neighbors)
 *                      + w_affect    * affectSalience(m)
 *
 * affectSalience is PLUGGABLE with w_affect = 0 (inert) until export calibration.
 * The caller may supply a pre-computed affectSalience value in [0,1]; when
 * w_affect = 0 it has no effect on the output.
 *
 * Immutable: pure function, returns a new number.
 * Errors: any NaN/Inf is clamped to 0 — off the critical path, never throws.
 */

import { termRarity, type CorpusStats } from "./term-rarity.js";
import { computeIsolation, type NeighborEntry } from "./isolation-scorer.js";

/** Weight configuration for the distinctiveness combinator. */
export interface DistinctivenessWeights {
  /** Weight for IDF-based term rarity (export-independent). */
  readonly wRarity: number;
  /** Weight for von Restorff isolation (export-independent). */
  readonly wIsolation: number;
  /**
   * Weight for affective salience (PLUGGABLE).
   * MUST be 0 until calibrated against real export data.
   * Setting it to 0 makes affectSalience entirely inert.
   */
  readonly wAffect: number;
}

/** Default production weights: rarity + isolation equally weighted; affect inert. */
export const DEFAULT_WEIGHTS: DistinctivenessWeights = {
  wRarity: 0.5,
  wIsolation: 0.5,
  wAffect: 0,
};

/** Input for one memory's distinctiveness computation. */
export interface DistinctivenessInput {
  readonly id: string;
  /** Raw text content used for term-rarity computation. */
  readonly content: string;
  /** Pre-computed cosine similarities to neighboring memories (for isolation). */
  readonly neighbors: ReadonlyArray<NeighborEntry>;
  /**
   * Pluggable affective salience in [0,1].
   * Ignored when wAffect = 0. Supply 0 or omit until calibration.
   */
  readonly affectSalience?: number;
}

/**
 * Compute the distinctiveness score for a single memory.
 * Returns a value in [0,1]. Any internal error degrades to 0.
 */
export function distinctiveness(
  input: DistinctivenessInput,
  corpusStats: CorpusStats,
  weights: DistinctivenessWeights = DEFAULT_WEIGHTS,
): number {
  try {
    const rarity = termRarity(input.content, corpusStats);
    const isolation = computeIsolation(input.neighbors);
    const affect = Math.min(1, Math.max(0, input.affectSalience ?? 0));

    const totalWeight = weights.wRarity + weights.wIsolation + weights.wAffect;
    if (totalWeight <= 0) return 0;

    const raw =
      weights.wRarity * rarity +
      weights.wIsolation * isolation +
      weights.wAffect * affect;

    const normalized = raw / totalWeight;
    if (!Number.isFinite(normalized)) return 0;
    return Math.min(1, Math.max(0, normalized));
  } catch {
    // Off the critical path: swallow errors, log nothing (caller logs if needed).
    return 0;
  }
}
