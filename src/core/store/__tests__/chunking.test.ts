import { describe, it, expect } from "vitest";
import {
  splitIntoChunks,
  resolveChunkOptions,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  MAX_SAFE_CHUNK_SIZE,
} from "../chunking.js";

describe("resolveChunkOptions", () => {
  it("applies defaults for missing values", () => {
    const o = resolveChunkOptions({});
    expect(o.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    expect(o.chunkOverlap).toBe(DEFAULT_CHUNK_OVERLAP);
    expect(o.maxChunks).toBeGreaterThanOrEqual(1);
  });

  it("clamps chunkSize to the safe ceiling", () => {
    const o = resolveChunkOptions({ chunkSize: 1_000_000 });
    expect(o.chunkSize).toBe(MAX_SAFE_CHUNK_SIZE);
  });

  it("forces overlap strictly below chunkSize so the window advances", () => {
    const o = resolveChunkOptions({ chunkSize: 100, chunkOverlap: 500 });
    expect(o.chunkOverlap).toBeLessThan(o.chunkSize);
    // stride = chunkSize - overlap must be > 0
    expect(o.chunkSize - o.chunkOverlap).toBeGreaterThan(0);
  });

  it("floors fractional and clamps negative inputs", () => {
    const o = resolveChunkOptions({ chunkSize: 50.9, chunkOverlap: -5, maxChunks: 0 });
    expect(o.chunkSize).toBe(50);
    expect(o.chunkOverlap).toBe(0);
    expect(o.maxChunks).toBe(1);
  });
});

describe("splitIntoChunks", () => {
  it("returns zero chunks for empty / whitespace-only input", () => {
    const opts = resolveChunkOptions({});
    expect(splitIntoChunks("", opts).chunks).toEqual([]);
    expect(splitIntoChunks("   \n\t ", opts).chunks).toEqual([]);
  });

  it("returns exactly ONE chunk for short text", () => {
    const opts = resolveChunkOptions({ chunkSize: 2000, chunkOverlap: 200 });
    const text = "a short memory line";
    const res = splitIntoChunks(text, opts);
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]).toBe(text);
    expect(res.truncated).toBe(false);
  });

  it("returns ONE chunk when length equals chunkSize exactly", () => {
    const opts = resolveChunkOptions({ chunkSize: 100, chunkOverlap: 10 });
    const text = "x".repeat(100);
    const res = splitIntoChunks(text, opts);
    expect(res.chunks).toHaveLength(1);
  });

  it("splits a >5000-char text into MULTIPLE overlapping chunks", () => {
    const opts = resolveChunkOptions({ chunkSize: 2000, chunkOverlap: 200 });
    const text = "y".repeat(5001);
    const res = splitIntoChunks(text, opts);
    // stride = 1800 → windows at 0,1800,3600 (covers up to 5600 >= 5001) = 3 chunks
    expect(res.chunks.length).toBeGreaterThan(1);
    expect(res.truncated).toBe(false);
    // Every chunk respects the size bound.
    for (const c of res.chunks) expect(c.length).toBeLessThanOrEqual(opts.chunkSize);
    // Consecutive chunks overlap by chunkOverlap chars.
    expect(res.chunks[0].slice(-opts.chunkOverlap)).toBe(res.chunks[1].slice(0, opts.chunkOverlap));
  });

  it("covers the whole text (last chunk reaches the end)", () => {
    const opts = resolveChunkOptions({ chunkSize: 1000, chunkOverlap: 100 });
    const text = "z".repeat(4321);
    const res = splitIntoChunks(text, opts);
    const last = res.chunks[res.chunks.length - 1];
    // The final chunk must include the final character of the input.
    expect(text.endsWith(last)).toBe(true);
  });

  it("caps at maxChunks and flags truncated when the tail is dropped", () => {
    const opts = resolveChunkOptions({ chunkSize: 100, chunkOverlap: 0, maxChunks: 3 });
    const text = "q".repeat(1000); // would need 10 chunks at stride 100
    const res = splitIntoChunks(text, opts);
    expect(res.chunks).toHaveLength(3);
    expect(res.truncated).toBe(true);
    expect(res.originalLength).toBe(1000);
  });
});
