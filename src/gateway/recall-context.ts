/**
 * Compose the single recall `context` string the gateway returns to the hook.
 *
 * The plugin's UserPromptSubmit hook has ONE injection channel, so the two
 * recall parts must be merged here:
 *   - appendSystemContext (stable: persona, scene nav, tools guide) — first, so
 *     any prefix caching the host does stays intact
 *   - prependContext (dynamic: banner → recap → <relevant-memories>) — after,
 *     so the situation-relevant memories actually reach the agent
 *
 * Historically the gateway returned only the stable part; the per-prompt
 * memories were computed and dropped. This is the seam that turns proactive
 * injection ON.
 *
 * Priority-aware truncation (Choice A): the plugin caps the injected context at
 * a fixed char budget with a blind tail slice. Because the dynamic part sits at
 * the tail, an oversized persona used to push the session-open banner past the
 * cap and get it cut — proactive injection silently degraded. So we enforce the
 * budget HERE, priority-first: the dynamic payload (banner+recap+memories) is
 * the proactive-injection signal and survives intact; the stable reference bulk
 * yields its tail (the long project list) first.
 */

export interface RecallContextParts {
  appendSystemContext?: string;
  prependContext?: string;
}

/**
 * Char budget for the composed recall context. MUST stay ≥ the plugin's
 * MAX_INJECT_CHARS (claude-code-plugin/lib/hook.ts) so the gateway's
 * priority-aware trim — not the plugin's blind tail slice — is what fires.
 */
export const RECALL_CONTEXT_BUDGET = 10_000;

const TRUNCATION_MARKER = "\n\n[…reference context trimmed — memory pressure…]";

/** Slice `text` to fit `maxChars` INCLUDING the truncation marker. */
function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return text.slice(0, keep) + TRUNCATION_MARKER;
}

/**
 * Merge the stable and dynamic recall parts into one injectable string,
 * enforcing the char budget so the dynamic (proactive-injection) payload always
 * survives.
 */
export function composeRecallContext(
  parts: RecallContextParts,
  budget: number = RECALL_CONTEXT_BUDGET,
): string {
  const stable = parts.appendSystemContext ?? "";
  const dynamic = parts.prependContext ?? "";

  if (!stable && !dynamic) return "";
  if (!dynamic) return truncateTail(stable, budget);
  if (!stable) return truncateTail(dynamic, budget);

  const SEP = "\n\n";
  const full = `${stable}${SEP}${dynamic}`;
  if (full.length <= budget) return full;

  // Over budget. Reserve the FULL dynamic payload (banner → recap → memories)
  // and fill the remaining room with the stable head — its low-value tail (the
  // long project list) is sacrificed first. Only if the dynamic part ALONE
  // overflows do we trim it, from its tail (relevant-memories) so the
  // banner+recap at its head live.
  const room = budget - dynamic.length - SEP.length;
  if (room <= 0) return truncateTail(dynamic, budget);
  return `${truncateTail(stable, room)}${SEP}${dynamic}`;
}
