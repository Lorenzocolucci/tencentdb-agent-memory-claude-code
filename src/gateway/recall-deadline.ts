/**
 * Per-request recall deadline.
 *
 * The plugin tells the gateway how long it will wait via the
 * `X-TDAI-Deadline-Ms` header. Recall must finish (and answer) before the client
 * gives up, so the server-side timeout is `min(configured, header - 500)`, never
 * below 500 ms. No (or an unusable) header keeps the configured timeout.
 */

export const DEADLINE_HEADER = "x-tdai-deadline-ms";
const SAFETY_MARGIN_MS = 500;
const MIN_TIMEOUT_MS = 500;

/** @returns the timeout override in ms, or undefined when the config value stands. */
export function resolveRecallTimeoutMs(
  configuredMs: number,
  headerValue: string | string[] | undefined,
): number | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw === undefined) return undefined;
  const deadline = Number(raw);
  if (!Number.isFinite(deadline) || deadline <= 0) return undefined;
  return Math.max(MIN_TIMEOUT_MS, Math.min(configuredMs, Math.floor(deadline) - SAFETY_MARGIN_MS));
}
