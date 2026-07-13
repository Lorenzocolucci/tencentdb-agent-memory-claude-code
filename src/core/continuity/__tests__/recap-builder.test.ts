import { describe, it, expect } from "vitest";
import { buildRecapText } from "../recap-builder.js";
import type { RecapInput } from "../recap-types.js";

const base: RecapInput = {
  project: "tencentdb-agent-memory",
  sessionDateIso: "2026-06-29T12:00:00.000Z",
  nextStep: { type: "task", text: "Wire scorer live with per-session cache", sourceMessageIds: ["m1"] },
  thread: [
    { type: "decision", text: "Chose approach B: anchored recap", sourceMessageIds: ["m2"] },
    { type: "fix", text: "Record injection AFTER block built", sourceMessageIds: ["m3"] },
  ],
};

describe("buildRecapText", () => {
  it("emits a project+date header, next-step, and anchored thread lines", () => {
    const out = buildRecapText(base);
    expect(out).toContain("DOVE ERAVAMO — tencentdb-agent-memory");
    expect(out).toContain("Prossimo passo: Wire scorer live");
    expect(out).toContain("Chose approach B");
    expect(out).toContain("[anchor: msg m2]");
  });
  it("drops thread items with no source message ids (every line anchored)", () => {
    const out = buildRecapText({
      ...base,
      thread: [{ type: "decision", text: "unanchored", sourceMessageIds: [] }],
    });
    expect(out).not.toContain("unanchored");
  });
  it("returns empty string when there is no next-step and no thread", () => {
    expect(buildRecapText({ ...base, nextStep: undefined, thread: [] })).toBe("");
  });
});
