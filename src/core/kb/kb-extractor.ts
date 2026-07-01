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

  // ── Steps 1-3 with ONE retry: LLM → parse → validate. Kimi at temperature=1
  //    occasionally emits malformed JSON (e.g. a doubled quote `""key"`) or a
  //    dangling ref; a single fresh retry almost always yields a clean delta —
  //    cheap robustness vs. losing the whole window (the recurring "3 windows
  //    failed in the backfill" cause). Each attempt is independent; only after
  //    both fail do we fail-closed (cursor holds, retried on the next trigger). ──
  const userPrompt = formatKbExtractionPrompt({
    newMessages: messages,
    backgroundMessages: params.backgroundMessages,
    knownEntities: params.knownEntities,
  });
  // Per-call timeout is configurable via TDAI_KB_EXTRACT_TIMEOUT_MS (default
  // 180s). Lets a bulk backfill fail-fast on oversized windows; prod → 180s.
  const extractTimeoutMs = Number(process.env.TDAI_KB_EXTRACT_TIMEOUT_MS) || 180_000;
  const MAX_ATTEMPTS = 2;

  let delta: KbDelta | undefined;
  let lastError = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      // Language barrier: the extractor is the SOURCE of every stored event, so
      // forcing a no-CJK rewrite here keeps recall/recap/principles clean at the
      // root. Falls through to the existing parse/validate/retry loop.
      raw = await runWithoutCjk(llmRunner, {
        prompt: userPrompt,
        systemPrompt: resolveKbExtractionSystemPrompt(),
        taskId: "kb-extraction",
        timeoutMs: extractTimeoutMs,
      });
    } catch (err) {
      lastError = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
      logger?.warn?.(`${TAG} attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
      continue; // fresh retry of the LLM call
    }

    // Hard CJK barrier: runWithoutCjk already tried to force a rewrite; if the
    // output STILL contains CJK, fail this attempt (fresh retry, then fail-closed
    // = cursor holds). Never store CJK — the reject is deterministic, so the
    // "no Chinese gets stored" guarantee does not depend on the model complying.
    if (hasCjk(raw)) {
      lastError = `output still contains CJK after language guard (rawLen=${raw.length})`;
      logger?.warn?.(`${TAG} attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseRawKbDeltaJson(raw);
    } catch (err) {
      lastError = `JSON parse failed (rawLen=${raw.length}): ${err instanceof Error ? err.message : String(err)}`;
      logger?.warn?.(`${TAG} attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
      continue;
    }

    const validation = parseKbDelta(parsed);
    if (!validation.ok) {
      lastError = validation.error;
      logger?.warn?.(`${TAG} attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
      continue;
    }

    delta = validation.delta;
    break;
  }

  if (!delta) {
    // Both attempts failed — hold the cursor (fail-closed, like l1-extractor.ts:175-178).
    logger?.error(`${TAG} extraction failed after ${MAX_ATTEMPTS} attempts: ${lastError} — cursor will hold`);
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
