/**
 * Seed request execution (POST /seed), separated from the HTTP handler so the
 * gateway can run it in the worker process: `executeSeed` is minutes of
 * synchronous SQLite + LLM work and must not run on the HTTP event loop.
 *
 * `sanitizeConfigOverride` lives here (re-exported by server.ts) because both the
 * gateway and the worker must strip credential keys from a caller-supplied override.
 */
import type { GatewayConfig } from "./config.js";
import type { Logger } from "../core/types.js";
import type { SeedRequest, SeedResponse } from "./types.js";
import { validateAndNormalizeRaw } from "../core/seed/input.js";
import { executeSeed } from "../core/seed/seed-runtime.js";
import type { SeedProgress } from "../core/seed/types.js";

// ============================
// Config-override sanitization (security)
// ============================

/** Credential / endpoint keys that an external caller must NEVER be able to set
 *  via /seed's `config_override`. Allowing `baseUrl` would let an authenticated
 *  caller redirect our LLM/embedding traffic (and the bundled API key) to an
 *  attacker-controlled server (key exfiltration / SSRF); allowing `apiKey`
 *  would let them swap in their own key or read ours back indirectly. */
const FORBIDDEN_OVERRIDE_KEYS = ["apiKey", "baseUrl", "proxyUrl"] as const;
/** Sub-objects of the plugin config that carry credentials/endpoints. */
const CREDENTIAL_SECTIONS = ["llm", "embedding"] as const;

/**
 * Return a NEW, sanitized copy of a `config_override` object with credential and
 * endpoint keys (apiKey / baseUrl / proxyUrl) stripped from its `llm` and
 * `embedding` sub-objects. The original is never mutated. Everything else
 * (tuning knobs like model, maxTokens, temperature, timeoutMs, dimensions, ...)
 * is preserved so legitimate overrides keep working.
 *
 * `stripped` lists the dotted paths that were removed, so the caller can log a
 * security-relevant event when an override tries to set forbidden keys.
 */
export function sanitizeConfigOverride(
  override: Record<string, unknown> | undefined | null,
): { sanitized: Record<string, unknown>; stripped: string[] } {
  const stripped: string[] = [];
  if (!override || typeof override !== "object") {
    return { sanitized: {}, stripped };
  }

  // Shallow copy of the top level (immutability - never touch the input).
  const sanitized: Record<string, unknown> = { ...override };

  for (const section of CREDENTIAL_SECTIONS) {
    const sub = sanitized[section];
    if (sub && typeof sub === "object" && !Array.isArray(sub)) {
      // Copy the sub-object and delete forbidden keys from the COPY only.
      const subCopy: Record<string, unknown> = { ...(sub as Record<string, unknown>) };
      for (const key of FORBIDDEN_OVERRIDE_KEYS) {
        if (key in subCopy) {
          delete subCopy[key];
          stripped.push(`${section}.${key}`);
        }
      }
      sanitized[section] = subCopy;
    }
  }

  return { sanitized, stripped };
}

// ============================
// Execution
// ============================

/** Merge a sanitized override over the base config (one level deep for plain objects). */
function mergeOverride(
  base: Record<string, unknown>,
  safeOverride: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(safeOverride)) {
    const baseVal = merged[key];
    const overVal = safeOverride[key];
    if (baseVal && typeof baseVal === "object" && !Array.isArray(baseVal) &&
        overVal && typeof overVal === "object" && !Array.isArray(overVal)) {
      merged[key] = { ...(baseVal as Record<string, unknown>), ...(overVal as Record<string, unknown>) };
    } else {
      merged[key] = overVal;
    }
  }
  return merged;
}

/**
 * Validate + run one seed request. Throws `SeedValidationError` (from
 * validateAndNormalizeRaw) for bad input; the caller maps it to a 400.
 * `body.data` must already be known to be present.
 */
export async function runSeedRequest(
  body: SeedRequest,
  deps: { config: GatewayConfig; logger: Logger },
): Promise<SeedResponse> {
  const { config, logger } = deps;

  // Validate and normalize input (reuses seed CLI's validation layers 2-6)
  const input = validateAndNormalizeRaw(body.data, {
    sessionKey: body.session_key,
    strictRoundRole: body.strict_round_role,
    autoFillTimestamps: body.auto_fill_timestamps ?? true,
  });

  logger.info(
    `Seed request: ${input.sessions.length} session(s), ` +
    `${input.totalRounds} round(s), ${input.totalMessages} message(s)`,
  );

  // Resolve output directory: use gateway's data dir with a timestamped subfolder
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const outputDir = `${config.data.baseDir}/seed-${ts}`;

  // Merge config overrides if provided
  // Start with the base memory config + inject llm config from gateway settings
  const baseConfig = config.memory as unknown as Record<string, unknown>;
  let pluginConfig: Record<string, unknown> = {
    ...baseConfig,
    llm: {
      enabled: true,
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      // RC5: honor configured temperature (Kimi/Moonshot requires exactly 1).
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
    },
  };
  if (body.config_override) {
    // SECURITY: strip credential/endpoint keys (apiKey / baseUrl / proxyUrl)
    // from the llm + embedding sections BEFORE merging. Without this, an
    // authenticated caller could redirect baseUrl to an attacker-controlled
    // server and exfiltrate the bundled API key (key exfil / SSRF).
    const { sanitized: safeOverride, stripped } = sanitizeConfigOverride(body.config_override);
    if (stripped.length > 0) {
      logger.warn(
        `Seed config_override attempted to set forbidden credential/endpoint key(s): ` +
        `${stripped.join(", ")} - ignored`,
      );
    }
    pluginConfig = mergeOverride(pluginConfig, safeOverride);
  }

  // Execute seed pipeline (blocking - this may take minutes for large inputs)
  const summary = await executeSeed(input, {
    outputDir,
    openclawConfig: {},
    pluginConfig,
    logger: logger as import("../utils/pipeline-factory.js").PipelineLogger,
    onProgress: (progress: SeedProgress) => {
      logger.debug?.(
        `Seed progress: [${progress.currentRound}/${progress.totalRounds}] ` +
        `session=${progress.sessionKey} stage=${progress.stage}`,
      );
    },
  });

  logger.info(
    `Seed complete: sessions=${summary.sessionsProcessed}, rounds=${summary.roundsProcessed}, ` +
    `l0=${summary.l0RecordedCount}, duration=${(summary.durationMs / 1000).toFixed(1)}s`,
  );

  return {
    sessions_processed: summary.sessionsProcessed,
    rounds_processed: summary.roundsProcessed,
    messages_processed: summary.messagesProcessed,
    l0_recorded: summary.l0RecordedCount,
    duration_ms: summary.durationMs,
    output_dir: summary.outputDir,
  };
}
