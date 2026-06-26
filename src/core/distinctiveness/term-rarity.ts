/**
 * termRarity — IDF-based term rarity scorer.
 *
 * Computes how rare the vocabulary of a memory is across the corpus.
 * Rare words → high IDF → high rarity score.
 *
 * Formula: mean IDF of the content tokens (length-normalized).
 *   IDF(t) = log((N + 1) / (DF(t) + 1))   [smoothed]
 *   termRarity(m) = mean(top-K rarest token IDFs), normalized to [0,1].
 *
 * Export-independent: uses only the content text and the pre-computed
 * corpus document-frequency map. No embeddings, no LLM.
 *
 * Immutable: buildCorpusStats returns a new object; termRarity is a pure function.
 */

/** Pre-computed corpus statistics (document-frequency per token). */
export interface CorpusStats {
  /** Total number of documents in the corpus. */
  readonly totalDocs: number;
  /** Document frequency: token → number of docs that contain it (case-insensitive). */
  readonly docFreq: ReadonlyMap<string, number>;
}

// Number of rarest tokens to average (avoids outlier single rare tokens dominating).
const TOP_K_TOKENS = 10;
// Maximum IDF for normalization: log((N+1)/1) with N very large → log(N).
// We normalize by the maximum possible IDF for the current corpus.
const MIN_DF = 1; // smoothing

/**
 * Extract content tokens from a text (unicode words, lower-cased, length ≥ 2).
 * Stop-words are left in; IDF naturally down-weights them.
 */
function tokenize(text: string): string[] {
  const raw = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(raw.map((t) => t.toLowerCase()).filter((t) => t.length >= 2))];
}

/**
 * Build corpus statistics from a list of documents.
 * Each document contributes 1 to each token's document frequency (de-duped within doc).
 */
export function computeCorpusStats(
  docs: ReadonlyArray<{ id: string; content: string }>,
): CorpusStats {
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    const tokens = tokenize(doc.content);
    for (const token of tokens) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }
  return { totalDocs: docs.length, docFreq };
}

/**
 * Smooth IDF for a token: log((totalDocs + 1) / (df + 1)).
 * Always positive, never NaN.
 */
function idf(token: string, stats: CorpusStats): number {
  const df = stats.docFreq.get(token) ?? 0;
  const n = Math.max(stats.totalDocs, MIN_DF);
  return Math.log((n + 1) / (df + 1));
}

/**
 * Maximum possible IDF for this corpus (token appearing in exactly 1 document).
 * Used to normalize the score to [0,1].
 */
function maxIdf(stats: CorpusStats): number {
  const n = Math.max(stats.totalDocs, MIN_DF);
  return Math.log((n + 1) / (MIN_DF + 1));
}

/**
 * Compute the term-rarity score for a single memory's content.
 * Returns a value in [0,1] where 1 = uniquely rare vocabulary.
 */
export function termRarity(content: string, stats: CorpusStats): number {
  if (!content || content.length === 0) return 0;
  if (stats.totalDocs === 0) return 0;

  const tokens = tokenize(content);
  if (tokens.length === 0) return 0;

  // Compute IDF for each unique token in this memory.
  const idfs = tokens.map((t) => idf(t, stats)).sort((a, b) => b - a); // descending

  // Average the top-K rarest (highest-IDF) tokens.
  const topK = idfs.slice(0, TOP_K_TOKENS);
  const meanIdf = topK.reduce((sum, v) => sum + v, 0) / topK.length;

  // Normalize by the maximum possible IDF for this corpus.
  const max = maxIdf(stats);
  if (max <= 0) return 0;

  return Math.min(1, Math.max(0, meanIdf / max));
}
