/**
 * Compose the single recall `context` string the gateway returns to the hook.
 *
 * The plugin's UserPromptSubmit hook has ONE injection channel, so the two
 * recall parts must be merged here:
 *   - appendSystemContext (stable: persona, scene nav, tools guide) — first, so
 *     any prefix caching the host does stays intact
 *   - prependContext (dynamic: the <relevant-memories> recalled for this prompt)
 *     — after, so the situation-relevant memories actually reach the agent
 *
 * Historically the gateway returned only the stable part; the per-prompt
 * memories were computed and dropped. This is the seam that turns proactive
 * injection ON.
 */

export interface RecallContextParts {
  appendSystemContext?: string;
  prependContext?: string;
}

/** Merge the stable and dynamic recall parts into one injectable string. */
export function composeRecallContext(parts: RecallContextParts): string {
  return [parts.appendSystemContext, parts.prependContext]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n\n");
}
