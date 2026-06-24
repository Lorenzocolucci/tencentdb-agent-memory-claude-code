/**
 * Bug embeddings — read a Float32 embedding from the sqlite-vec shadow tables.
 *
 * This module is the SINGLE swap-point if sqlite-vec's alpha storage format changes.
 * Production layout (v0.1.7-alpha, dims=1536):
 *   kb_vec_rowids: id = "event:<eventId>#<chunkIndex>", chunk_id, chunk_offset
 *   kb_vec_vector_chunks00: rowid = chunk_id, vectors = BLOB
 *
 * The blob stores `chunk_size` vectors packed consecutively (each `dims * 4` bytes).
 * slot index = chunk_offset; startByte = chunk_offset * dims * 4.
 *
 * Dependency injection: callers receive an EmbeddingReader callback instead of
 * importing sqlite-vec internals directly — lets tests inject a Map-backed fake.
 */

import type { DatabaseSync } from "node:sqlite";

/** Read a Float32 embedding for one event id. Returns null when not stored. */
export type EmbeddingReader = (eventId: string) => Float32Array | null;

// ── Internal DB row types ─────────────────────────────────────────────────────

interface VecRowidRow {
  id: string;
  chunk_id: number;
  chunk_offset: number;
}

// ── Production reader factory ─────────────────────────────────────────────────

/**
 * Create an EmbeddingReader backed by the sqlite-vec shadow tables in `db`.
 *
 * `dims` must match the embedding dimension stored in the DB (live = 1536).
 * Passing the wrong `dims` yields a misaligned slice and null is returned —
 * never silently corrupt data.
 *
 * Never throws: any DB or buffer error degrades to null for that event.
 */
export function createKbVecEmbeddingReader(db: DatabaseSync, dims = 1536): EmbeddingReader {
  return function readEmbedding(eventId: string): Float32Array | null {
    try {
      const compositeId = `event:${eventId}#0`;
      const ridRow = db
        .prepare(
          "SELECT id, chunk_id, chunk_offset FROM kb_vec_rowids WHERE id = ? LIMIT 1",
        )
        .get(compositeId) as VecRowidRow | undefined;
      if (!ridRow) return null;

      const blobRow = db
        .prepare("SELECT vectors FROM kb_vec_vector_chunks00 WHERE rowid = ?")
        .get(ridRow.chunk_id) as { vectors: unknown } | undefined;
      if (!blobRow) return null;

      // node:sqlite returns BLOBs as Uint8Array (not Buffer). Accept both.
      const raw = blobRow.vectors;
      let buffer: Buffer;
      if (Buffer.isBuffer(raw)) {
        buffer = raw;
      } else if (raw instanceof Uint8Array) {
        buffer = Buffer.from(raw);
      } else {
        buffer = Buffer.from(Object.values(raw as Record<string, number>));
      }

      if (buffer.length === 0 || buffer.length % 4 !== 0) return null;

      // Deterministic slice: startByte = chunk_offset * dims * 4, length = dims * 4.
      // `dims` is an explicit parameter — no magic threshold heuristics.
      const startByte = ridRow.chunk_offset * dims * 4;
      if (buffer.length < startByte + dims * 4) return null;

      const slice = buffer.slice(startByte, startByte + dims * 4);
      const copy = new ArrayBuffer(dims * 4);
      Buffer.from(copy).set(slice);
      return new Float32Array(copy);
    } catch {
      return null;
    }
  };
}

/**
 * Build a fake EmbeddingReader from a Map<eventId, Float32Array>.
 * Useful in tests to avoid seeding sqlite-vec shadow tables by hand.
 */
export function fakeEmbeddingReader(map: Map<string, Float32Array>): EmbeddingReader {
  return (eventId: string) => map.get(eventId) ?? null;
}
