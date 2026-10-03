/**
 * Single source of truth for every plugin timeout.
 *
 * WHY: the hooks.json UserPromptSubmit timeout (5 s) was SHORTER than the
 * client recall timeout (6 s), so Claude Code killed the hook before the client
 * could report anything — a recall failure with no log line. The numbers now
 * live here; `tests/budget.test.ts` parses hooks/hooks.json and fails CI when
 * the two drift apart.
 *
 * Invariant: internal deadline < hook timeout, and every inner timeout < its
 * internal deadline.
 */

/** Seconds, exactly as written in hooks/hooks.json (Claude Code unit). */
export const HOOK_TIMEOUT_S = {
  sessionStart: 30,
  userPromptSubmit: 7,
  preToolUse: 3,
  postToolUse: 4,
  postToolUseFailure: 4,
  stop: 45,
} as const;

/** UserPromptSubmit: one deadline for recall + fallbacks, 1.2 s below the hook timeout (integer seconds: fractional support in Claude Code is undocumented). */
export const UPS_DEADLINE_MS = 5_800;
/** POST /recall client timeout. Also sent to the gateway as X-TDAI-Deadline-Ms. */
export const RECALL_TIMEOUT_MS = 4_500;
/** POST /observe (PostToolUse): must fit inside the 4 s hook timeout. */
export const OBSERVE_TIMEOUT_MS = 2_500;
/** POST /pretool (PreToolUse): the gateway answers from memory in < 300 ms; 1.5 s is the ceiling, hook timeout is 3 s. Fails open. */
export const PRETOOL_TIMEOUT_MS = 1_500;
/** PreToolUse: internal deadline for the whole hook body (stdin already read), 0.5 s below the hook timeout. */
export const PRETOOL_DEADLINE_MS = 2_500;
/** POST /capture, per attempt (two attempts + 2 s gap, inside STOP_DEADLINE_MS). */
export const CAPTURE_TIMEOUT_MS = 12_000;
/** Stop: internal deadline, 5 s below the hook timeout. */
export const STOP_DEADLINE_MS = 40_000;

/** Fallback 1 (/search/conversations) needs at least this much time left. */
export const FALLBACK_MIN_REMAINING_MS = 1_500;
/** Safety margin kept free of fallback 1's timeout so output can still be written. */
export const FALLBACK_MARGIN_MS = 300;

/** Consecutive recall misses before the `recall-timeout` alarm is raised. */
export const RECALL_MISS_ALARM_THRESHOLD = 3;
/** An identical prompt in the same session within this window skips recall (cron repeats). */
export const DUPLICATE_PROMPT_WINDOW_MS = 15 * 60 * 1000;
