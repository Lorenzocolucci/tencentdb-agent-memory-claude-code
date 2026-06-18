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
import { KB_EXTRACTION_SYSTEM_PROMPT, formatKbExtractionPrompt } from "../prompts/kb-extraction.js";
import { parseKbDelta } from "./extraction-schema.js";
import { applyKbDelta } from "./kb-writer.js";
import type { KbWriterStore } from "./kb-writer.js";
import { sanitizeJsonForParse } from "../../utils/sanitize.js";
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

  // ── Step 1: LLM call ──
  const userPrompt = formatKbExtractionPrompt({
    newMessages: messages,
    backgroundMessages: params.backgroundMessages,
    knownEntities: params.knownEntities,
  });

  let raw: string;
  try {
    // Per-call timeout is configurable via TDAI_KB_EXTRACT_TIMEOUT_MS (default
    // 180s). Lets a bulk backfill fail-fast on oversized windows instead of
    // blocking 180s each; production leaves it unset → 180s.
    const extractTimeoutMs = Number(process.env.TDAI_KB_EXTRACT_TIMEOUT_MS) || 180_000;
    raw = await llmRunner.run({
      prompt: userPrompt,
      systemPrompt: KB_EXTRACTION_SYSTEM_PROMPT,
      taskId: "kb-extraction",
      timeoutMs: extractTimeoutMs,
    });
  } catch (err) {
    // Hard failure — hold the cursor (fail-closed, like l1-extractor.ts:175-178).
    logger?.error(
      `${TAG} LLM extraction failed: ${err instanceof Error ? err.message : String(err)} — cursor will hold`,
    );
    return { ...empty, success: false };
  }

  // ── Step 2: strip fences + sanitize + JSON.parse ──
  let parsed: unknown;
  try {
    parsed = parseRawKbDeltaJson(raw);
  } catch (err) {
    logger?.error(
      `${TAG} Failed to JSON-parse KbDelta: ${err instanceof Error ? err.message : String(err)} ` +
      `(rawLen=${raw.length}) — cursor will hold`,
    );
    return { ...empty, success: false };
  }

  // ── Step 3: Zod validation (referential integrity, enums, snake_case) ──
  const validation = parseKbDelta(parsed);
  if (!validation.ok) {
    logger?.error(`${TAG} ${validation.error} — cursor will hold`);
    return { ...empty, success: false };
  }
  const delta = validation.delta;

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
  return JSON.parse(sanitized);
}
