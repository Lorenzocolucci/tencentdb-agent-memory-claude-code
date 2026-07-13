/**
 * implicit-priming.ts — Implicit Priming (Idea 2): sub-threshold memories bias what
 * surfaces, invisibly.
 *
 * Blueprint §185 ("Attivazione a Cascata"): a weak/sub-threshold match does not show
 * itself, but AMPLIFIES the score of graph-connected memories so one of them crosses
 * the threshold and IS shown — the agent gets the right context "senza aver cercato le
 * parole giuste". Distinct from spreading-activation (which surfaces NEW connected
 * memories and marks them): priming RE-RANKS the existing candidate set, and the
 * primer stays invisible.
 *
 * Reuses the spreading-activation engine with `includeSeeds`: every candidate is a
 * seed (activation = its current ranking); the activation a candidate RECEIVES from
 * its co-recalled neighbors is its priming boost. A candidate central in the recall
 * sub-graph (connected to many co-recalled things) gets amplified.
 *
 * Pure & total: no DB, no side effects, never throws. The graph (co-occurrence ∪
 * explicit relations, restricted to the candidate set) is injected as `neighborsOf`.
 */

import { spreadActivation, type NeighborsOf } from "./spreading-activation.js";

export interface PrimingCandidate {
  /** Entity id the candidate is anchored to (priming operates on entities). */
  id: string;
  /** Current ranking score (relevance-derived). */
  ranking: number;
}

export interface PrimingParams {
  hops?: number;
  decay?: number;
}

/**
 * λ — how much a priming boost moves a ranking. Small ON PURPOSE: priming NUDGES,
 * relevance stays primary (blueprint's "+0.15" spirit). Tunable.
 */
export const PRIMING_LAMBDA = 0.15;

/**
 * The priming boost each candidate RECEIVES from its co-recalled neighbors.
 * boost(c) = activation flowing into c when every candidate seeds the graph with its
 * own ranking. Reuses spreadActivation(includeSeeds). Returns id → boost (≥ 0).
 */
export function computePrimingBoosts(
  candidates: PrimingCandidate[],
  neighborsOf: NeighborsOf,
  params: PrimingParams = {},
): Map<string, number> {
  if (!candidates || candidates.length === 0) return new Map();
  const seeds = candidates
    .filter((c) => c.id && Number.isFinite(c.ranking) && c.ranking > 0)
    .map((c) => ({ id: c.id, activation: c.ranking }));
  if (seeds.length === 0) return new Map();
  return spreadActivation(seeds, neighborsOf, {
    hops: params.hops ?? 1,
    decay: params.decay ?? 0.5,
    includeSeeds: true,
    threshold: 0, // keep every received contribution; the caller scales by λ
    maxNodes: seeds.length,
  });
}

/**
 * Apply priming boosts to candidate rankings (ranking' = ranking + λ·boost) and
 * return the candidates ordered by boosted ranking, strongest first. Immutable.
 */
export function applyPriming(
  candidates: PrimingCandidate[],
  boosts: Map<string, number>,
  lambda: number = PRIMING_LAMBDA,
): PrimingCandidate[] {
  return candidates
    .map((c) => ({ ...c, ranking: c.ranking + lambda * (boosts.get(c.id) ?? 0) }))
    .sort((a, b) => b.ranking - a.ranking);
}
