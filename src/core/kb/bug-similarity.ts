/**
 * Bug similarity — pure edge-weight between two bug events (B1, no DB / no I/O).
 *
 * w(a, b) = α · cosine(emb_a, emb_b)
 *          + β · jaccard(files_a ∪ entities_a, files_b ∪ entities_b)
 *          + γ · [1 iff a-b linked by a caused/fixed-by relation]
 *
 * All inputs are plain values; callers load from DB and pass here.
 * Immutable: every function returns a new value, nothing is mutated.
 */

/** Default weights (α + β + γ = 1.0). */
export const ALPHA = 0.6; // semantic cosine
export const BETA = 0.3; // file/entity Jaccard
export const GAMMA = 0.1; // caused/fixed-by relation link

/** Edge threshold: keep an edge iff weight ≥ TAU. */
export const TAU = 0.55;

/** Minimum distinct bug events for a cluster to be emitted. */
export const EVIDENCE_MIN = 2;

/** Minimum distinct sessions for a cluster to be emitted. */
export const SESSION_MIN = 2;

// ── Cosine similarity ─────────────────────────────────────────────────────────

/**
 * Cosine similarity between two float arrays.
 * Returns 0.0 when either vector is all-zeros or dimensions don't match.
 * Both vectors are expected to be unit-normalized (OpenAI embeddings are),
 * so this is simply the dot product — but we compute full cosine for safety.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  // Clamp to [-1, 1] to guard against float rounding above 1.
  return Math.max(-1, Math.min(1, dot / denom));
}

// ── Jaccard similarity ────────────────────────────────────────────────────────

/**
 * Jaccard similarity on two sets of string ids (files + entity ids).
 * |A ∩ B| / |A ∪ B|. Returns 0 when both sets are empty.
 */
export function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const id of setA) {
    if (setB.has(id)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

// ── Combined edge weight ─────────────────────────────────────────────────────

/** Inputs for one bug event used in the weight computation. */
export interface BugEventFeatures {
  embedding: Float32Array;
  /** Union of file ids and entity ids for this event. */
  contextIds: readonly string[];
}

export interface EdgeWeightParams {
  alpha?: number;
  beta?: number;
  gamma?: number;
}

/**
 * Weighted edge between two bug events.
 * `linked` = true iff a caused/fixed-by relation exists between them.
 * Returns a value in [0, 1].
 */
export function bugEdgeWeight(
  a: BugEventFeatures,
  b: BugEventFeatures,
  linked: boolean,
  weights: EdgeWeightParams = {},
): number {
  const alpha = weights.alpha ?? ALPHA;
  const beta = weights.beta ?? BETA;
  const gamma = weights.gamma ?? GAMMA;

  const semantic = cosineSimilarity(a.embedding, b.embedding);
  const structural = jaccardSimilarity(a.contextIds, b.contextIds);
  const relation = linked ? 1 : 0;

  return alpha * semantic + beta * structural + gamma * relation;
}
