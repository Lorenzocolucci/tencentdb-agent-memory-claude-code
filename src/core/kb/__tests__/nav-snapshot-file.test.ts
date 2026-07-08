/**
 * kb-nav snapshot file envelope — unit tests (Incremento b).
 *
 * Covers the on-disk contract: encode/decode round-trip, strict validation of a
 * corrupt/incompatible envelope (→ treated as "no snapshot"), and atomic
 * write/read/delete against a real temp directory.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeKbNavSnapshot,
  deleteKbNavSnapshot,
  encodeKbNavSnapshot,
  readKbNavSnapshot,
  writeKbNavSnapshotAtomic,
  type KbNavSnapshotFile,
} from "../nav-snapshot-file.js";
import { NavigableIndex } from "../navigable-index.js";

const f32 = (nums: number[]) => Float32Array.from(nums);

function makeFile(): KbNavSnapshotFile {
  const idx = new NavigableIndex(4, { seed: 7 });
  idx.add("a", f32([1, 0, 0, 0]));
  idx.add("b", f32([0, 1, 0, 0]));
  idx.add("c", f32([0, 0, 1, 0]));
  return {
    formatVersion: 1,
    dim: 4,
    rowCount: 3,
    builtAtMs: 1_700_000_000_000,
    topology: idx.serializeTopology(),
  };
}

describe("nav-snapshot-file — encode / decode round-trip", () => {
  it("re-parses to an equivalent envelope", () => {
    const file = makeFile();
    const decoded = decodeKbNavSnapshot(encodeKbNavSnapshot(file));
    expect(decoded.formatVersion).toBe(1);
    expect(decoded.dim).toBe(4);
    expect(decoded.rowCount).toBe(3);
    expect(decoded.topology.nodes.length).toBe(3);
  });

  it("preserves a topology that restores to a working index", () => {
    const file = makeFile();
    const decoded = decodeKbNavSnapshot(encodeKbNavSnapshot(file));
    const vecById = new Map([
      ["a", f32([1, 0, 0, 0])],
      ["b", f32([0, 1, 0, 0])],
      ["c", f32([0, 0, 1, 0])],
    ]);
    const { index } = NavigableIndex.restoreFromTopology(decoded.topology, vecById);
    expect(index.search(f32([1, 0, 0, 0]), 1)[0].id).toBe("a");
  });
});

describe("nav-snapshot-file — validation (corrupt → treated as no snapshot)", () => {
  it("throws SyntaxError on malformed JSON", () => {
    expect(() => decodeKbNavSnapshot("{not json")).toThrow(SyntaxError);
  });

  it("throws RangeError on an unsupported formatVersion", () => {
    const bad = JSON.stringify({ ...makeFile(), formatVersion: 2 });
    expect(() => decodeKbNavSnapshot(bad)).toThrow(RangeError);
  });

  it("throws RangeError on an invalid dim", () => {
    const bad = JSON.stringify({ ...makeFile(), dim: 0 });
    expect(() => decodeKbNavSnapshot(bad)).toThrow(RangeError);
  });

  it("throws RangeError on a negative rowCount", () => {
    const bad = JSON.stringify({ ...makeFile(), rowCount: -1 });
    expect(() => decodeKbNavSnapshot(bad)).toThrow(RangeError);
  });

  it("throws RangeError when the topology is missing", () => {
    const { topology: _omit, ...rest } = makeFile();
    void _omit;
    expect(() => decodeKbNavSnapshot(JSON.stringify(rest))).toThrow(RangeError);
  });

  it("throws RangeError when envelope dim and topology dim disagree", () => {
    const file = makeFile();
    const bad = JSON.stringify({ ...file, dim: 8 }); // topology.dim stays 4
    expect(() => decodeKbNavSnapshot(bad)).toThrow(RangeError);
  });
});

describe("nav-snapshot-file — atomic file I/O", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-nav-snap-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes atomically and reads back, leaving no temp file", () => {
    const path = join(dir, "kb-nav-index.v1.snapshot.json");
    const text = encodeKbNavSnapshot(makeFile());
    writeKbNavSnapshotAtomic(path, text);
    expect(readKbNavSnapshot(path)).toBe(text);
    expect(existsSync(`${path}.tmp.${process.pid}`)).toBe(false);
  });

  it("overwrites an existing snapshot in place", () => {
    const path = join(dir, "overwrite.json");
    writeKbNavSnapshotAtomic(path, "first");
    writeKbNavSnapshotAtomic(path, "second");
    expect(readKbNavSnapshot(path)).toBe("second");
  });

  it("returns null for a missing file", () => {
    expect(readKbNavSnapshot(join(dir, "does-not-exist.json"))).toBeNull();
  });

  it("deletes a snapshot (idempotent — no throw when already gone)", () => {
    const path = join(dir, "to-delete.json");
    writeFileSync(path, "x", "utf8");
    expect(existsSync(path)).toBe(true);
    deleteKbNavSnapshot(path);
    expect(existsSync(path)).toBe(false);
    expect(() => deleteKbNavSnapshot(path)).not.toThrow();
  });

  it("round-trips a decoded envelope from disk", () => {
    const path = join(dir, "roundtrip.json");
    writeKbNavSnapshotAtomic(path, encodeKbNavSnapshot(makeFile()));
    const raw = readKbNavSnapshot(path);
    expect(raw).not.toBeNull();
    const decoded = decodeKbNavSnapshot(raw!);
    expect(decoded.topology.nodes.length).toBe(3);
    // Sanity: the persisted file carries NO vector payload.
    expect(readFileSync(path, "utf8")).not.toContain('"v"');
  });
});
