/**
 * Context Fingerprint (Idea 1) — the per-session rolling situation.
 *
 * A situation is the SHAPE of what the agent is doing right now: a bounded
 * window of recently-touched files, the error signatures seen, and the recent
 * tool names. updateSituation is PURE and IMMUTABLE — it returns a new
 * situation, never mutates the previous one. Bounding keeps it cheap and keeps
 * the fingerprint focused on the *current* moment, not the whole session.
 */

import { describe, it, expect } from "vitest";
import {
  EMPTY_SITUATION,
  updateSituation,
  type SessionSituation,
} from "../session-situation.js";

describe("updateSituation", () => {
  it("appends a new file key to an empty situation", () => {
    const next = updateSituation(EMPTY_SITUATION, { toolName: "Read", fileKey: "file:a.ts" });
    expect(next.fileKeys).toEqual(["file:a.ts"]);
    expect(next.toolNames).toEqual(["Read"]);
  });

  it("does not mutate the previous situation (immutability)", () => {
    const prev: SessionSituation = { fileKeys: [], errorSignatures: [], toolNames: [] };
    updateSituation(prev, { toolName: "Edit", fileKey: "file:a.ts" });
    expect(prev.fileKeys).toEqual([]);
    expect(prev.toolNames).toEqual([]);
  });

  it("dedupes a repeated file key, moving it to most-recent", () => {
    let s = EMPTY_SITUATION;
    s = updateSituation(s, { toolName: "Read", fileKey: "file:a.ts" });
    s = updateSituation(s, { toolName: "Read", fileKey: "file:b.ts" });
    s = updateSituation(s, { toolName: "Edit", fileKey: "file:a.ts" });
    expect(s.fileKeys).toEqual(["file:b.ts", "file:a.ts"]);
  });

  it("bounds the file window to the most recent 5", () => {
    let s = EMPTY_SITUATION;
    for (const k of ["f1", "f2", "f3", "f4", "f5", "f6"]) {
      s = updateSituation(s, { toolName: "Read", fileKey: `file:${k}` });
    }
    expect(s.fileKeys).toEqual(["file:f2", "file:f3", "file:f4", "file:f5", "file:f6"]);
  });

  it("records an error signature when present and dedupes it", () => {
    let s = updateSituation(EMPTY_SITUATION, { toolName: "Bash", errorSignature: "Bash:exit1" });
    s = updateSituation(s, { toolName: "Bash", errorSignature: "Bash:exit1" });
    expect(s.errorSignatures).toEqual(["Bash:exit1"]);
  });

  it("tracks a bounded window of recent tool names", () => {
    let s = EMPTY_SITUATION;
    for (let i = 0; i < 10; i++) s = updateSituation(s, { toolName: `T${i}` });
    expect(s.toolNames.length).toBeLessThanOrEqual(8);
    expect(s.toolNames[s.toolNames.length - 1]).toBe("T9");
  });

  it("handles an event with neither file nor error (tool-only)", () => {
    const next = updateSituation(EMPTY_SITUATION, { toolName: "Grep" });
    expect(next.fileKeys).toEqual([]);
    expect(next.errorSignatures).toEqual([]);
    expect(next.toolNames).toEqual(["Grep"]);
  });
});
