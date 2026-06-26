/**
 * isolation-scorer — von Restorff isolation component.
 *
 * A memory is "isolated" (distinctive) when it is UNLIKE its nearest neighbors.
 * Formula: isolation(m) = 1 - max_cosine_sim(m, neighbors)
 *
 * The cosine similarities come from the caller (from existing embeddings via
 * sqlite-vec or any IMemoryStore that exposes searchKbVector). This module is
 * a pure function that accepts pre-computed similarities.
 *
 * Export-independent: no LLM, no network, no embedding computation here.
 * Immutable: returns a number, no mutation.
 */

/** A single neighbor entry with its pre-computed cosine similarity to the query memory. */
export interface NeighborEntry {
  /** ID of the neighboring memory. */
  readonly id: string;
  /** Cosine similarity in [0,1] between this neighbor and the query memory. */
  readonly cosineSim: number;
}

/**
 * Compute the von Restorff isolation score for a memory given its neighbors.
 *
 * @param neighbors - Pre-computed cosine similarities to nearby memories.
 *   If empty (no neighbors found), the memory is maximally isolated → returns 1.0.
 * @returns Isolation score in [0,1].
 *   1.0 = no similar neighbors (most isolated / distinctive).
 *   0.0 = a neighbor is a perfect duplicate (cosineSim = 1.0).
 */
export function computeIsolation(neighbors: ReadonlyArray<NeighborEntry>): number {
  if (neighbors.length === 0) return 1.0;

  let maxSim = 0;
  for (const neighbor of neighbors) {
    const sim = Math.min(1, Math.max(0, neighbor.cosineSim)); // clamp to [0,1]
    if (sim > maxSim) maxSim = sim;
  }

  return Math.min(1, Math.max(0, 1 - maxSim));
}
