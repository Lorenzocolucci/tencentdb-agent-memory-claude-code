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
});
