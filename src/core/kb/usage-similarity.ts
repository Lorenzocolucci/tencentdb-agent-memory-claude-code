/**
 * Usage similarity (Slice B1) — pure edge weight between two behavioral events.
 *
 * Unlike bug-similarity (α·cosine + β·jaccard + γ·relation), behavioral usage
 * patterns are frequently ENTITY-LESS ("aspetta la mia risposta" anchors to no
 * file/entity) and carry no caused/fixed-by relations. So the weight is
 * SEMANTIC-DOMINANT: cosine drives it, with only a small structural nudge for
 * the rarer case where two behaviors do share an entity.
 *
 *   w(a, b) = α · cosine(emb_a, emb_b) + β · jaccard(ctx_a, ctx_b)
 *
 * Reuses the already-tested cosine/jaccard primitives from bug-similarity.
 * Immutable, no DB/I/O.
 */

import { cosineSimilarity, jaccardSimilarity } from "./bug-similarity.js";

/** Semantic cosine weight — dominates (behaviors are often entity-less). */
export const USAGE_ALPHA = 0.85;
/** Structural Jaccard weight — a small nudge when behaviors share an entity. */
export const USAGE_BETA = 0.15;
/** Edge threshold: keep an edge iff weight ≥ USAGE_TAU (the "confident" edge). */
export const USAGE_TAU = 0.72;
/**
 * Looser threshold the runner uses to SURFACE candidates for the A3 LLM gate.
 * The live dry-run proved 0.72 yields 0 clusters on real embeddings, so recall
 * happens here (wide net) and precision is enforced by the LLM judge — clustering
 * gives recall, the distiller gives precision.
 */
export const USAGE_CANDIDATE_TAU = 0.6;
/** Minimum distinct events for a usage cluster to be emitted. */
export const USAGE_EVIDENCE_MIN = 2;
/**
 * Minimum distinct SESSIONS (by session_id) — the anti-anecdote guard. NB:
 * session_id, not session_key: session_key is stable per project, so behaviors
 * that recur within one project across many chats share it. Counting by
 * session_key would collapse them and silently drop real cross-session patterns
 * (the same trap principle-clusters and the rollover bug called out).
 */
export const USAGE_SESSION_MIN = 2;

/** Inputs for one behavioral event used in the weight computation. */
export interface UsageEventFeatures {
  embedding: Float32Array;
  /** Entity ids for this event (usually empty for behavioral patterns). */
  contextIds: readonly string[];
}

export interface UsageEdgeWeightParams {
  alpha?: number;
  beta?: number;
}

/** Semantic-dominant weighted edge between two behavioral events, in [0, 1]. */
export function usageEdgeWeight(
  a: UsageEventFeatures,
  b: UsageEventFeatures,
  weights: UsageEdgeWeightParams = {},
): number {
  const alpha = weights.alpha ?? USAGE_ALPHA;
  const beta = weights.beta ?? USAGE_BETA;
  const semantic = cosineSimilarity(a.embedding, b.embedding);
  const structural = jaccardSimilarity(a.contextIds, b.contextIds);
  return alpha * semantic + beta * structural;
}
