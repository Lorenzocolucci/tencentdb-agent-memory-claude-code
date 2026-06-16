/**
 * Text chunking for embedding long inputs.
 *
 * Long embedding inputs used to be SILENTLY TRUNCATED to `maxInputChars`
 * before being sent to the embedding model — the tail of long sessions
 * became invisible to semantic search.  This module splits an over-long
 * text into OVERLAPPING chunks instead, so every part of the text gets
 * embedded and indexed (one vector per chunk, all linked to the same
 * parent record id at the store layer).
 *
 * Design:
 * - Pure functions, no I/O, no embedding-provider knowledge — easy to unit test.
 * - Character-based splitting with a configurable overlap window.  Character
 *   count is a conservative proxy for token count: the default `chunkSize`
 *   (2000 chars) stays well under the OpenAI text-embedding-3-small 8191-token
 *   hard limit even for worst-case CJK text (where 1 char ≈ 1-2 tokens, so
 *   2000 chars ≈ 2000-4000 tokens).
 * - A hard `maxChunks` cap bounds chunk explosion (cost/latency).  When the cap
 *   is hit the caller is told via the returned `truncated` flag so it can WARN —
 *   the input is bounded, but NEVER silently cut without a signal.
 */

/** Default target chunk size in characters. Conservative vs. the model token limit. */
export const DEFAULT_CHUNK_SIZE = 2000;

/** Default overlap between consecutive chunks, in characters. */
export const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Default maximum number of chunks produced from a single text.
 * Bounds cost/latency for pathological inputs.  50 chunks * 2000 chars =
 * ~100k chars of indexable text per record, which is far beyond any realistic
 * single L1 memory or L0 message.
 */
export const DEFAULT_MAX_CHUNKS_PER_TEXT = 50;

/**
 * Absolute hard ceiling on chunk size in characters.  Even if a caller
 * configures a larger `chunkSize`, we clamp to this value so a single chunk
 * can never approach the embedding model's token limit.  For OpenAI
 * text-embedding-3-small the limit is 8191 tokens; at the worst-case CJK ratio
 * of ~1.5 tokens/char, 5000 chars ≈ 7500 tokens — safely under the limit.
 */
export const MAX_SAFE_CHUNK_SIZE = 5000;

/** Resolved, validated chunking parameters. */
export interface ChunkOptions {
  /** Target chunk size in characters (clamped to [1, MAX_SAFE_CHUNK_SIZE]). */
  chunkSize: number;
  /** Overlap between consecutive chunks, in characters (clamped to [0, chunkSize - 1]). */
  chunkOverlap: number;
  /** Maximum number of chunks produced from one text (clamped to >= 1). */
  maxChunks: number;
}

/** Result of splitting a text into chunks. */
export interface ChunkResult {
  /** The produced chunks (always >= 1 element for a non-empty input). */
  chunks: string[];
  /**
   * `true` when the `maxChunks` cap forced us to stop before the whole text
   * was covered — i.e. the tail was dropped.  Callers MUST log a warning in
   * this case (the input is bounded, never silently cut without a signal).
   */
  truncated: boolean;
  /** Total characters in the original input (for logging). */
  originalLength: number;
}

/**
 * Normalize raw (possibly invalid) chunking parameters into safe, internally
 * consistent values.  Never throws — clamps out-of-range values instead.
 *
 * Invariants enforced:
 * - 1 <= chunkSize <= MAX_SAFE_CHUNK_SIZE
 * - 0 <= chunkOverlap < chunkSize  (overlap strictly smaller than the window,
 *   otherwise the sliding window would never advance)
 * - maxChunks >= 1
 */
export function resolveChunkOptions(raw: {
  chunkSize?: number;
  chunkOverlap?: number;
  maxChunks?: number;
}): ChunkOptions {
  const rawSize = Number.isFinite(raw.chunkSize) ? Math.floor(raw.chunkSize!) : DEFAULT_CHUNK_SIZE;
  const chunkSize = Math.min(MAX_SAFE_CHUNK_SIZE, Math.max(1, rawSize));

  const rawOverlap = Number.isFinite(raw.chunkOverlap) ? Math.floor(raw.chunkOverlap!) : DEFAULT_CHUNK_OVERLAP;
  // Overlap must be strictly less than chunkSize so the window always advances.
  const chunkOverlap = Math.min(Math.max(0, rawOverlap), chunkSize - 1);

  const rawMax = Number.isFinite(raw.maxChunks) ? Math.floor(raw.maxChunks!) : DEFAULT_MAX_CHUNKS_PER_TEXT;
  const maxChunks = Math.max(1, rawMax);

  return { chunkSize, chunkOverlap, maxChunks };
}

/**
 * Split `text` into overlapping character-based chunks.
 *
 * - Empty / whitespace-only input → zero chunks (caller should skip embedding).
 * - Text shorter than `chunkSize` → exactly one chunk (the text itself).
 * - Longer text → consecutive windows of `chunkSize` chars, each starting
 *   `chunkSize - chunkOverlap` chars after the previous one.
 * - If more than `maxChunks` windows would be needed, we stop at `maxChunks`
 *   and set `truncated: true`.
 *
 * @param text   The input text to split.
 * @param opts   Resolved chunk options (use {@link resolveChunkOptions}).
 */
export function splitIntoChunks(text: string, opts: ChunkOptions): ChunkResult {
  const originalLength = text.length;

  if (text.trim().length === 0) {
    return { chunks: [], truncated: false, originalLength };
  }

  if (originalLength <= opts.chunkSize) {
    return { chunks: [text], truncated: false, originalLength };
  }

  const stride = opts.chunkSize - opts.chunkOverlap; // > 0 by resolveChunkOptions invariant
  const chunks: string[] = [];
  let start = 0;
  let truncated = false;

  while (start < originalLength) {
    if (chunks.length >= opts.maxChunks) {
      // Cap reached before covering the whole text — tail dropped.
      truncated = true;
      break;
    }
    const end = Math.min(start + opts.chunkSize, originalLength);
    chunks.push(text.slice(start, end));
    if (end >= originalLength) break;
    start += stride;
  }

  return { chunks, truncated, originalLength };
}
