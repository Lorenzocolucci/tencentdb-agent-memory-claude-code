/** Shared types for the "Dove eravamo" session-continuity recap. */

/** Event types that carry the session's "thread" (decisions/why/next), not routine noise. */
export const THREAD_EVENT_TYPES = Object.freeze([
  "decision",
  "task",
  "fix",
  "result",
  "bug",
  "config_change",
] as const);

export function isThreadType(type: string): boolean {
  return (THREAD_EVENT_TYPES as readonly string[]).includes(type);
}

/** A single anchored line of the recap thread. */
export interface ThreadItem {
  readonly type: string;
  readonly text: string;
  /** Provenance message ids for this item (anchor). Empty → item is dropped upstream. */
  readonly sourceMessageIds: readonly string[];
}

/** Everything the recap builder needs (Phase 1: no git facts yet). */
export interface RecapInput {
  readonly project: string;
  readonly sessionDateIso: string;
  /** The explicit next step, if one was found (anchored). */
  readonly nextStep?: ThreadItem;
  /** The thread items, most-recent-last. */
  readonly thread: readonly ThreadItem[];
}
