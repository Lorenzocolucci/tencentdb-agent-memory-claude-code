/**
 * KB Extractor (Phase 2) — single-stage entity-centric extraction for ONE window.
 *
 * Replaces the 5-stage L1 funnel (extract → dedup → scene → persona) with:
 *   ONE Kimi call → strict KbDelta JSON → deterministic applyKbDelta.
 *
 * This module processes a SINGLE window of conversation messages (the L0
 * windowing + cursor lives in pipeline-factory.ts::createL1Runner and is
 * REUSED unchanged). The contract mirrors extractL1Memories so the runner can
 * swap engines by config flag without touching the cursor logic:
 *   - success:true  → cursor MAY advance (empty delta is a valid no-op success)
 *   - success:false → HARD failure, cursor HOLDS (fail-closed), retry next trigger
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import { resolveKbExtractionSystemPrompt, formatKbExtractionPrompt } from "../prompts/kb-extraction.js";
import { parseKbDelta, type KbDelta } from "./extraction-schema.js";
import { applyKbDelta } from "./kb-writer.js";
import type { KbWriterStore } from "./kb-writer.js";
import { sanitizeJsonForParse } from "../../utils/sanitize.js";
import { runWithoutCjk, hasCjk } from "../../utils/language-guard.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger, LLMRunner } from "../types.js";

const TAG = "[memory-tdai][kb-extractor]";

// ============================
// Result
// ============================

export interface KbExtractionResult {
  /**
   * Whether extraction succeeded. Same fail-closed contract as L1:
   * - true  → window handled (delta applied OR a valid empty delta) → cursor may advance.
   * - false → LLM/parse/schema failure → cursor MUST hold (retry).
   */
  success: boolean;
  /** Entities resolved/created. */
  entitiesCount: number;
  /** Facts upserted (head or historical). */
  factsCount: number;
  /** Events appended. */
  eventsCount: number;
  /** Relations upserted. */
  relationsCount: number;
  /** Owners (facts + events) whose vector/FTS were written. */
  embeddedCount: number;
}

// ============================
// Core
// ============================

/**
 * Run the LLM → parse → validate attempt loop for ONE runner and return the
 * first clean KbDelta (or the last error if all attempts failed). Extracted so
 * the SAME loop drives both the primary runner and the fallback runner — the
 * fallback reuses the identical parse/validate path, no divergent code.
 *
 * Kimi at temperature=1 occasionally emits malformed JSON or a dangling ref; a
 * fresh retry almost always fixes it. Only after MAX_ATTEMPTS fail does the
 * caller escalate (to the fallback runner, then fail-closed).
 */
async function runExtractionAttempts(opts: {
  runner: LLMRunner;
  userPrompt: string;
  timeoutMs: number;
  maxAttempts: number;
  label: string;
  logger?: Logger;
}): Promise<{ delta?: KbDelta; lastError: string }> {
  const { runner, userPrompt, timeoutMs, maxAttempts, label, logger } = opts;
  let lastError = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      // Language barrier: the extractor is the SOURCE of every stored event, so
      // forcing a no-CJK rewrite here keeps recall/recap/principles clean at the root.
      raw = await runWithoutCjk(runner, {
        prompt: userPrompt,
        systemPrompt: resolveKbExtractionSystemPrompt(),
        taskId: "kb-extraction",
        timeoutMs,
      });
    } catch (err) {
      lastError = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
      logger?.warn?.(`${TAG} [${label}] attempt ${attempt}/${maxAttempts}: ${lastError}`);
      continue; // fresh retry of the LLM call
    }

    // Hard CJK barrier: never store CJK — the reject is deterministic, so the
    // "no Chinese gets stored" guarantee does not depend on the model complying.
    if (hasCjk(raw)) {
      lastError = `output still contains CJK after language guard (rawLen=${raw.length})`;
      logger?.warn?.(`${TAG} [${label}] attempt ${attempt}/${maxAttempts}: ${lastError}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseRawKbDeltaJson(raw);
    } catch (err) {
      lastError = `JSON parse failed (rawLen=${raw.length}): ${err instanceof Error ? err.message : String(err)}`;
      logger?.warn?.(`${TAG} [${label}] attempt ${attempt}/${maxAttempts}: ${lastError}`);
      continue;
    }

    const validation = parseKbDelta(parsed);
    if (!validation.ok) {
      lastError = validation.error;
      logger?.warn?.(`${TAG} [${label}] attempt ${attempt}/${maxAttempts}: ${lastError}`);
      continue;
    }

    return { delta: validation.delta, lastError };
  }
  return { lastError };
}

/**
 * Run single-stage KB extraction over ONE window of messages.
 *
 * @param messages       The window's messages (already sliced by the runner).
 * @param sessionKey     Session key for the inserted events.
 * @param sessionId      Session id for the inserted events.
 * @param store          KB write/embed store (must implement the KB primitives).
 * @param embeddingService Hardened embedding service (optional — loud warn if absent).
 * @param llmRunner      Host-neutral LLM runner (text-only, enableTools=false).
 * @param namespace      Namespace tag (default "default").
 * @param project        Project tag (cross-project recall by default).
 * @param knownEntities  Recently-seen entity display names (prompt hint; may be []).
 * @param logger         Optional logger.
 */
export async function extractKbDelta(params: {
  messages: ConversationMessage[];
  sessionKey: string;
  sessionId?: string;
  store: KbWriterStore;
  embeddingService?: EmbeddingService;
  llmRunner: LLMRunner;
  /**
   * Optional non-Chinese fallback extractor (e.g. OpenAI gpt-5.4-mini). Tried
   * ONLY when the primary runner fails every attempt — its main purpose is the
   * windows Moonshot/Kimi REFUSES with "high risk" (its content-moderation flags
   * an incidental China-sensitive term like "rubber stamp" and rejects the whole
   * request), but it also rescues transient parse failures. Absent → unchanged
   * fail-closed behavior (cursor holds, immune-system quarantine bounds poison).
   */
  fallbackLlmRunner?: LLMRunner;
  namespace?: string;
  project?: string;
  knownEntities?: string[];
  backgroundMessages?: ConversationMessage[];
  logger?: Logger;
  /** Override "now" (test determinism). Defaults to current ISO time. */
  now?: string;
}): Promise<KbExtractionResult> {
  const { messages, sessionKey, sessionId, store, embeddingService, llmRunner, logger } = params;
  const namespace = params.namespace ?? "default";
  const project = params.project ?? "";
  const now = params.now ?? new Date().toISOString();

  const empty: KbExtractionResult = {
    success: true,
    entitiesCount: 0,
    factsCount: 0,
    eventsCount: 0,
    relationsCount: 0,
    embeddedCount: 0,
  };

  if (messages.length === 0) {
    logger?.debug?.(`${TAG} No messages in window — no-op success`);
    return empty;
  }

  // ── Steps 1-3: LLM → parse → validate, primary runner first, then the
  //    non-Chinese fallback runner if the primary fails EVERY attempt. This is
  //    the fix for Moonshot/Kimi refusing a window with "high risk" (its
  //    moderation flags an incidental China-sensitive term like "rubber stamp"
  //    and rejects the whole request → the window would otherwise be lost /
  //    quarantined). The fallback reuses the SAME attempt loop, so a rescued
  //    window is parsed/validated/applied identically. ──
  const userPrompt = formatKbExtractionPrompt({
    newMessages: messages,
    backgroundMessages: params.backgroundMessages,
    knownEntities: params.knownEntities,
  });
  // Per-call timeout is configurable via TDAI_KB_EXTRACT_TIMEOUT_MS (default
  // 180s). Lets a bulk backfill fail-fast on oversized windows; prod → 180s.
  const extractTimeoutMs = Number(process.env.TDAI_KB_EXTRACT_TIMEOUT_MS) || 180_000;
  const MAX_ATTEMPTS = 2;

  const primary = await runExtractionAttempts({
    runner: llmRunner,
    userPrompt,
    timeoutMs: extractTimeoutMs,
    maxAttempts: MAX_ATTEMPTS,
    label: "primary",
    logger,
  });
  let delta = primary.delta;
  let lastError = primary.lastError;

  // Fallback: primary failed every attempt AND a fallback runner is wired.
  if (!delta && params.fallbackLlmRunner) {
    logger?.warn?.(
      `${TAG} primary extraction failed (${lastError}) — retrying window with fallback LLM ` +
      `(non-Chinese; rescues Moonshot "high risk" refusals)`,
    );
    const fb = await runExtractionAttempts({
      runner: params.fallbackLlmRunner,
      userPrompt,
      timeoutMs: extractTimeoutMs,
      maxAttempts: MAX_ATTEMPTS,
      label: "fallback",
      logger,
    });
    if (fb.delta) {
      delta = fb.delta;
      logger?.info?.(`${TAG} fallback LLM extracted the window the primary could not`);
    } else {
      lastError = `primary: ${lastError}; fallback: ${fb.lastError}`;
    }
  }

  if (!delta) {
    // Every attempt (primary + fallback) failed — hold the cursor (fail-closed);
    // the immune-system quarantine bounds a genuinely un-extractable window.
    logger?.error(`${TAG} extraction failed after all attempts: ${lastError} — cursor will hold`);
    return { ...empty, success: false };
  }

  // Empty delta is a VALID success → no-op apply, cursor advances.
  if (
    delta.entities.length === 0 &&
    delta.facts.length === 0 &&
    delta.events.length === 0 &&
    delta.relations.length === 0
  ) {
    logger?.debug?.(`${TAG} Empty delta (no extractable memory) — no-op success, cursor advances`);
    return empty;
  }

  // ── Step 4: deterministic apply ──
  try {
    const result = await applyKbDelta(delta, {
      store,
      embeddingService,
      namespace,
      project,
      sessionKey,
      sessionId,
      now,
      logger,
    });
    logger?.info(
      `${TAG} Applied KbDelta: entities=${result.entities.length}, facts=${result.facts.length}, ` +
      `events=${result.events.length}, relations=${result.relations.length}, embedded=${result.embedded}`,
    );
    return {
      success: true,
      entitiesCount: result.entities.length,
      factsCount: result.facts.length,
      eventsCount: result.events.length,
      relationsCount: result.relations.length,
      embeddedCount: result.embedded,
    };
  } catch (err) {
    // Apply touches the DB. A failure here means the window was NOT fully
    // written → hold the cursor so the next trigger retries it. The KB writes
    // that did land are idempotent (deterministic ids + supersession), so a
    // retry re-applies safely.
    logger?.error(
      `${TAG} applyKbDelta failed: ${err instanceof Error ? err.stack ?? err.message : String(err)} — cursor will hold`,
    );
    return { ...empty, success: false };
  }
}

// ============================
// JSON extraction (strip fences + sanitize, then parse)
// ============================

/**
 * Strip markdown code fences, locate the JSON object, sanitize control chars,
 * and JSON.parse. Reuses the l1-extractor.ts:386-388 fence-strip + sanitize
 * pattern (adapted from array `[...]` to object `{...}`). Throws on parse
 * failure so the caller can fail-closed.
 */
function parseRawKbDeltaJson(raw: string): unknown {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  // Extract the outermost JSON object (the model may add stray prose around it).
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) {
    throw new Error("no JSON object found in KbDelta response");
  }

  const sanitized = sanitizeJsonForParse(objMatch[0]);
  try {
    return JSON.parse(sanitized);
  } catch {
    // Salvage pass for the common Kimi glitches (only runs AFTER a real parse
    // failure, so it can never corrupt already-valid JSON). Throws if still bad.
    return JSON.parse(repairCommonJsonGlitches(sanitized));
  }
}

/**
 * Repair the malformed-JSON patterns Kimi produces at temperature=1, observed in
 * the live backfill:
 *   - a doubled quote before a key:  `],""language"`  →  `],"language"`
 *   - a trailing comma before `}`/`]`
 * Conservative on purpose — only invoked as a last-ditch salvage before
 * fail-closed; if it does not yield valid JSON the window still fails safely.
 */
function repairCommonJsonGlitches(s: string): string {
  return s
    .replace(/([,{[]\s*)""(\s*[A-Za-z_])/g, '$1"$2') // ,""key → ,"key
    .replace(/,(\s*[}\]])/g, "$1"); // trailing comma
}
