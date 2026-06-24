/**
 * Deterministic task-type inference (Context Fingerprint / Idea 1).
 *
 * The "kind of task" is one axis of a situation fingerprint. It is inferred from
 * the tool mix + error presence — NO LLM, so it stays fast and deterministic on
 * the hot path. Precedence: an error means we are DEBUGGING; otherwise a
 * mutating tool means IMPLEMENTING; otherwise read/search tools mean EXPLORING.
 */

import type { SessionSituation } from "./session-situation.js";

export type TaskType = "debug" | "implement" | "explore" | "";

const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const EXPLORING_TOOLS = new Set(["Read", "Grep", "Glob"]);

/** Infer the current task type from the situation's tool mix + errors. */
export function inferTaskType(situation: SessionSituation): TaskType {
  if (situation.errorSignatures.length > 0) return "debug";
  if (situation.toolNames.some((t) => MUTATING_TOOLS.has(t))) return "implement";
  if (situation.toolNames.some((t) => EXPLORING_TOOLS.has(t))) return "explore";
  return "";
}
