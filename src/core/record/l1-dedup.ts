/**
 * L1 Memory Conflict Detection (Batch Mode): decides how to handle multiple new
 * memories against existing records in a single LLM call.
 *
 * v4: Removed JSONL-based Jaccard fallback. Candidate recall now relies exclusively
 *     on vector search (primary) and FTS5 BM25 (degraded). If neither is available,
 *     conflict detection is skipped entirely — all memories go straight to store.
 *
 * Two-phase approach:
 * 1. Candidate search per new memory — vector recall or FTS5 keyword recall (fast, no LLM)
 * 2. Batch LLM judgment on all new memories + their candidate pools (single call)
 */

import type { ExtractedMemory, MemoryRecord, DedupDecision, MemoryType } from "./l1-writer.js";
import { CONFLICT_DETECTION_SYSTEM_PROMPT, formatBatchConflictPrompt } from "../prompts/l1-dedup.js";
import type { CandidateMatch } from "../prompts/l1-dedup.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { sanitizeJsonForParse } from "../../utils/sanitize.js";
import type { IMemoryStore } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner } from "../types.js";

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const TAG = "[memory-tdai][l1-dedup]";

// ============================
// Core function (batch mode)
// ============================

/**
 * Batch conflict detection: compare all new memories against existing records
 * in a single LLM call.
 *
 * Candidate recall strategy (3-tier degradation):
 * 1. Vector recall (vectorStore + embeddingService) — cosine similarity (best)
 * 2. FTS5 keyword recall (vectorStore with FTS available) — BM25 ranking (degraded)
 * 3. Skip conflict detection entirely — all memories go straight to "store"
 *
 * The old JSONL-based Jaccard fallback has been removed. If neither vector search
 * nor FTS is available, we skip dedup rather than paying the O(N) full-file-scan cost.
 *
 * @param memories - Newly extracted memories (with record_id)
 * @param config - OpenClaw config (for LLM access)
 * @param logger - Optional logger
 * @param model - Optional model override
 * @param vectorStore - Optional vector store for cosine similarity search
 * @param embeddingService - Optional embedding service for computing query vectors
 * @param conflictRecallTopK - Top-K candidates to recall per new memory (default: 5)
 * @returns Array of dedup decisions, one per new memory
 */
export async function batchDedup(params: {
  memories: Array<ExtractedMemory & { record_id: string }>;
  config: unknown;
  logger?: Logger;
  model?: string;
  /** Vector store for cosine similarity candidate recall */
  vectorStore?: IMemoryStore;
  /** Embedding service for computing query vectors */
  embeddingService?: EmbeddingService;
  /** Top-K candidates per new memory (default: 5) */
  conflictRecallTopK?: number;
  /** Override embedding timeout for capture-path calls (milliseconds) */
  embeddingTimeoutMs?: number;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  llmRunner?: LLMRunner;
}): Promise<DedupDecision[]> {
  const { memories, config, logger, model, vectorStore, embeddingService, llmRunner } = params;
  const topK = params.conflictRecallTopK ?? 5;

  if (memories.length === 0) {
    return [];
  }

  const storeAll = () =>
    memories.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));

  // Determine what recall capabilities are available
  const hasVectorData = vectorStore && (await vectorStore.countL1()) > 0;
  const hasFts = vectorStore?.isFtsAvailable() ?? false;

  // Fast path: no recall capability at all → skip dedup
  if (!hasVectorData && !hasFts) {
    logger?.debug?.(`${TAG} No vector data and no FTS available, skipping conflict detection for ${memories.length} memories`);
    return storeAll();
  }

  // Phase 1: Find candidates
  //
  // Decision tree (after the fast-path guard above, vectorStore is guaranteed non-null):
  //   hasVectorData + embeddingService → Tier 1 vector recall (FTS fallback on error)
  //   otherwise hasFts                → Tier 2 FTS keyword recall
  //   otherwise                       → skip dedup (defensive; shouldn't reach here)
  let matches: CandidateMatch[];

  if (hasVectorData && embeddingService) {
    // === Tier 1: Vector recall mode ===
    logger?.debug?.(`${TAG} Using vector recall mode (topK=${topK})`);
    try {
      matches = await findCandidatesByVector(memories, vectorStore!, embeddingService, topK, logger, params.embeddingTimeoutMs);
    } catch (err) {
      logger?.warn?.(
        `${TAG} Vector recall failed, falling back to FTS keyword: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Degrade to FTS keyword recall
      if (hasFts) {
        matches = await findCandidatesByFts(memories, vectorStore!, logger);
      } else {
        logger?.debug?.(`${TAG} FTS not available either, skipping conflict detection`);
        return storeAll();
      }
    }
  } else if (hasFts) {
    // === Tier 2: FTS keyword recall ===
    logger?.debug?.(`${TAG} Using FTS keyword recall mode (no embedding service or no vector data)`);
    matches = await findCandidatesByFts(memories, vectorStore!, logger);
  } else {
    // Shouldn't reach here given the fast-path check above, but be defensive
    logger?.debug?.(`${TAG} No usable recall path, skipping conflict detection`);
    return storeAll();
  }

  // Check if any memory has candidates
  const hasAnyCandidates = matches.some((m) => m.candidates.length > 0);

  if (!hasAnyCandidates) {
    logger?.debug?.(`${TAG} No similar records found for any memory, all will be stored`);
    return storeAll();
  }

  // Phase 2: Batch LLM judgment
  return runLlmJudgment(matches, memories, config, logger, model, llmRunner);
}

/**
 * Phase 2: Run batch LLM judgment on candidate matches.
 */
async function runLlmJudgment(
  matches: CandidateMatch[],
  memories: Array<ExtractedMemory & { record_id: string }>,
  config: unknown,
  logger: Logger | undefined,
  model: string | undefined,
  llmRunner?: LLMRunner,
): Promise<DedupDecision[]> {
  logger?.debug?.(`${TAG} Running batch conflict detection for ${memories.length} memories`);

  try {
    const userPrompt = formatBatchConflictPrompt(matches);
    let result: string;

    if (llmRunner) {
      // Use the host-neutral LLMRunner interface
      result = await llmRunner.run({
        prompt: userPrompt,
        systemPrompt: CONFLICT_DETECTION_SYSTEM_PROMPT,
        taskId: "l1-conflict-detection",
        timeoutMs: 180_000,
      });
    } else {
      // Fallback: create CleanContextRunner (OpenClaw path)
      const runner = new CleanContextRunner({
        config,
        modelRef: model,
        enableTools: false,
        logger,
      });

      result = await runner.run({
        prompt: userPrompt,
        systemPrompt: CONFLICT_DETECTION_SYSTEM_PROMPT,
        taskId: "l1-conflict-detection",
        timeoutMs: 180_000,
      });
    }

    // Build two lookup maps from the candidate pool so the destructive-merge
    // guard in parseBatchResult can validate every delete target:
    //   - candidateTypeById: target id → the EXISTING candidate's type. Lets the
    //     guard reject an update/merge that would delete a DIFFERENT-type record
    //     even when merged_type happens to equal the new memory's type.
    //   - recalledByNewId: new memory record_id → the set of candidate ids that
    //     were actually recalled FOR THAT memory. Lets the guard reject a
    //     hallucinated target (an id the LLM invented that was never a candidate).
    const candidateTypeById = new Map<string, MemoryType>();
    const candidateContentById = new Map<string, string>();
    const recalledByNewId = new Map<string, Set<string>>();
    for (const match of matches) {
      const ids = new Set<string>();
      for (const cand of match.candidates) {
        candidateTypeById.set(cand.id, cand.type);
        candidateContentById.set(cand.id, cand.content);
        ids.add(cand.id);
      }
      recalledByNewId.set(match.newMemory.record_id, ids);
    }

    const decisions = parseBatchResult(result, memories, candidateTypeById, candidateContentById, recalledByNewId, logger);
    return decisions;
  } catch (err) {
    logger?.warn?.(
      `${TAG} Batch conflict detection failed, defaulting all to store: ${err instanceof Error ? err.message : String(err)}`,
    );
    return memories.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));
  }
}

// ============================
// Candidate recall strategies
// ============================

/**
 * Vector-based candidate recall (aligned with prototype):
 * batch-embed new memories → cosine search in VectorStore → exclude self-batch → return candidates.
 */
async function findCandidatesByVector(
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  topK: number,
  logger?: Logger,
  embeddingTimeoutMs?: number,
): Promise<CandidateMatch[]> {
  const newRecordIds = new Set(memories.map((m) => m.record_id));

  // Batch-compute embeddings for all new memories
  const texts = memories.map((m) => m.content);
  const embeddings = await embeddingService.embedBatch(texts, embeddingTimeoutMs ? { timeoutMs: embeddingTimeoutMs } : undefined);

  const matches: CandidateMatch[] = [];

  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const queryVec = embeddings[i];

    // Vector search top-K (request extra to account for self-batch filtering)
    const searchResults = await vectorStore.searchL1Vector(queryVec, topK + memories.length, mem.content);

    // Exclude records from current batch, convert to MemoryRecord format
    const candidates: MemoryRecord[] = searchResults
      .filter((r) => !newRecordIds.has(r.record_id))
      .slice(0, topK)
      .map((r) => ({
        id: r.record_id,
        content: r.content,
        type: r.type as MemoryRecord["type"],
        priority: r.priority,
        scene_name: r.scene_name,
        source_message_ids: [],
        metadata: {},
        timestamps: [r.timestamp_str].filter(Boolean),
        createdAt: "",
        updatedAt: "",
        sessionKey: r.session_key,
        sessionId: r.session_id,
      }));

    matches.push({ newMemory: mem, candidates });
  }

  logger?.debug?.(
    `${TAG} Vector recall: ${matches.map((m) => `${m.newMemory.record_id}→${m.candidates.length}`).join(", ")}`,
  );

  return matches;
}

/**
 * FTS5-based candidate recall:
 * Uses the FTS index for efficient BM25-ranked keyword matching.
 * This replaces the old Jaccard word-overlap fallback entirely.
 */
async function findCandidatesByFts(
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore,
  _logger?: Logger,
): Promise<CandidateMatch[]> {
  const newRecordIds = new Set(memories.map((m) => m.record_id));
  const matches: CandidateMatch[] = [];

  for (const mem of memories) {
    const ftsQuery = buildFtsQuery(mem.content);
    if (ftsQuery) {
      const ftsResults = await vectorStore.searchL1Fts(ftsQuery, 10);
      // Filter out records from the current batch
      const candidates: MemoryRecord[] = ftsResults
        .filter((r) => !newRecordIds.has(r.record_id))
        .slice(0, 5)
        .map((r) => ({
          id: r.record_id,
          content: r.content,
          type: r.type as MemoryRecord["type"],
          priority: r.priority,
          scene_name: r.scene_name,
          source_message_ids: [],
          metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return {}; } })() : {},
          timestamps: [r.timestamp_str].filter(Boolean),
          createdAt: "",
          updatedAt: "",
          sessionKey: r.session_key,
          sessionId: r.session_id,
        }));
      matches.push({ newMemory: mem, candidates });
    } else {
      matches.push({ newMemory: mem, candidates: [] });
    }
  }

  _logger?.debug?.(`${TAG} FTS keyword recall: ${matches.map((m) => `${m.newMemory.record_id}→${m.candidates.length}`).join(", ")}`);
  return matches;
}

// ============================
// Result parsing
// ============================

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction"];

/**
 * Parse the LLM's batch conflict detection JSON response.
 *
 * Expected format: [{record_id, action, target_ids, merged_content, merged_type, merged_priority, merged_timestamps}]
 */
function parseBatchResult(
  raw: string,
  memories: Array<ExtractedMemory & { record_id: string }>,
  /** target id → existing candidate's type (for cross-type delete rejection). */
  candidateTypeById: Map<string, MemoryType>,
  /** target id → existing candidate's content (for same-fact similarity gate). */
  candidateContentById: Map<string, string>,
  /** new memory record_id → set of candidate ids recalled for it (anti-hallucination). */
  recalledByNewId: Map<string, Set<string>>,
  logger?: Logger,
): DedupDecision[] {
  try {
    // Strip markdown code block wrappers
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Extract JSON array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      logger?.warn?.(`${TAG} No JSON array found in conflict detection response`);
      return fallbackStoreAll(memories);
    }

    // Sanitize control characters inside JSON string literals that LLM may produce
    const sanitized = sanitizeJsonForParse(arrayMatch[0]);
    const parsed = JSON.parse(sanitized) as unknown[];

    if (!Array.isArray(parsed)) {
      logger?.warn?.(`${TAG} Conflict detection response is not an array`);
      return fallbackStoreAll(memories);
    }

    // Map record_id → the new memory's OWN type, used by the destructive-merge
    // guard below to reject cross-type merge/update decisions (RC1 defense-in-depth).
    const newMemoryTypeById = new Map<string, MemoryType>(
      memories.map((m) => [m.record_id, m.type]),
    );
    // Map record_id → the new memory's OWN content, used by the same-fact
    // similarity gate below (refuse merging two facts that merely share tokens).
    const newContentById = new Map<string, string>(
      memories.map((m) => [m.record_id, m.content]),
    );

    // Build decisions from LLM output
    const decisions: DedupDecision[] = [];
    const validActions = ["store", "update", "merge", "skip"];

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;

      const recordId = String(d.record_id ?? "");
      // Skip entries with empty/missing record_id — they are LLM hallucinations
      if (!recordId) {
        logger?.debug?.(`${TAG} Skipping decision with empty record_id`);
        continue;
      }
      const action = String(d.action ?? "store");

      if (!validActions.includes(action)) {
        logger?.warn?.(`${TAG} Invalid action "${action}" for record ${recordId}, defaulting to store`);
      }

      const normalizedAction: DedupDecision["action"] =
        validActions.includes(action) ? (action as DedupDecision["action"]) : "store";
      const targetIds = Array.isArray(d.target_ids) ? d.target_ids.map(String) : [];
      const mergedType = VALID_TYPES.includes(d.merged_type as MemoryType)
        ? (d.merged_type as MemoryType)
        : undefined;

      // === RC1 destructive-merge guard (defense-in-depth) ===
      // Even if the LLM disobeys the conservative prompt, NEVER allow a merge/
      // update that would delete a DISTINCT fact via deleteL1Batch. We force
      // action="store" (clearing target_ids so nothing is deleted) when a
      // destructive decision hits ANY of these red flags:
      //   1. manyTargets  — more than one delete target (many-to-many merge).
      //   2. crossType    — merged_type differs from the new memory's own type.
      //   3. targetTypeMismatch — a target id resolves to an EXISTING candidate
      //      whose type differs from the new memory's type. This closes the gap
      //      where merged_type==new type but the single target is actually a
      //      different-type record (e.g. an episodic "update" pointed at an
      //      instruction record).
      //   4. hallucinatedTarget — a target id that was NEVER in this memory's
      //      recalled candidate set (the LLM invented it). Deleting an
      //      unrelated record by a hallucinated id must never happen.
      //   5. contentDivergent — a target's existing content is NOT a near-
      //      duplicate of the new fact. A genuine dedup/refresh replaces a
      //      near-identical fact; a conflation merges two DISTINCT facts that
      //      merely share surface tokens (e.g. "il codice segreto è MANGO-
      //      STELLARE-99" vs "MANGO-STELLARE-99 non è in memoria"). Without this
      //      gate the LLM silently destroyed the clean fact by merging it into
      //      an unrelated same-type record.
      const isDestructive = normalizedAction === "merge" || normalizedAction === "update";
      const newOwnType = newMemoryTypeById.get(recordId);
      const newContent = newContentById.get(recordId) ?? "";
      const manyTargets = targetIds.length > 1;
      const crossType = mergedType !== undefined && newOwnType !== undefined && mergedType !== newOwnType;

      // Minimum token overlap (Jaccard) for two contents to count as "the same
      // atomic fact" and thus be safe to merge/update. Below this they are
      // treated as distinct facts and both are kept (force store).
      const SAME_FACT_MIN_SIMILARITY = 0.6;

      // Per-target validation (only meaningful for destructive actions).
      const recalledSet = recalledByNewId.get(recordId);
      let targetTypeMismatch = false;
      let hallucinatedTarget = false;
      let contentDivergent = false;
      if (isDestructive) {
        for (const tid of targetIds) {
          // Hallucination: the target was never recalled as a candidate for this
          // new memory. If we have NO recalled set for this record, treat any
          // target as hallucinated (we cannot vouch for it).
          if (!recalledSet || !recalledSet.has(tid)) {
            hallucinatedTarget = true;
            continue;
          }
          // Cross-type delete: the existing candidate's type differs from the
          // new memory's own type.
          const candType = candidateTypeById.get(tid);
          if (candType !== undefined && newOwnType !== undefined && candType !== newOwnType) {
            targetTypeMismatch = true;
          }
          // Same-fact gate: the existing candidate's content must be a near-
          // duplicate of the new memory; otherwise they are distinct facts and
          // merging would lose one of them.
          const candContent = candidateContentById.get(tid);
          if (candContent !== undefined && tokenSimilarity(newContent, candContent) < SAME_FACT_MIN_SIMILARITY) {
            contentDivergent = true;
          }
        }
      }

      if (isDestructive && (manyTargets || crossType || targetTypeMismatch || hallucinatedTarget || contentDivergent)) {
        const reasons: string[] = [];
        if (manyTargets) reasons.push(`target_ids.length=${targetIds.length} (>1)`);
        if (crossType) reasons.push(`merged_type="${mergedType}" != new type="${newOwnType}"`);
        if (targetTypeMismatch) reasons.push(`a target's existing type != new type="${newOwnType}"`);
        if (hallucinatedTarget) reasons.push(`a target id was not in the recalled candidate set (hallucinated)`);
        if (contentDivergent) reasons.push(`a target's content is not a near-duplicate of the new fact (<${SAME_FACT_MIN_SIMILARITY} token overlap)`);
        logger?.warn?.(
          `${TAG} Guard: forcing store for record ${recordId} — ` +
          `${reasons.join("; ")} (rejected destructive ${normalizedAction})`,
        );
        decisions.push({
          record_id: recordId,
          action: "store",
          target_ids: [],
        });
        continue;
      }

      // === Skip gate (defense-in-depth) ===
      // "skip" drops the NEW memory as redundant. That is only safe when an
      // EXISTING recalled candidate is actually a near-duplicate of it. The LLM
      // sometimes skips a DISTINCT fact that merely shares surface tokens with a
      // candidate (e.g. it skipped "Il codice segreto è MANGO-STELLARE-99"
      // against the unrelated "MANGO-STELLARE-99 non è in memoria" record),
      // silently losing the fact. If no recalled candidate is a near-duplicate,
      // force store so the distinct fact is kept.
      if (normalizedAction === "skip") {
        const recalledForSkip = recalledByNewId.get(recordId);
        let hasNearDuplicate = false;
        if (recalledForSkip) {
          for (const cid of recalledForSkip) {
            const cContent = candidateContentById.get(cid);
            if (cContent !== undefined && tokenSimilarity(newContent, cContent) >= SAME_FACT_MIN_SIMILARITY) {
              hasNearDuplicate = true;
              break;
            }
          }
        }
        if (!hasNearDuplicate) {
          logger?.warn?.(
            `${TAG} Guard: forcing store for record ${recordId} — skip rejected: ` +
            `no recalled candidate is a near-duplicate (<${SAME_FACT_MIN_SIMILARITY} token overlap), the new fact is distinct`,
          );
          decisions.push({
            record_id: recordId,
            action: "store",
            target_ids: [],
          });
          continue;
        }
      }

      decisions.push({
        record_id: recordId,
        action: normalizedAction,
        target_ids: targetIds,
        merged_content: typeof d.merged_content === "string" ? d.merged_content : undefined,
        merged_type: mergedType,
        merged_priority: typeof d.merged_priority === "number" ? d.merged_priority : undefined,
        merged_timestamps: Array.isArray(d.merged_timestamps) ? d.merged_timestamps.map(String) : undefined,
      });
    }

    // Ensure all memories have a decision (fill missing with "store")
    const decidedIds = new Set(decisions.map((d) => d.record_id));
    for (const mem of memories) {
      if (!decidedIds.has(mem.record_id)) {
        logger?.debug?.(`${TAG} No decision for record ${mem.record_id}, defaulting to store`);
        decisions.push({
          record_id: mem.record_id,
          action: "store",
          target_ids: [],
        });
      }
    }

    return decisions;
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to parse conflict detection result: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackStoreAll(memories);
  }
}

/**
 * Normalized token-overlap (Jaccard) between two memory contents, in [0, 1].
 *
 * Used by the destructive-merge guard to refuse merging two facts that merely
 * share surface terms (low overlap) rather than being the same atomic fact.
 * Tokens are lowercased, split on non-alphanumeric boundaries, and single-char
 * tokens dropped (so "MANGO-STELLARE-99" → {mango, stellare, 99}).
 */
function tokenSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Fallback: store all memories when parsing fails.
 */
function fallbackStoreAll(memories: Array<ExtractedMemory & { record_id: string }>): DedupDecision[] {
  return memories.map((m) => ({
    record_id: m.record_id,
    action: "store" as const,
    target_ids: [],
  }));
}
