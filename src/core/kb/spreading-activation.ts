/**
 * spreading-activation.ts — the beating heart of associative recall.
 *
 * Sinapsys is NOT a search database: it is ASSOCIATIVE memory. A query activates
 * some memories (the recall seeds); this module lets that activation SPREAD through
 * the entity graph so a memory the query never named can still surface because it
 * is strongly connected to an active one. Reconstruction, not lookup.
 *
 * The model is weighted spreading activation with decay + convergence (ACT-R
 * flavored), NOT a flat BFS:
 *   - activation flows along edges in proportion to edge strength (Hebbian
 *     `relations.support`), normalized so a node spreads — not multiplies — what it has;
 *   - each hop multiplies by DECAY (< 1), so distant memories matter less and cycles
 *     converge;
 *   - contributions SUM at each node, so an entity at the crossroads of several active
 *     threads (reached from multiple seeds) accumulates more — and surfaces. That
 *     convergence is the associative magic, and it falls out of summation for free.
 *
 * Pure & total: a function over an injected neighbor lookup. No DB, no side effects,
 * never throws. Deterministic. Excludes the seeds from its result (only NEW activation).
 */

/**
 * Internal-metric attributes that are noise as a surfaced memory (counters, sizes,
 * offsets) — they pollute associative injection. Used to skip them when choosing an
 * entity's representative memory. NOT a content filter on the KB, only on what a weak
 * association is allowed to surface.
 */
const NOISE_ATTR_RE = /_(count|phase|size|index|offset)$|^(line|char|byte|token)_|^action_phase$|^rowid$/i;

export function isNoiseAttribute(attribute: string): boolean {
  return typeof attribute === "string" && NOISE_ATTR_RE.test(attribute);
}

export interface ActivationSeed {
  id: string;
  activation: number;
}

export interface WeightedNeighbor {
  id: string;
  /** Edge strength (e.g. relations.support). Non-positive weights are ignored. */
  weight: number;
}

/** Lazy adjacency: the strongest edges out of `id`. */
export type NeighborsOf = (id: string) => WeightedNeighbor[];

export interface SpreadParams {
  /** Number of hops to spread (default 2). */
  hops?: number;
  /** Per-hop decay in (0,1] (default 0.5). */
  decay?: number;
  /** Drop nodes whose final activation is below this (default 0.05). */
  threshold?: number;
  /** Cap the result to the strongest N nodes (default 50). */
  maxNodes?: number;
  /** Expand only the strongest K neighbors per node — caps hub fan-out (default 8). */
  topKPerNode?: number;
  /**
   * When true, seeds are NOT excluded from the result: each seed's value is the
   * activation it RECEIVED from the network (its initial activation is never added).
   * Used by Implicit Priming, where every candidate is a seed and the boost is the
   * activation that flowed into it from co-recalled neighbors. Default false.
   */
  includeSeeds?: boolean;
}

const DEFAULTS: Required<SpreadParams> = {
  hops: 2,
  decay: 0.5,
  threshold: 0.05,
  maxNodes: 50,
  topKPerNode: 8,
  includeSeeds: false,
};

/**
 * Spread activation from `seeds` over the graph given by `neighborsOf`.
 * Returns the NEWLY activated nodes (seeds excluded), id → activation, already
 * thresholded and capped, ordered strongest-first.
 */
export function spreadActivation(
  seeds: ActivationSeed[],
  neighborsOf: NeighborsOf,
  params: SpreadParams = {},
): Map<string, number> {
  const p = { ...DEFAULTS, ...params };
  const empty = new Map<string, number>();
  if (!seeds || seeds.length === 0) return empty;
  if (!(p.decay > 0) || p.hops < 1) return empty;

  const seedIds = new Set(seeds.map((s) => s.id));
  // Total accumulated activation per node (excluding seeds, accounted at the end).
  const total = new Map<string, number>();

  // The wavefront: nodes that received activation in the previous hop, carrying the
  // (already decayed) contribution they must propagate onward.
  let frontier = new Map<string, number>();
  for (const s of seeds) {
    if (Number.isFinite(s.activation) && s.activation > 0) {
      frontier.set(s.id, (frontier.get(s.id) ?? 0) + s.activation);
    }
  }

  for (let hop = 0; hop < p.hops && frontier.size > 0; hop++) {
    const next = new Map<string, number>();
    for (const [nodeId, a] of frontier) {
      let neighbors: WeightedNeighbor[];
      try {
        neighbors = neighborsOf(nodeId) ?? [];
      } catch {
        neighbors = [];
      }
      // Strongest edges first, keep top-K, ignore non-positive weights.
      const strong = neighbors
        .filter((n) => n.id && Number.isFinite(n.weight) && n.weight > 0)
        .sort((x, y) => y.weight - x.weight)
        .slice(0, p.topKPerNode);
      const sumW = strong.reduce((acc, n) => acc + n.weight, 0);
      if (sumW <= 0) continue;
      for (const n of strong) {
        const contribution = a * (n.weight / sumW) * p.decay;
        if (contribution <= 0) continue;
        next.set(n.id, (next.get(n.id) ?? 0) + contribution);
      }
    }
    // Land this hop's contributions into the running total (summing = convergence).
    for (const [id, c] of next) {
      if (!p.includeSeeds && seedIds.has(id)) continue; // seeds normally excluded
      total.set(id, (total.get(id) ?? 0) + c);
    }
    frontier = next;
  }

  // Threshold, order strongest-first, cap.
  const ranked = [...total.entries()]
    .filter(([, v]) => v >= p.threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, p.maxNodes);

  return new Map(ranked);
}
