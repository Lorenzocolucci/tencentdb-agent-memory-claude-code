/**
 * Live 05/10/2026: reading a Sinapsys file surfaced "00-STATO.md: 15.2 KB, tetto 12 KB"
 * (a RISTRUTTURAZIONE file) as related — a task-type-only match, from another project.
 */
import { describe, it, expect } from "vitest";
import { scoreFingerprint } from "../fingerprint-similarity.js";
import { sameProjectFingerprints } from "../fingerprint-injection.js";
import type { StoredFingerprint } from "../../kb/fingerprint-writer.js";

describe("a task type alone is not a similar situation", () => {
  it("scores 0 without a shared file or error, whatever the task type", () => {
    expect(scoreFingerprint({ fileKeys: [], errorSignatures: [], taskType: "debugging" }, { fileKeys: [], errorSignatures: [], taskType: "debugging" })).toBe(0);
    expect(scoreFingerprint({ fileKeys: ["a.ts"], errorSignatures: [], taskType: "edit" }, { fileKeys: ["b.ts"], errorSignatures: [], taskType: "edit" })).toBe(0);
  });
  it("a shared file still matches, and the task type still adds weight", () => {
    const withTask = scoreFingerprint({ fileKeys: ["a.ts", "b.ts"], errorSignatures: [], taskType: "edit" }, { fileKeys: ["a.ts"], errorSignatures: [], taskType: "edit" });
    const noTask = scoreFingerprint({ fileKeys: ["a.ts", "b.ts"], errorSignatures: [], taskType: "" }, { fileKeys: ["a.ts"], errorSignatures: [], taskType: "" });
    expect(noTask).toBeCloseTo(0.5);
    expect(withTask).toBeGreaterThan(noTask);
  });
});

describe("situations of another project never match", () => {
  const fp = (session_key: string): StoredFingerprint =>
    ({ id: session_key, session_key, ts: "", fileKeys: [], errorSignatures: [], taskType: "", toolNames: [], matchedOwnerIds: [], namespace: "default" });
  const projects: Record<string, string> = { s1: "tencentdb-agent-memory", s2: "RISTRUTTURAZIONE" };
  const conflict = (a: string, b: string) => a.toLowerCase() !== b.toLowerCase();
  it("keeps this project's and unknown sessions, drops the others", () => {
    const kept = sameProjectFingerprints([fp("s1"), fp("s2"), fp("s3")], "tencentdb-agent-memory", (k) => projects[k], conflict);
    expect(kept.map((f) => f.session_key)).toEqual(["s1", "s3"]);
  });
  it("without a current project nothing is filtered", () => {
    expect(sameProjectFingerprints([fp("s1"), fp("s2")], undefined, (k) => projects[k], conflict)).toHaveLength(2);
  });
});
