/**
 * lesson-trigger.ts (B2a, pure, no I/O, no LLM).
 *
 * Converts a FailureCluster into a deterministic TriggerFingerprint and
 * serialises it to a canonical JSON string that becomes lessons.trigger_pattern.
 *
 * KEY DESIGN: the trigger is the COMMON signal, NOT the union.
 *   A file or errorSignature is included only when it appears in
 *   AT LEAST ceil(N/2) of the cluster's N bug events (dominant/shared pattern).
 *   Union over-triggers; common captures the recurring pattern.
 *
 * Signature: clusterTrigger(cluster, breakdowns)
 *   breakdowns — per-bug { files, errorSignatures, taskType? }
 *   This avoids mutating the cluster; the caller builds breakdowns from
 *   their extraction step (e.g. by running extractErrorSignatures over
 *   each bug text and resolving file entity ids per bug).
 *
 * taskType: most-frequent value across breakdowns (ignoring "" / undefined).
 *   If no breakdown carries a taskType, returns "" and that is documented
 *   (live events have no task_type field today — see honesty-check in spec).
 *
 * canonicalTrigger(fp): sorted arrays → JSON — deterministic, same cluster
 *   → identical string every run (versioning identity depends on this).
 */

import type { FailureCluster } from "./bug-clusters.js";

// ── Public types ───────────────────────────────────────────────────────────────

/** Mirrors context_fingerprints columns: files, error_signatures, task_type. */
export interface TriggerFingerprint {
  /** Files present in ≥ ceil(N/2) of the cluster's bug events. */
  files: string[];
  /** Error signatures present in ≥ ceil(N/2) of the cluster's bug events. */
  errorSignatures: string[];
  /**
   * Most-frequent task_type among the cluster's bug events.
   * Empty string when no event carries a task_type (current live reality).
   */
  taskType: string;
}

/** Per-bug breakdown supplied by the caller (avoids coupling to DB inside this module). */
export interface PerBugBreakdown {
  bugEventId: string;
  /** File entity ids linked to this bug event. */
  files: string[];
  /** Error signatures extracted from this bug event's text. */
  errorSignatures: string[];
  /**
   * Optional task_type for this bug event.
   * Omit or set "" when the event has no task_type (the live default).
   */
  taskType?: string;
}

// ── Threshold ──────────────────────────────────────────────────────────────────

/** Minimum occurrence count for a signal to be "common" in N events. */
function commonThreshold(n: number): number {
  return Math.ceil(n / 2);
}

// ── Core computation ───────────────────────────────────────────────────────────

/**
 * Compute the TriggerFingerprint for a cluster.
 *
 * @param cluster - the FailureCluster (provides N = bugEventIds.length)
 * @param breakdowns - per-bug file + errorSignature breakdown (same order or
 *   keyed by bugEventId; extra entries for ids not in cluster are ignored)
 */
export function clusterTrigger(
  cluster: FailureCluster,
  breakdowns: readonly PerBugBreakdown[],
): TriggerFingerprint {
  const n = cluster.bugEventIds.length;
  if (n === 0) {
    return { files: [], errorSignatures: [], taskType: "" };
  }

  // Build a lookup by bugEventId for the breakdowns that belong to this cluster
  const byId = new Map<string, PerBugBreakdown>();
  for (const bd of breakdowns) {
    if (cluster.bugEventIds.includes(bd.bugEventId)) {
      byId.set(bd.bugEventId, bd);
    }
  }

  const threshold = commonThreshold(n);

  // Count occurrences of each file and errorSignature across the cluster's bugs
  const fileCounts = new Map<string, number>();
  const sigCounts = new Map<string, number>();
  const taskTypeCounts = new Map<string, number>();

  for (const bugId of cluster.bugEventIds) {
    const bd = byId.get(bugId);
    if (!bd) continue;

    const seenFiles = new Set(bd.files);
    for (const f of seenFiles) {
      fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    }

    const seenSigs = new Set(bd.errorSignatures);
    for (const s of seenSigs) {
      sigCounts.set(s, (sigCounts.get(s) ?? 0) + 1);
    }

    const tt = bd.taskType;
    if (tt && tt.length > 0) {
      taskTypeCounts.set(tt, (taskTypeCounts.get(tt) ?? 0) + 1);
    }
  }

  // Keep only signals that meet the threshold
  const commonFiles = [...fileCounts.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([f]) => f)
    .sort();

  const commonSigs = [...sigCounts.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([s]) => s)
    .sort();

  // Most-frequent taskType (first alphabetically on tie for determinism)
  let taskType = "";
  let maxCount = 0;
  for (const [tt, count] of [...taskTypeCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > maxCount) {
      taskType = tt;
      maxCount = count;
    }
  }

  return {
    files: commonFiles,
    errorSignatures: commonSigs,
    taskType,
  };
}

// ── Canonical serialisation ────────────────────────────────────────────────────

/**
 * Serialise a TriggerFingerprint to a deterministic canonical JSON string.
 * Arrays are always sorted; keys are in fixed order.
 * Same cluster → identical string every run (versioning identity depends on this).
 */
export function canonicalTrigger(fp: TriggerFingerprint): string {
  return JSON.stringify({
    files: [...fp.files].sort(),
    error_signatures: [...fp.errorSignatures].sort(),
    task_type: fp.taskType,
  });
}
