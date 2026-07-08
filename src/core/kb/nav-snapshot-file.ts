/**
 * On-disk envelope for the kb_vec navigable-index snapshot (Incremento b).
 *
 * WHY (see HANDOFF.md, Incremento C caveat 1): after a restart the index used to
 * rebuild from scratch — ~25k HNSW insertions in pure JS = minutes, during which
 * recall is slow. Persisting the GRAPH lets a restart re-hydrate the vectors from
 * the DB and re-attach the persisted small-world links, skipping the expensive
 * construction entirely.
 *
 * The snapshot is GRAPH-ONLY (see {@link NavigableIndexTopology}): it carries the
 * neighbor links + levels, never the vectors. This keeps the file tiny (no
 * 4-bytes-per-dimension payload duplicated next to the DB) and — crucially — means
 * the vectors are always read fresh from the DB, so a stale snapshot can never
 * serve an out-of-date vector. Freshness is guarded by {@link KbNavSnapshotFile.dim}
 * (hard match) + {@link KbNavSnapshotFile.rowCount} (tolerance band in the store):
 * on any mismatch the store discards the snapshot and rebuilds — correctness is
 * never sacrificed for speed.
 *
 * This module is intentionally small and side-effect-light: pure encode/decode +
 * validation, plus atomic file read/write. All fs errors are swallowed to null so
 * a missing/corrupt snapshot degrades to a clean rebuild, never a crash.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import type { NavigableIndexTopology } from "./navigable-index.js";

/** The persisted envelope. `formatVersion` gates forward/backward incompatibility. */
export interface KbNavSnapshotFile {
  readonly formatVersion: 1;
  /** Embedding dimensionality at persist time — MUST equal the store's dims on load. */
  readonly dim: number;
  /** kb_vec chunk-row count at persist time — freshness signal (tolerance band on load). */
  readonly rowCount: number;
  /** Wall-clock persist time (ms). Observability only — never used for load logic. */
  readonly builtAtMs: number;
  /** The graph-only index topology (no vectors). */
  readonly topology: NavigableIndexTopology;
}

/** The current on-disk format version. Bump on any breaking envelope change. */
export const KB_NAV_SNAPSHOT_FORMAT = 1 as const;

/** Serialize an envelope to its on-disk JSON string. */
export function encodeKbNavSnapshot(file: KbNavSnapshotFile): string {
  return JSON.stringify(file);
}

/**
 * Parse + VALIDATE an on-disk snapshot string. Throws RangeError on any
 * structural problem (unsupported version, bad dim/rowCount, missing topology)
 * so the caller treats a corrupt file as "no snapshot" and rebuilds.
 * @throws SyntaxError on malformed JSON, RangeError on an invalid envelope.
 */
export function decodeKbNavSnapshot(text: string): KbNavSnapshotFile {
  const obj = JSON.parse(text) as Partial<KbNavSnapshotFile>;
  if (!obj || typeof obj !== "object") {
    throw new RangeError("kb-nav snapshot: not an object");
  }
  if (obj.formatVersion !== KB_NAV_SNAPSHOT_FORMAT) {
    throw new RangeError(`kb-nav snapshot: unsupported formatVersion ${String(obj.formatVersion)}`);
  }
  if (!Number.isInteger(obj.dim) || (obj.dim as number) <= 0) {
    throw new RangeError("kb-nav snapshot: invalid dim");
  }
  if (!Number.isInteger(obj.rowCount) || (obj.rowCount as number) < 0) {
    throw new RangeError("kb-nav snapshot: invalid rowCount");
  }
  const topo = obj.topology;
  if (!topo || topo.version !== 1 || !Array.isArray(topo.nodes)) {
    throw new RangeError("kb-nav snapshot: invalid topology");
  }
  if (topo.dim !== obj.dim) {
    throw new RangeError("kb-nav snapshot: envelope/topology dim mismatch");
  }
  return obj as KbNavSnapshotFile;
}

/**
 * Atomically write `text` to `path` (temp file + rename on the same directory,
 * so a crash mid-write never leaves a half-written snapshot at `path`).
 * @throws on any fs failure — callers wrap best-effort.
 */
export function writeKbNavSnapshotAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Clean up the temp file so a failed rename does not leak it.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Read a snapshot file, or null if it is absent/unreadable (→ clean rebuild). */
export function readKbNavSnapshot(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Best-effort delete of a stale/corrupt snapshot. Never throws. */
export function deleteKbNavSnapshot(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best effort */
  }
}
