/**
 * recap-selector — pure transform of a session's KB events into a RecapInput.
 *
 * Filters to thread-bearing types, derives the project (most common non-empty),
 * unions provenance, and picks the most recent `task` or `decision` as the
 * explicit next-step. Immutable: reads the input array, returns a new object.
 */
import type { KbEvent } from "../store/types.js";
import { isThreadType, type RecapInput, type ThreadItem } from "./recap-types.js";

const NEXT_STEP_TYPES = new Set(["task", "decision"]);

function toItem(e: KbEvent): ThreadItem {
  return { type: e.type, text: e.text, sourceMessageIds: e.source_message_ids ?? [] };
}

function deriveProject(events: readonly KbEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.project) counts.set(e.project, (counts.get(e.project) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
  return best;
}

export function selectThread(events: readonly KbEvent[], sessionDateIso: string): RecapInput {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const threadEvents = sorted.filter((e) => isThreadType(e.type));

  // Most recent task/decision = the explicit next-step.
  let nextStep: ThreadItem | undefined;
  for (let i = threadEvents.length - 1; i >= 0; i--) {
    if (NEXT_STEP_TYPES.has(threadEvents[i].type)) {
      nextStep = toItem(threadEvents[i]);
      break;
    }
  }

  return {
    project: deriveProject(sorted),
    sessionDateIso,
    nextStep,
    thread: threadEvents.map(toItem),
  };
}
