/**
 * cornerstone-selector — selects top-K distinctive memories with injection-recency decay.
 *
 * Picks the top-K memories by distinctiveness score, then applies a recency-of-injection
 * decay so the same cornerstone does not pin every session (rotation/diversity).
 *
 * Design (from spec):
 *   - Compute distinctiveness over candidates.
 *   - Apply injection-recency decay: score *= (1 - decayFactor) where decayFactor
 *     decays from 1 (just injected → penalized) to 0 (old injection → no penalty).
 *   - Return top-K by adjusted score.
 *
 * Immutable: returns new arrays/objects. Never mutates input.
 * Errors: any failure returns [] so memory is never broken.
 */

import {
  distinctiveness,
  type DistinctivenessWeights,
  DEFAULT_WEIGHTS,
} from "./distinctiveness-scorer.js";
import type { CorpusStats } from "./term-rarity.js";
import type { NeighborEntry } from "./isolation-scorer.js";

/** A candidate memory for cornerstone selection. */
export interface CornerstoneCandidate {
  readonly id: string;
  readonly content: string;
  readonly neighbors: ReadonlyArray<NeighborEntry>;
  /** Heat (frequency) — used only for caller context; NOT used in scoring. */
  readonly heat: number;
  /**
   * ISO timestamp of the last time this memory was injected as a cornerstone.
   * Undefined = never injected → no decay applied.
   */
  readonly lastInjectedAt?: string;
  /** Optional pre-computed affective salience (ignored when w_affect = 0). */
  readonly affectSalience?: number;
}

/** A selected cornerstone with its distinctiveness score. */
export interface SelectedCornerstone {
  readonly id: string;
  readonly content: string;
  /** Raw distinctiveness score in [0,1] (before decay). */
  readonly score: number;
}

export interface CornerstoneOptions {
  /**
   * Number of cornerstones to return.
   * Default: 3. Spec range: [3, 5].
   */
  readonly topK?: number;
  readonly weights?: DistinctivenessWeights;
  /**
   * Half-life for injection-recency decay (in ms).
   * Default: 48h (172_800_000 ms). A memory injected 48h ago gets ~50% penalty.
   */
  readonly injectionDecayHalfLifeMs?: number;
}

const DEFAULT_TOP_K = 3;
const DEFAULT_DECAY_HALFLIFE_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Compute the injection-recency decay factor in [0,1].
 *   1 = just injected (maximum penalty)
 *   0 = never injected or very old (no penalty)
 *
 * decay = exp(-ln(2) * ageMs / halfLifeMs)
 */
function injectionDecayFactor(lastInjectedAt: string | undefined, nowMs: number, halfLifeMs: number): number {
  if (!lastInjectedAt) return 0;
  const t = Date.parse(lastInjectedAt);
  if (!Number.isFinite(t)) return 0;
  const ageMs = Math.max(0, nowMs - t);
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

/**
 * Select the top-K cornerstone memories by distinctiveness, with injection-recency decay.
 *
 * @param candidates - All candidate memories with their corpus metadata.
 * @param corpusStats - Pre-computed IDF corpus statistics.
 * @param opts - Selection options (topK, weights, decay half-life).
 * @returns Top-K selected cornerstones, ordered by adjusted score descending.
 */
export function selectCornerstones(
  candidates: ReadonlyArray<CornerstoneCandidate>,
  corpusStats: CorpusStats,
  opts: CornerstoneOptions = {},
): SelectedCornerstone[] {
  try {
    const topK = opts.topK ?? DEFAULT_TOP_K;
    const weights = opts.weights ?? DEFAULT_WEIGHTS;
    const halfLifeMs = opts.injectionDecayHalfLifeMs ?? DEFAULT_DECAY_HALFLIFE_MS;
    const nowMs = Date.now();

    if (candidates.length === 0) return [];

    // Score each candidate and apply injection-recency decay.
    const scored = candidates.map((candidate) => {
      const rawScore = distinctiveness(
        {
          id: candidate.id,
          content: candidate.content,
          neighbors: candidate.neighbors,
          affectSalience: candidate.affectSalience,
        },
        corpusStats,
        weights,
      );

      // Apply injection-recency penalty: adjusted = rawScore * (1 - decayFactor).
      // A recently injected cornerstone is penalized to encourage rotation.
      const decay = injectionDecayFactor(candidate.lastInjectedAt, nowMs, halfLifeMs);
      const adjustedScore = rawScore * (1 - decay);

      return {
        id: candidate.id,
        content: candidate.content,
        score: rawScore,
        adjustedScore,
      };
    });

    // Sort by adjusted score descending, then take top-K.
    const sorted = [...scored].sort((a, b) => b.adjustedScore - a.adjustedScore);
    return sorted.slice(0, topK).map(({ id, content, score }) => ({ id, content, score }));
  } catch {
    // Off the critical path: swallow errors so memory never blocks the conversation.
    return [];
  }
}
