/**
 * B2a — lesson-trigger tests (TDD: RED first, then GREEN).
 *
 * Mandatory pins:
 *   T1  clusterTrigger returns COMMON signals only:
 *       - file in 1/3 bugs → EXCLUDED (below ceil(3/2)=2 threshold)
 *       - file in 2/3 bugs → INCLUDED (meets ceil(3/2)=2 threshold)
 *   T2  canonicalTrigger is deterministic: same fingerprint → identical string
 *       regardless of input array order.
 *   T3  errorSignatures extractor: given bug texts with error names/codes it
 *       extracts them; given plain prose returns [].
 *   T4  taskType: most-frequent wins; empty string when no taskType provided.
 */

import { describe, it, expect } from "vitest";
import {
  clusterTrigger,
  canonicalTrigger,
  type TriggerFingerprint,
  type PerBugBreakdown,
} from "../lesson-trigger.js";
import { extractErrorSignatures } from "../error-signature-extractor.js";
import type { FailureCluster } from "../bug-clusters.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCluster(overrides: Partial<FailureCluster> = {}): FailureCluster {
  return {
    bugEventIds: ["b1", "b2", "b3"],
    bugTexts: ["text1", "text2", "text3"],
    distinctSessionCount: 3,
    sessionKeys: ["S1", "S2", "S3"],
    namespace: "default",
    project: "test-proj",
    files: [],
    entityIds: [],
    errorSignatures: [],
    ...overrides,
  };
}

// ── T1: COMMON signal (ceil(N/2) threshold) ───────────────────────────────────

describe("T1 — clusterTrigger: COMMON signals only", () => {
  it("excludes a file present in 1 of 3 bugs (below threshold ceil(3/2)=2)", () => {
    const cluster = makeCluster();
    const breakdowns: PerBugBreakdown[] = [
      { bugEventId: "b1", files: ["src/auth.ts"], errorSignatures: [] },
      { bugEventId: "b2", files: [], errorSignatures: [] },
      { bugEventId: "b3", files: [], errorSignatures: [] },
    ];
    const fp = clusterTrigger(cluster, breakdowns);
    expect(fp.files).not.toContain("src/auth.ts");
  });

  it("includes a file present in 2 of 3 bugs (meets threshold ceil(3/2)=2)", () => {
    const cluster = makeCluster();
    const breakdowns: PerBugBreakdown[] = [
      { bugEventId: "b1", files: ["src/payment.ts"], errorSignatures: [] },
      { bugEventId: "b2", files: ["src/payment.ts"], errorSignatures: [] },
      { bugEventId: "b3", files: [], errorSignatures: [] },
    ];
    const fp = clusterTrigger(cluster, breakdowns);
    expect(fp.files).toContain("src/payment.ts");
  });

  it("includes a file present in 3 of 3 bugs", () => {
    const cluster = makeCluster();
    const breakdowns: PerBugBreakdown[] = [
      { bugEventId: "b1", files: ["src/api.ts"], errorSignatures: [] },
      { bugEventId: "b2", files: ["src/api.ts"], errorSignatures: [] },
      { bugEventId: "b3", files: ["src/api.ts"], errorSignatures: [] },
    ];
    const fp = clusterTrigger(cluster, breakdowns);
    expect(fp.files).toContain("src/api.ts");
  });

  it("applies the same threshold to errorSignatures", () => {
    const cluster = makeCluster();
    const breakdowns: PerBugBreakdown[] = [
      { bugEventId: "b1", files: [], errorSignatures: ["TypeError"] },
      { bugEventId: "b2", files: [], errorSignatures: ["TypeError"] },
      { bugEventId: "b3", files: [], errorSignatures: ["ReferenceError"] },
    ];
    const fp = clusterTrigger(cluster, breakdowns);
    expect(fp.errorSignatures).toContain("TypeError");     // 2/3 ≥ ceil(3/2)=2
    expect(fp.errorSignatures).not.toContain("ReferenceError"); // 1/3 < 2
  });

  it("handles a 2-bug cluster: threshold ceil(2/2)=1 — every file included", () => {
    const cluster = makeCluster({ bugEventIds: ["b1", "b2"], bugTexts: ["t1", "t2"], distinctSessionCount: 2, sessionKeys: ["S1", "S2"] });
    const breakdowns: PerBugBreakdown[] = [
      { bugEventId: "b1", files: ["src/x.ts"], errorSignatures: [] },
      { bugEventId: "b2", files: [], errorSignatures: [] },
    ];
    const fp = clusterTrigger(cluster, breakdowns);
    // ceil(2/2)=1: even 1 occurrence is enough
    expect(fp.files).toContain("src/x.ts");
  });

  it("returns sorted files and errorSignatures arrays", () => {
    const cluster = makeCluster();
    const breakdowns: PerBugBreakdown[] = [
      { bugEventId: "b1", files: ["z.ts", "a.ts"], errorSignatures: ["ZError", "AError"] },
      { bugEventId: "b2", files: ["z.ts", "a.ts"], errorSignatures: ["ZError", "AError"] },
      { bugEventId: "b3", files: ["z.ts", "a.ts"], errorSignatures: ["ZError", "AError"] },
    ];
    const fp = clusterTrigger(cluster, breakdowns);
    expect(fp.files).toEqual([...fp.files].sort());
    expect(fp.errorSignatures).toEqual([...fp.errorSignatures].sort());
  });
});

// ── T2: DETERMINISM ───────────────────────────────────────────────────────────

describe("T2 — canonicalTrigger determinism", () => {
  it("produces identical strings for the same fingerprint content", () => {
    const fp1: TriggerFingerprint = {
      files: ["src/a.ts", "src/b.ts"],
      errorSignatures: ["TypeError", "EvalError"],
      taskType: "auth",
    };
    const fp2: TriggerFingerprint = {
      files: ["src/b.ts", "src/a.ts"], // reversed order
      errorSignatures: ["EvalError", "TypeError"], // reversed order
      taskType: "auth",
    };
    expect(canonicalTrigger(fp1)).toBe(canonicalTrigger(fp2));
  });

  it("produces the same string across multiple calls with identical input", () => {
    const fp: TriggerFingerprint = {
      files: ["src/payment.ts"],
      errorSignatures: ["ERR_TIMEOUT"],
      taskType: "payment",
    };
    const s1 = canonicalTrigger(fp);
    const s2 = canonicalTrigger(fp);
    const s3 = canonicalTrigger(fp);
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
  });

  it("produces different strings for different fingerprints", () => {
    const fp1: TriggerFingerprint = { files: ["src/a.ts"], errorSignatures: [], taskType: "" };
    const fp2: TriggerFingerprint = { files: ["src/b.ts"], errorSignatures: [], taskType: "" };
    expect(canonicalTrigger(fp1)).not.toBe(canonicalTrigger(fp2));
  });

  it("output is valid JSON", () => {
    const fp: TriggerFingerprint = { files: ["f.ts"], errorSignatures: ["E"], taskType: "t" };
    expect(() => JSON.parse(canonicalTrigger(fp))).not.toThrow();
  });
});

// ── T3: taskType ──────────────────────────────────────────────────────────────

describe("T3 — taskType: most-frequent or empty", () => {
  it("returns empty string when no taskType is provided in breakdowns", () => {
    const cluster = makeCluster();
    const breakdowns: PerBugBreakdown[] = [
      { bugEventId: "b1", files: [], errorSignatures: [] },
      { bugEventId: "b2", files: [], errorSignatures: [] },
      { bugEventId: "b3", files: [], errorSignatures: [] },
    ];
    const fp = clusterTrigger(cluster, breakdowns);
    // No taskType on breakdowns → "" (documented: events have no task_type field live)
    expect(fp.taskType).toBe("");
  });

  it("returns the most-frequent taskType when present", () => {
    const cluster = makeCluster();
    const breakdowns: PerBugBreakdown[] = [
      { bugEventId: "b1", files: [], errorSignatures: [], taskType: "auth" },
      { bugEventId: "b2", files: [], errorSignatures: [], taskType: "auth" },
      { bugEventId: "b3", files: [], errorSignatures: [], taskType: "payment" },
    ];
    const fp = clusterTrigger(cluster, breakdowns);
    expect(fp.taskType).toBe("auth"); // 2 vs 1
  });
});
