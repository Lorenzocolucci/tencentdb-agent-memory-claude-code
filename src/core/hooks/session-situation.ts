/**
 * Per-session rolling situation (Context Fingerprint / Idea 1).
 *
 * A "situation" is the SHAPE of what the agent is doing right now: a bounded
 * window of recently-touched files + the error signatures seen + the recent
 * tool names. It is the raw material a fingerprint is built from and matched on.
 *
 * Pure + immutable: {@link updateSituation} returns a NEW situation and never
 * mutates its input (coding-style rule). Windows are bounded so the fingerprint
 * stays focused on the *current* moment, not the entire session, and so the
 * in-memory per-session state can never grow unbounded.
 */

/** A bounded snapshot of the current working situation. */
export interface SessionSituation {
  /** Recent canonical file keys, oldest→newest, deduped, capped. */
  readonly fileKeys: readonly string[];
  /** Coarse error signatures seen recently, deduped, capped. */
  readonly errorSignatures: readonly string[];
  /** Recent tool names, oldest→newest, capped (used for task-type inference). */
  readonly toolNames: readonly string[];
}

/** One observed tool event projected into situation terms. */
export interface SituationEvent {
  readonly toolName: string;
  /** Canonical file key when a file-touching tool ran. */
  readonly fileKey?: string;
  /** Coarse error signature when the tool errored. */
  readonly errorSignature?: string;
}

const FILE_WINDOW = 5;
const ERROR_WINDOW = 5;
const TOOL_WINDOW = 8;

/** The starting situation (no files, errors, or tools yet). Shared + frozen. */
export const EMPTY_SITUATION: SessionSituation = Object.freeze({
  fileKeys: Object.freeze([]) as readonly string[],
  errorSignatures: Object.freeze([]) as readonly string[],
  toolNames: Object.freeze([]) as readonly string[],
});

/** Append `value` to a deduped, bounded window (existing value moves to newest). */
function pushDedupBounded(window: readonly string[], value: string, max: number): string[] {
  const without = window.filter((v) => v !== value);
  const next = [...without, value];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Append to a non-deduped, bounded window (keep most recent `max`). */
function pushBounded(window: readonly string[], value: string, max: number): string[] {
  const next = [...window, value];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Fold one tool event into the situation, returning a new immutable situation.
 * File keys and error signatures dedupe (presence matters, not count); tool
 * names keep their recent sequence (the mix drives task-type inference).
 */
export function updateSituation(prev: SessionSituation, event: SituationEvent): SessionSituation {
  return {
    fileKeys: event.fileKey
      ? pushDedupBounded(prev.fileKeys, event.fileKey, FILE_WINDOW)
      : [...prev.fileKeys],
    errorSignatures: event.errorSignature
      ? pushDedupBounded(prev.errorSignatures, event.errorSignature, ERROR_WINDOW)
      : [...prev.errorSignatures],
    toolNames: pushBounded(prev.toolNames, event.toolName, TOOL_WINDOW),
  };
}
