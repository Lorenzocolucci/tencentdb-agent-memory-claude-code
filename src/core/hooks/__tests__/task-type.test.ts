/**
 * Context Fingerprint (Idea 1) — deterministic task-type inference.
 *
 * The "kind of task" is part of a situation's fingerprint. We infer it from the
 * tool mix and error presence WITHOUT an LLM (hot path must stay fast +
 * deterministic): an error in the window means debugging; otherwise a
 * mutating tool means implementing; otherwise read/search tools mean exploring.
 */

import { describe, it, expect } from "vitest";
import { inferTaskType } from "../task-type.js";

describe("inferTaskType", () => {
  it("returns 'debug' when any error signature is present (dominates)", () => {
    expect(
      inferTaskType({ fileKeys: [], errorSignatures: ["Bash:exit1"], toolNames: ["Edit"] }),
    ).toBe("debug");
  });

  it("returns 'implement' when a mutating tool ran and no error", () => {
    expect(inferTaskType({ fileKeys: ["file:a"], errorSignatures: [], toolNames: ["Read", "Edit"] })).toBe(
      "implement",
    );
    expect(inferTaskType({ fileKeys: [], errorSignatures: [], toolNames: ["Write"] })).toBe("implement");
  });

  it("returns 'explore' for read/search tools only", () => {
    expect(inferTaskType({ fileKeys: [], errorSignatures: [], toolNames: ["Read", "Grep", "Glob"] })).toBe(
      "explore",
    );
  });

  it("returns '' for an empty situation", () => {
    expect(inferTaskType({ fileKeys: [], errorSignatures: [], toolNames: [] })).toBe("");
  });

  it("returns '' for tools that map to no task type", () => {
    expect(inferTaskType({ fileKeys: [], errorSignatures: [], toolNames: ["WebSearch"] })).toBe("");
  });
});
