/**
 * CornerstoneSessionCache — the 1×/session contract for the distinctiveness block.
 *
 * The cache is what keeps the corpus-embedding cost OFF the per-turn critical path:
 * compute once on the first turn (MISS), reuse for the rest of the session (HIT).
 * The subtle, must-hold property: a committed "" is a HIT (computed-empty → never
 * recompute), distinct from undefined (never computed → MISS). A naive truthiness
 * check would recompute every turn whenever a session has no cornerstones.
 */

import { describe, it, expect } from "vitest";
import { CornerstoneSessionCache } from "../cornerstone-cache.js";

describe("CornerstoneSessionCache", () => {
  it("is a MISS before anything is committed", () => {
    const cache = new CornerstoneSessionCache();
    expect(cache.pending("s1")).toBe(true);
    expect(cache.get("s1")).toBeUndefined();
  });

  it("is a HIT after commit and returns the exact block (compute once, reuse)", () => {
    const cache = new CornerstoneSessionCache();
    const block = "<cornerstone-memories>\n- foo\n</cornerstone-memories>";
    cache.commit("s1", block);
    expect(cache.pending("s1")).toBe(false);
    expect(cache.get("s1")).toBe(block);
  });

  it('treats a committed empty string "" as a HIT, NOT a miss (no recompute)', () => {
    const cache = new CornerstoneSessionCache();
    cache.commit("s1", "");
    // The whole point: "" must be distinguishable from undefined.
    expect(cache.pending("s1")).toBe(false);
    expect(cache.get("s1")).toBe("");
    expect(cache.get("s1")).not.toBeUndefined();
  });

  it("keeps sessions independent (one computed, another still a miss)", () => {
    const cache = new CornerstoneSessionCache();
    cache.commit("s1", "block-1");
    expect(cache.get("s1")).toBe("block-1");
    expect(cache.pending("s2")).toBe(true);
    expect(cache.get("s2")).toBeUndefined();
  });
});
