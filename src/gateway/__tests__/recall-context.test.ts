/**
 * Track A slice 1 — the gateway must DELIVER the situation-relevant memories.
 *
 * performAutoRecall returns two parts: appendSystemContext (stable: persona +
 * scene nav + tools guide) and prependContext (dynamic: the <relevant-memories>
 * recalled for THIS prompt). The gateway historically shipped only the stable
 * part, silently dropping the per-prompt memories — proactive injection was
 * computed and then thrown away at the HTTP boundary. composeRecallContext
 * delivers BOTH (stable first for cache-friendliness, memories after).
 */

import { describe, it, expect } from "vitest";
import { composeRecallContext } from "../recall-context.js";

describe("composeRecallContext", () => {
  it("delivers BOTH the stable context and the situation memories", () => {
    const out = composeRecallContext({
      appendSystemContext: "<user-persona>…</user-persona>",
      prependContext: "<relevant-memories>…</relevant-memories>",
    });
    expect(out).toBe("<user-persona>…</user-persona>\n\n<relevant-memories>…</relevant-memories>");
  });

  it("delivers the memories even when there is no stable context (the dropped case)", () => {
    expect(composeRecallContext({ prependContext: "<relevant-memories>X</relevant-memories>" })).toBe(
      "<relevant-memories>X</relevant-memories>",
    );
  });

  it("delivers the stable context alone when there are no memories", () => {
    expect(composeRecallContext({ appendSystemContext: "<user-persona>P</user-persona>" })).toBe(
      "<user-persona>P</user-persona>",
    );
  });

  it("returns empty string when nothing was recalled", () => {
    expect(composeRecallContext({})).toBe("");
  });

  // Priority-aware truncation (Choice A). The dynamic part is the proactive-
  // injection payload (banner → recap → relevant-memories) and must survive
  // truncation intact; the stable part (persona/scene/guide) is reference bulk
  // and yields its tail first. Regression guard for the bug where an oversized
  // persona pushed the session-open banner past the char cap and a blind
  // tail-slice cut it off — proactive injection silently degraded.
  describe("priority-aware truncation under memory pressure", () => {
    it("keeps the WHOLE dynamic payload when the stable part is oversized", () => {
      const stable = `<user-persona>${"x".repeat(20_000)}</user-persona>`;
      const dynamic = "<session-open-banner>BANNER-KEEP</session-open-banner>";
      const out = composeRecallContext({ appendSystemContext: stable, prependContext: dynamic }, 10_000);
      expect(out.length).toBeLessThanOrEqual(10_000);
      expect(out).toContain(dynamic); // banner survives verbatim
      expect(out.endsWith(dynamic)).toBe(true); // dynamic at the tail, intact
    });

    it("trims the stable TAIL (not the dynamic head) when over budget", () => {
      const stable = `<user-persona>HEAD${"x".repeat(20_000)}TAIL</user-persona>`;
      const dynamic = "<relevant-memories>M</relevant-memories>";
      const out = composeRecallContext({ appendSystemContext: stable, prependContext: dynamic }, 10_000);
      expect(out).toContain("HEAD"); // stable head kept
      expect(out).not.toContain("TAIL"); // stable tail sacrificed
      expect(out).toContain(dynamic); // dynamic never touched
    });

    it("keeps the dynamic HEAD (banner) when the dynamic part alone overflows", () => {
      const banner = "<session-open-banner>BANNER-KEEP</session-open-banner>";
      const dynamic = `${banner}\n\n<relevant-memories>${"m".repeat(20_000)}</relevant-memories>`;
      const out = composeRecallContext({ prependContext: dynamic }, 10_000);
      expect(out.length).toBeLessThanOrEqual(10_000);
      expect(out).toContain("BANNER-KEEP"); // head (banner) survives; tail yields
    });

    it("leaves small payloads untouched", () => {
      const out = composeRecallContext({
        appendSystemContext: "<user-persona>P</user-persona>",
        prependContext: "<relevant-memories>M</relevant-memories>",
      }, 10_000);
      expect(out).toBe("<user-persona>P</user-persona>\n\n<relevant-memories>M</relevant-memories>");
    });
  });
});
