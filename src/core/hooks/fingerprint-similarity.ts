/**
 * Situation similarity + match-tier classification (Context Fingerprint / Idea 1).
 *
 * Deterministic weighted overlap — NO embeddings (the signals are discrete sets,
 * so Jaccard is the right, fast tool). Files are the spine; a shared error
 * signature and an exact task-type match add weight. Only axes that carry signal
 * are counted, so a files-only comparison scores exactly the file Jaccard — no
 * empty axis silently dilutes the score.
 *
 * classifyMatch turns a score into the two-tier "voice" Lorenzo chose:
 *   strong → assertive injection · medium → tentative injection · none → silent.
 * Thresholds are configurable so the bar can rise as fingerprints accumulate.
 */

export interface Fingerprint {
  readonly fileKeys: readonly string[];
  readonly errorSignatures: readonly string[];
  /** '' when unknown — an empty task type is NOT counted as an axis. */
  readonly taskType: string;
}

export type MatchTier = "strong" | "medium" | "none";

export interface MatchThresholds {
  readonly strong: number;
  readonly medium: number;
}

const DEFAULT_THRESHOLDS: MatchThresholds = { strong: 0.6, medium: 0.3 };

const W_FILES = 0.6;
const W_ERRORS = 0.25;
const W_TASK = 0.15;

/** Jaccard overlap of two string sets; 0 when the union is empty. */
function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const v of sa) if (sb.has(v)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Score similarity in [0,1] from the axes that carry signal, normalized by the
 * active weights so an inactive axis neither helps nor hurts.
 */
export function scoreFingerprint(current: Fingerprint, stored: Fingerprint): number {
  let weighted = 0;
  let active = 0;

  if (current.fileKeys.length > 0 || stored.fileKeys.length > 0) {
    weighted += W_FILES * jaccard(current.fileKeys, stored.fileKeys);
    active += W_FILES;
  }
  if (current.errorSignatures.length > 0 || stored.errorSignatures.length > 0) {
    weighted += W_ERRORS * jaccard(current.errorSignatures, stored.errorSignatures);
    active += W_ERRORS;
  }
  if (current.taskType !== "" && stored.taskType !== "") {
    weighted += W_TASK * (current.taskType === stored.taskType ? 1 : 0);
    active += W_TASK;
  }

  return active === 0 ? 0 : weighted / active;
}

/** Map a score to a match tier against (optionally custom) thresholds. */
export function classifyMatch(
  score: number,
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchTier {
  if (score >= thresholds.strong) return "strong";
  if (score >= thresholds.medium) return "medium";
  return "none";
}
