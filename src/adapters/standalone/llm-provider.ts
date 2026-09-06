/**
 * Provider-level knobs for the StandaloneLLMRunner (Kimi/Moonshot + fallback).
 *
 * WHY THIS FILE EXISTS (measured 2026-09-05)
 * Every Moonshot model the live key can use (kimi-k2.6, kimi-k3, kimi-k2.7-code*)
 * is a REASONING model: with default settings it burns up to ~1,500 reasoning
 * tokens and ~30 s on a 70-token prompt, and with a small max_tokens it returns
 * EMPTY content (the budget goes to thinking). kimi-k2.6 / kimi-k3 accept the
 * request-body field `"thinking": {"type": "disabled"}` and then answer in ~2 s.
 * The AI SDK's OpenAI provider validates `providerOptions` against its own
 * schema (unknown keys are dropped), so the only reliable way to add a vendor
 * field is to rewrite the JSON body in a custom `fetch` handed to the provider.
 *
 * Moonshot also accepts exactly ONE temperature per mode — 1 with thinking on,
 * 0.6 with thinking disabled (live 2026-09-05: "invalid temperature: only 0.6
 * is allowed for this model") — so the runner never sends one to a Moonshot
 * host and lets the server apply its only legal default. See resolveTemperature.
 *
 * Pure helpers: no I/O of their own, never throw into a run.
 */

export type ThinkingMode = "disabled" | "enabled";

/** Hosts whose models are Kimi reasoning models (thinking + temperature rules). */
export function isMoonshotHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = baseUrl.toLowerCase();
  }
  return host.includes("moonshot") || host.includes("kimi");
}

/**
 * Effective thinking mode: an explicit setting wins; otherwise Moonshot/Kimi
 * hosts default to "disabled" (the extraction/distillation prompts want an
 * answer, not a chain of thought) and every other host sends nothing.
 */
export function resolveThinking(
  configured: ThinkingMode | undefined,
  baseUrl: string | undefined,
): ThinkingMode | undefined {
  if (configured) return configured;
  return isMoonshotHost(baseUrl) ? "disabled" : undefined;
}

/**
 * Effective sampling temperature for one call.
 *  - omitTemperature → undefined (reasoning models reject the parameter);
 *  - Moonshot/Kimi hosts → undefined: each Kimi mode accepts exactly one value
 *    (1 with thinking, 0.6 without — measured live 2026-09-05), and the server
 *    default IS that value, so sending any number can only be rejected;
 *  - otherwise the per-call value, then the config value, then 1.
 */
export function resolveTemperature(opts: {
  omitTemperature?: boolean;
  baseUrl?: string;
  requested?: number;
  configured?: number;
}): number | undefined {
  if (opts.omitTemperature) return undefined;
  if (isMoonshotHost(opts.baseUrl)) return undefined;
  return opts.requested ?? opts.configured ?? 1;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** True for the chat-completions endpoint (the only body we rewrite). */
function isChatCompletionsUrl(input: string | URL | Request): boolean {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.includes("/chat/completions");
}

/**
 * A `fetch` that injects `{"thinking":{"type":<mode>}}` into the JSON body of
 * chat/completions POSTs. Non-JSON or non-chat requests pass through untouched;
 * a body we cannot parse is sent as-is (never break the call to add a knob).
 * `baseFetch` is resolved lazily so test-time stubs of globalThis.fetch apply.
 */
export function createThinkingFetch(
  mode: ThinkingMode,
  baseFetch?: FetchLike,
): FetchLike {
  return async (input, init) => {
    const doFetch: FetchLike = baseFetch ?? ((i, o) => globalThis.fetch(i, o));
    if (!init || typeof init.body !== "string" || !isChatCompletionsUrl(input)) {
      return doFetch(input, init);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return doFetch(input, init);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return doFetch(input, init);
    }
    const body = JSON.stringify({ ...(parsed as Record<string, unknown>), thinking: { type: mode } });
    return doFetch(input, { ...init, body });
  };
}
