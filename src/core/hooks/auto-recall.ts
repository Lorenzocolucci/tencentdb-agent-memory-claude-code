/**
 * auto-recall hook (v3): injects relevant memories + persona into agent context
 * before the agent starts processing.
 *
 * - Searches L1 memories using configurable strategy (keyword / embedding / hybrid)
 *   - keyword: FTS5 BM25 (requires FTS5; returns empty if unavailable)
 *   - embedding: VectorStore cosine similarity
 *   - hybrid: keyword + embedding merged with RRF
 * - L3 persona injection
 * - L2 scene navigation (full injection, LLM decides relevance)
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import type { MemoryRecord } from "../record/l1-reader.js";
import type { IMemoryStore, L1SearchResult, L1FtsResult } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService, EmbeddingCallOptions } from "../store/embedding.js";
import { sanitizeText, escapeXmlTags } from "../../utils/sanitize.js";
import { redactSecrets } from "../../utils/redact-secrets.js";
import { kbRecall, type KbRecallResult } from "../kb/retrieval.js";
import { loadPrinciples, formatPrinciplesBlock } from "./principles.js";
import { buildSessionBanner, type SessionBannerTracker } from "./session-banner.js";
import { latestRecapBlock } from "../continuity/recap-retrieval.js";
import {
  buildCornerstones,
  type CornerstoneInjectionTracker,
} from "../distinctiveness/cornerstone-runner.js";

const TAG = "[memory-tdai] [recall]";

/**
 * Memory tools usage guide — injected at the end of memory context so the
 * main agent knows how to actively retrieve deeper information.
 */
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

当上方注入的记忆片段不足以回答用户问题时，可主动调用以下工具获取更多信息：

- **tdai_memory_search**：搜索结构化记忆（L1），适用于回忆用户偏好、历史事件节点、规则等关键信息。
- **tdai_conversation_search**：搜索原始对话（L0），适用于查找具体消息原文、时间线、上下文细节；也可用于补充或校验 memory_search 的结果。
- **read_file**（Scene Navigation 中的路径）：当已定位到相关情境，且需要该场景的完整画像、事件经过或阶段结论时使用。

### ⚠️ 调用次数限制
每轮对话中，tdai_memory_search 和 tdai_conversation_search **合计最多调用 3 次**。
- 首次搜索无结果时，可换关键词或换工具重试，但总调用次数不要超过 3 次。
- 若 3 次搜索后仍无结果，说明该信息不在记忆中，请直接根据已有信息回复用户，不要继续搜索。
</memory-tools-guide>`

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// ============================
// RC3 — hybrid recall ranking tuning
// ============================

/**
 * Recency boost weight applied to the fused (RRF) score in the hybrid path.
 * The booster is multiplicative: finalScore = rrfScore * (1 + RECENCY_WEIGHT * decay).
 * Kept small (0.15) so RELEVANCE stays dominant — recency only re-orders results
 * that are already similarly relevant. With decay in [0,1], a brand-new memory
 * gets at most +15% to its fused score; an old memory gets ~+0%.
 */
export const RECENCY_WEIGHT = 0.15;

/**
 * Half-life (in days) of the recency boost. A memory RECENCY_HALFLIFE_DAYS old
 * gets half the maximum boost; older memories decay toward zero boost. 30 days
 * keeps the boost meaningful for recent activity without penalizing stable facts.
 */
export const RECENCY_HALFLIFE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Standard RRF (Reciprocal Rank Fusion) constant from the original RRF paper.
 * Shared so every recall path (L1 hybrid here, the memory_search tool, and the
 * Phase-4 KB retrieval) fuses rank lists with the SAME formula instead of
 * forking divergent copies.
 */
export const RRF_K = 60;

/**
 * RRF contribution of a single rank position (0-based) in one ranked list:
 *   1 / (RRF_K + rank + 1)
 * When an item appears in multiple lists, callers SUM these contributions.
 * This is the exact formula previously inlined in searchHybrid (~:678/694) and
 * in tools/memory-search.ts; extracting it keeps all fusers in lock-step.
 */
export function rrfScoreForRank(rank: number): number {
  return 1 / (RRF_K + rank + 1);
}

/**
 * Exponential time-decay factor in [0, 1] for a memory timestamp.
 * Returns 1 for "now" and approaches 0 as the memory ages (half at the half-life).
 * Returns 0 for missing/unparseable timestamps so they receive no recency boost
 * (relevance-only ranking), never a negative or NaN multiplier.
 */
export function recencyDecay(timestampIso: string | undefined, nowMs: number): number {
  if (!timestampIso) return 0;
  const t = Date.parse(timestampIso);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (nowMs - t) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
}

/**
 * Combine a relevance (RRF) score with a conservative recency booster.
 * Relevance is primary; recency only nudges similarly-relevant items.
 */
export function applyRecencyBoost(rrfScore: number, timestampIso: string | undefined, nowMs: number): number {
  return rrfScore * (1 + RECENCY_WEIGHT * recencyDecay(timestampIso, nowMs));
}

/** A single recalled L1 memory with its search score and type. */
export interface RecalledMemory {
  content: string;
  score: number;
  type: string;
}

export interface RecallResult {
  /** L1 relevant memories — prepended to user prompt text (dynamic, per-turn) */
  prependContext?: string;
  /** Stable recall context appended to system prompt (persona, scene nav, tools guide — cacheable) */
  appendSystemContext?: string;

  // ── Metric payload (for pendingRecallCache in index.ts) ──
  /** L1 memories that were recalled (with scores), for metric reporting */
  recalledL1Memories?: RecalledMemory[];
  /** L3 Persona raw content loaded during recall (null if none) */
  recalledL3Persona?: string | null;
  /** Effective search strategy used */
  recallStrategy?: string;
  /** True when this result includes the session-open banner (caller commits the tracker slot). */
  bannerEmitted?: boolean;
}

export async function performAutoRecall(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  /** Project the session is in (basename of cwd) — selects per-project principles. */
  projectName?: string;
  /**
   * Claude Code session id — CHANGES every new session (unlike sessionKey, which
   * is stable per project). Used as the banner's once-per-session key so the
   * "sul pezzo" banner re-fires on each new session, not once per gateway
   * process. Falls back to sessionKey when absent (older hook / non-cc caller).
   */
  sessionId?: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  /** When provided, prepends the session-open banner on the first turn of each session. */
  bannerTracker?: SessionBannerTracker;
  /**
   * When provided, injects the cornerstone memory block (Idea 5: Distinctiveness Scorer)
   * alongside the heat-ranked scenes at session start.
   */
  cornerstoneTracker?: CornerstoneInjectionTracker;
}): Promise<RecallResult | undefined> {
  const { cfg, logger } = params;
  const timeoutMs = cfg.recall.timeoutMs ?? 5000;

  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    performAutoRecallInner(params).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        logger?.warn?.(
          `${TAG} ⚠️ Recall timed out after ${timeoutMs}ms — skipping memory injection to avoid blocking the user`,
        );
        resolve(undefined);
      }, timeoutMs);
    }),
  ]);
}

async function performAutoRecallInner(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  projectName?: string;
  sessionId?: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  bannerTracker?: SessionBannerTracker;
  cornerstoneTracker?: CornerstoneInjectionTracker;
}): Promise<RecallResult | undefined> {
  const { userText, cfg, pluginDataDir, projectName, logger, vectorStore, embeddingService, bannerTracker, cornerstoneTracker } = params;
  const tRecallStart = performance.now();

  // Search relevant memories (L1 layer) — skip only when userText is empty/undefined
  const tSearchStart = performance.now();
  let memoryLines: string[] = [];
  let effectiveStrategy = "skipped";
  let recalledL1Memories: RecalledMemory[] = [];
  let searchTiming: SearchTiming = { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 };
  if (!userText || userText.length === 0) {
    logger?.debug?.(`${TAG} User text empty/undefined, skipping memory search (persona/scene still injected)`);
  } else if (cfg.recall.source === "kb") {
    // ── Phase-4 entity-centric KB recall path (recall.source = "kb") ──
    // Maps KbRecallResult → the same memoryLines / RecalledMemory shape the L1
    // path produces, so downstream injection is unchanged. The score injected
    // here is the CALIBRATED 0-1 relevance from kbRecall (never raw RRF).
    effectiveStrategy = "kb";
    const tKb = performance.now();
    const kbResults = await runKbRecall(userText, cfg, logger, vectorStore, embeddingService);
    memoryLines = kbResults.map((r) => formatKbRecallLine(r));
    recalledL1Memories = kbResults.map((r) => ({
      content: r.text,
      score: r.score,
      type: r.owner_kind,
    }));
    searchTiming = { ftsMs: 0, embeddingMs: performance.now() - tKb, ftsHits: 0, embeddingHits: kbResults.length };
  } else {
    effectiveStrategy = cfg.recall.strategy ?? "hybrid";
    const searchResult = await searchMemories(userText, pluginDataDir, cfg, logger, effectiveStrategy as "keyword" | "embedding" | "hybrid", vectorStore, embeddingService);
    memoryLines = searchResult.lines;
    searchTiming = searchResult.timing;

    // Extract structured RecalledMemory from formatted lines for metric reporting
    recalledL1Memories = memoryLines.map((line) => {
      const match = line.match(/^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*\(活动时间:.*\))?$/);
      if (match) {
        const tag = match[1];
        const content = match[2].trim();
        const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
        return { content, score: 0, type: typePart };
      }
      return { content: line, score: 0, type: "unknown" };
    });
  }
  const tSearchEnd = performance.now();

  // Read persona (L3 layer)
  const tPersonaStart = performance.now();
  let personaContent: string | undefined;
  try {
    const personaPath = path.join(pluginDataDir, "persona.md");
    const raw = await fs.readFile(personaPath, "utf-8");
    personaContent = stripSceneNavigation(raw).trim();
    if (!personaContent) personaContent = undefined;
    logger?.debug?.(`${TAG} Persona loaded: ${personaContent ? `${personaContent.length} chars` : "empty"}`);
  } catch {
    logger?.debug?.(`${TAG} No persona file found (expected for new users)`);
  }
  const tPersonaEnd = performance.now();

  // Load full scene navigation (L2 layer)
  const tSceneStart = performance.now();
  let sceneNavigation: string | undefined;
  let sceneCount = 0;
  try {
    const sceneIndex = await readSceneIndex(pluginDataDir);
    if (sceneIndex.length > 0) {
      sceneCount = sceneIndex.length;
      sceneNavigation = generateSceneNavigation(sceneIndex, pluginDataDir);
      logger?.debug?.(`${TAG} Scene navigation generated: ${sceneIndex.length} scenes`);
    }
  } catch {
    logger?.debug?.(`${TAG} No scene index found`);
  }
  const tSceneEnd = performance.now();

  // Load the binding principles (global + per-project) BEFORE the "anything to
  // inject?" gate. The north-star is the one thing that must surface even when a
  // fresh project has no persona/scene/memory yet — otherwise the binding vision
  // is silently dropped exactly when it matters most (the "forgot the vision" bug).
  const principles = await loadPrinciples(pluginDataDir, projectName);

  if (memoryLines.length === 0 && !personaContent && !sceneNavigation && !principles) {
    const totalMs = performance.now() - tRecallStart;
    logger?.info(
      `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
      `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryLines.length},` +
      `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
      `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
      `persona=${(tPersonaEnd - tPersonaStart).toFixed(0)}ms, ` +
      `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms — no context to inject`,
    );
    logger?.debug?.(`${TAG} No memories/persona/scenes/principles to inject`);
    return undefined;
  }

  // Split recall context into stable and dynamic parts to optimize prompt caching.
  //
  // appendSystemContext (system prompt end — stable, cacheable):
  //   persona, scene navigation, memory tools guide
  //   These change infrequently; when content is identical across turns,
  //   providers with prompt caching (Anthropic/OpenAI) can cache this region.
  //
  // prependContext (user prompt prefix — dynamic, per-turn):
  //   L1 relevant memories — different every turn, moved out of system prompt
  //   so it doesn't bust the system prompt cache.
  const stableParts: string[] = [];
  // Track A slice 2 — the binding project principles (the WHY) go FIRST, before
  // persona/scene, framed as binding (not "for reference only" like facts).
  if (principles) {
    stableParts.push(formatPrinciplesBlock(principles));
  }
  if (personaContent) {
    // personaContent is ALREADY escaped at write time (persona-generator.ts:203
    // calls escapeXmlTags before saving persona.md). Do NOT escape again here —
    // double-escaping would turn a literal "&lt;" into "&amp;lt;".
    stableParts.push(`<user-persona>\n${personaContent}\n</user-persona>`);
  }
  if (sceneNavigation) {
    // Scene navigation is generated fresh here (generateSceneNavigation) from the
    // scene index, which is derived from stored — i.e. UNTRUSTED — memory content.
    // Escape XML-like tags so a scene name containing "</scene-navigation>" or
    // "<system>" cannot break out of this section and inject instructions.
    stableParts.push(`<scene-navigation>\n${escapeXmlTags(sceneNavigation)}\n</scene-navigation>`);
  }

  // Idea 5: Distinctiveness Scorer — inject top-K cornerstone memories ALONGSIDE
  // the heat-ranked scenes (not replacing them). Only active when a
  // cornerstoneTracker is provided so the feature is opt-in per deployment.
  // Fully fault-tolerant: buildCornerstones swallows all errors and returns "".
  if (cornerstoneTracker && vectorStore) {
    const cornerstoneBlock = await buildCornerstones({
      vectorStore,
      embeddingService,
      injectionTracker: cornerstoneTracker,
      logger,
    });
    if (cornerstoneBlock) {
      stableParts.push(cornerstoneBlock);
    }
  }

  // Dynamic part: L1 relevant memories (changes every turn) → prependContext (user prompt)
  let prependContext: string | undefined;
  if (memoryLines.length > 0) {
    // memoryLines is recalled memory content — UNTRUSTED (a prior session could
    // have stored a poisoned memory). Escape each line so a memory containing
    // "</relevant-memories><system>..." cannot close the section early and
    // inject attacker-controlled instructions into a future session.
    const safeMemoryLines = memoryLines.map((line) => escapeXmlTags(line));
    prependContext =
      `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${safeMemoryLines.join("\n")}\n</relevant-memories>`;
  }

  // Session-open banner: inject instruction on FIRST turn of each SESSION.
  // Keyed on sessionId (changes per session) with a sessionKey fallback — keying
  // on sessionKey alone fired the banner once per gateway-process lifetime
  // (sessionKey is stable per project), so it effectively never re-fired.
  // PEEK only (pending) — the caller commits the slot (markEmitted) after this
  // result is actually returned, so a timed-out recall never burns the banner.
  // Wrapped so any error is swallowed — the banner must never break a turn.
  const bannerKey = params.sessionId ?? params.sessionKey;
  let bannerEmitted = false;
  if (bannerTracker?.pending(bannerKey)) {
    try {
      const recentEventText = resolveRecentEventText(vectorStore);
      const banner = buildSessionBanner({
        projectName,
        personaLoaded: personaContent !== undefined,
        sceneCount,
        recentEventText,
      });
      prependContext = prependContext ? `${banner}\n\n${prependContext}` : banner;
      bannerEmitted = true;

      // "Dove eravamo" — on the first turn, prepend the previous session's
      // anchored recap for THIS project (reconstruction, not a doc dump).
      // Off the critical path: latestRecapBlock returns "" on any failure.
      if (projectName && vectorStore) {
        const recapBlock = latestRecapBlock({ store: vectorStore, project: projectName, logger });
        if (recapBlock) {
          prependContext = prependContext ? `${recapBlock}\n\n${prependContext}` : recapBlock;
        }
      }
    } catch {
      // Banner errors are silently swallowed — memory must never block the turn.
    }
  }

  // Append memory tools usage guide to the stable part so the agent knows
  // how to actively retrieve deeper context when the injected snippets
  // are not enough. This is static content and benefits from caching.
  if (stableParts.length > 0 || prependContext) {
    stableParts.push(MEMORY_TOOLS_GUIDE);
  }

  const appendSystemContext = stableParts.length > 0 ? stableParts.join("\n\n") : undefined;

  const totalMs = performance.now() - tRecallStart;
  logger?.info(
    `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
    `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryLines.length},` +
    `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
    `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
    `persona=${(tPersonaEnd - tPersonaStart).toFixed(0)}ms(${personaContent ? `${personaContent.length}chars` : "none"}), ` +
    `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms(${sceneNavigation ? "loaded" : "none"})`,
  );

  if (!appendSystemContext && !prependContext) {
    return undefined;
  }

  return {
    prependContext,
    appendSystemContext,
    recalledL1Memories,
    recalledL3Persona: personaContent ?? null,
    recallStrategy: effectiveStrategy,
    bannerEmitted,
  };
}

// ============================
// Session-open banner helpers
// ============================

/**
 * Return the text of the single most-recent KB event (if the store supports it
 * and has data). Returns undefined when unavailable — the banner omits the
 * "ultimo:" segment gracefully.
 *
 * Deliberately NOT async: listRecentEvents is a sync SQLite read (MaybePromise
 * returning the value directly). If the method is absent or throws, returns
 * undefined without blocking the turn.
 */
function resolveRecentEventText(vectorStore?: IMemoryStore): string | undefined {
  if (!vectorStore?.listRecentEvents) return undefined;
  try {
    const events = vectorStore.listRecentEvents("default", { limit: 1 });
    return events[0]?.text || undefined;
  } catch {
    return undefined;
  }
}

// ============================
// KB recall path (recall.source = "kb")
// ============================

/**
 * Run the Phase-4 entity-centric KB recall and return its results. Fault
 * tolerant: any failure degrades to [] so the recall path never blocks the turn
 * (mirrors searchMemories' try/catch contract).
 */
async function runKbRecall(
  userText: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<KbRecallResult[]> {
  if (!vectorStore) {
    logger?.debug?.(`${TAG} [kb] vectorStore unavailable — KB recall skipped`);
    return [];
  }
  const recallEmbeddingTimeoutMs = cfg.embedding?.recallTimeoutMs ?? cfg.embedding?.timeoutMs;
  try {
    // Redact secrets before the KB recall query is embedded (same egress guard
    // as the L1 search path above).
    return await kbRecall(redactSecrets(userText), {
      store: vectorStore,
      embeddingService,
      maxResults: cfg.recall.maxResults ?? 5,
      rerank: cfg.recall.rerank ?? false,
      embeddingTimeoutMs: recallEmbeddingTimeoutMs,
      logger,
    });
  } catch (err) {
    logger?.warn?.(`${TAG} [kb] KB recall failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Format a single KbRecallResult into a memory line matching the L1 line shape
 * (`- [type] content (活动时间: ...)`) so the existing injection + parsing logic
 * is unchanged. The calibrated 0-1 score is appended so the user-facing score is
 * the calibrated relevance, never raw RRF.
 */
function formatKbRecallLine(r: KbRecallResult): string {
  let line = `- [${r.owner_kind}] ${r.text} (relevance: ${r.score.toFixed(2)})`;
  const point = formatTimestamp(r.ts);
  if (point) line += ` (活动时间: ${point})`;
  return line;
}

// ============================
// Multi-strategy search dispatcher
// ============================

interface ScoredRecord {
  record: MemoryRecord;
  score: number;
}

/** Timing breakdown from memory search */
interface SearchTiming {
  ftsMs: number;
  embeddingMs: number;
  ftsHits: number;
  embeddingHits: number;
}

interface SearchResult {
  lines: string[];
  timing: SearchTiming;
}

/**
 * Search memories and return both formatted lines and structured details.
 *
 * This is a thin wrapper around `searchMemories` that also captures
 * the recalled memory metadata for metric reporting (agent_turn event).
 * It parses the returned formatted lines to extract type/content info.
 */
async function searchMemoriesWithDetails(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: "keyword" | "embedding" | "hybrid",
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<{ lines: string[]; memories: RecalledMemory[]; timing: SearchTiming }> {
  const result = await searchMemories(userText, pluginDataDir, cfg, logger, strategy, vectorStore, embeddingService);

  // Extract structured data from formatted memory lines.
  // Format: "- [type|scene] content (活动时间: ...)" or "- [type] content"
  const memories: RecalledMemory[] = result.lines.map((line) => {
    const match = line.match(/^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*\(活动时间:.*\))?$/);
    if (match) {
      const tag = match[1];
      const content = match[2].trim();
      const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
      return { content, score: 0, type: typePart };
    }
    return { content: line, score: 0, type: "unknown" };
  });

  return { lines: result.lines, memories, timing: result.timing };
}

/**
 * Search memories using the configured strategy.
 *
 * - "keyword": JSONL keyword-based (Jaccard similarity) — no embedding needed
 * - "embedding": VectorStore cosine similarity — requires vectorStore + embeddingService
 * - "hybrid": merge both keyword and embedding results with RRF (Reciprocal Rank Fusion)
 *
 * Falls back to keyword if embedding resources are unavailable.
 */
async function searchMemories(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: "keyword" | "embedding" | "hybrid",
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<SearchResult> {
  const emptyResult: SearchResult = { lines: [], timing: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 } };
  // Strip gateway-injected inbound metadata (Sender, timestamps, media markers,
  // base64 image data, etc.) so FTS / embedding queries are based on pure user
  // intent — THEN redact secrets so a pasted credential in the prompt is never
  // sent to the embedding provider as a query vector (recall-path egress leak).
  const cleanText = redactSecrets(sanitizeText(userText));

  if (cleanText.length < 2) {
    logger?.debug?.(`${TAG} Query too short for memory search (raw=${userText.length}, clean=${cleanText.length})`);
    return emptyResult;
  }

  if (cleanText.length !== userText.length) {
    logger?.debug?.(
      `${TAG} userText sanitized: ${userText.length} → ${cleanText.length} chars`,
    );
  }

  const maxResults = cfg.recall.maxResults ?? 5;
  const threshold = cfg.recall.scoreThreshold ?? 0.3;

  const embeddingAvailable = !!vectorStore && !!embeddingService;

  logger?.debug?.(
    `${TAG} [searchMemories] strategy=${strategy}, embeddingAvailable=${embeddingAvailable}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}, ` +
    `maxResults=${maxResults}, threshold=${threshold}`,
  );

  // Determine effective strategy (fall back to keyword if embedding not available)
  let effectiveStrategy = strategy;
  if ((strategy === "embedding" || strategy === "hybrid") && !embeddingAvailable) {
    logger?.warn?.(
      `${TAG} Strategy "${strategy}" requested but EmbeddingService not available, falling back to keyword`,
    );
    effectiveStrategy = "keyword";
  }

  logger?.debug?.(`${TAG} Search strategy: ${effectiveStrategy} (configured: ${strategy})`);

  // Resolve per-call embedding timeout for recall path.
  // Falls back to global embedding.timeoutMs when recallTimeoutMs is not configured.
  const recallEmbeddingTimeoutMs = cfg.embedding?.recallTimeoutMs ?? cfg.embedding?.timeoutMs;
  const embeddingCallOpts: EmbeddingCallOptions = { timeoutMs: recallEmbeddingTimeoutMs };

  try {
    if (effectiveStrategy === "keyword") {
      const tFts = performance.now();
      const lines = await searchByKeyword(cleanText, pluginDataDir, maxResults, threshold, logger, vectorStore);
      return { lines, timing: { ftsMs: performance.now() - tFts, embeddingMs: 0, ftsHits: lines.length, embeddingHits: 0 } };
    }

    if (effectiveStrategy === "embedding") {
      const tEmb = performance.now();
      const lines = await searchByEmbedding(cleanText, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts);
      return { lines, timing: { ftsMs: 0, embeddingMs: performance.now() - tEmb, ftsHits: 0, embeddingHits: lines.length } };
    }

    // Hybrid: if the store natively supports hybrid search (e.g. TCVDB does
    // server-side dense + sparse + RRF in a single API call), short-circuit
    // to avoid a redundant second HTTP request and a wasted local embed().
    if (vectorStore?.getCapabilities().nativeHybridSearch) {
      const tNative = performance.now();
      const results = await vectorStore.searchL1Hybrid({ query: cleanText, topK: maxResults });
      const nativeMs = performance.now() - tNative;
      logger?.debug?.(`${TAG} [hybrid-native] Single-call hybrid: ${results.length} results in ${nativeMs.toFixed(0)}ms`);
      const lines = results.map((r) => formatMemoryLine(vectorResultToFormatable(r)));
      return { lines, timing: { ftsMs: 0, embeddingMs: nativeMs, ftsHits: 0, embeddingHits: results.length } };
    }

    // Fallback: run keyword + embedding in parallel, merge with client-side RRF (SQLite path)
    return await searchHybrid(cleanText, pluginDataDir, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts);
  } catch (err) {
    logger?.warn?.(`${TAG} Memory search failed (strategy=${effectiveStrategy}): ${err instanceof Error ? err.message : String(err)}`);
    return emptyResult;
  }
}

// ============================
// Strategy: Keyword (FTS5 BM25, no in-memory fallback)
// ============================

async function searchByKeyword(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  threshold: number,
  logger?: Logger,
  vectorStore?: IMemoryStore,
): Promise<string[]> {
  // Prefer FTS5 if available
  if (vectorStore?.isFtsAvailable()) {
    const ftsQuery = buildFtsQuery(userText);
    if (ftsQuery) {
      logger?.debug?.(`${TAG} [keyword-fts] Using FTS5 BM25 search: query="${ftsQuery}"`);
      const ftsResults = await vectorStore.searchL1Fts(ftsQuery, maxResults * 2);
      if (ftsResults.length > 0) {
        logger?.debug?.(
          `${TAG} [keyword-fts] FTS5 raw results (${ftsResults.length}): ` +
          ftsResults.map((r) => `id=${r.record_id} score=${r.score.toFixed(6)}`).join(", "),
        );
        const filtered = ftsResults
          .filter((r) => r.score >= threshold)
          .slice(0, maxResults);

        if (filtered.length > 0) {
          logger?.debug?.(`${TAG} [keyword-fts] FTS5 found ${filtered.length} results (from ${ftsResults.length} raw, threshold=${threshold})`);
          return filtered.map((r) => formatMemoryLine(ftsResultToFormatable(r)));
        }

        // BM25 absolute scores are unreliable when the document set is very
        // small (e.g. 1–3 records) because IDF approaches 0.  In that case,
        // trust FTS5's MATCH + rank ordering and return the top results anyway.
        if (ftsResults.length <= maxResults) {
          logger?.debug?.(
            `${TAG} [keyword-fts] All ${ftsResults.length} results below threshold=${threshold} ` +
            `but document set is small — returning all matched results`,
          );
          return ftsResults.slice(0, maxResults).map((r) => formatMemoryLine(ftsResultToFormatable(r)));
        }
        logger?.debug?.(`${TAG} [keyword-fts] FTS5 returned 0 results above threshold (from ${ftsResults.length} raw)`);
      }
    }
  }

  // FTS5 not available or returned no results — skip in-memory fallback to avoid O(N) full scan
  logger?.debug?.(`${TAG} [keyword] FTS5 unavailable or no results, skipping keyword search`);
  return [];
}

// ============================
// Strategy: Embedding (VectorStore cosine)
// ============================

async function searchByEmbedding(
  userText: string,
  maxResults: number,
  threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
): Promise<string[]> {
  logger?.debug?.(
    `${TAG} [embedding-search] START query="${userText.slice(0, 80)}...", maxResults=${maxResults}, threshold=${threshold}`,
  );
  const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
  logger?.debug?.(
    `${TAG} [embedding-search] Query embedding OK: dims=${queryEmbedding.length}, ` +
    `norm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}, ` +
    `searching top-${maxResults * 2}...`,
  );
  // Retrieve more candidates for subsequent filtering
  const vecResults: L1SearchResult[] = await vectorStore.searchL1Vector(queryEmbedding, maxResults * 2);

  if (vecResults.length === 0) {
    logger?.debug?.(`${TAG} [embedding-search] Returned 0 results`);
    return [];
  }

  logger?.debug?.(`${TAG} [embedding-search] Got ${vecResults.length} candidates, filtering by threshold=${threshold}`);
  for (const r of vecResults) {
    logger?.debug?.(
      `${TAG} [embedding-search] candidate id=${r.record_id}, score=${r.score.toFixed(4)}, ` +
      `type=${r.type}, content="${r.content.slice(0, 60)}..."`,
    );
  }

  const filtered = vecResults
    .filter((r) => r.score >= threshold)
    .slice(0, maxResults);

  if (filtered.length > 0) {
    logger?.debug?.(`${TAG} [embedding-search] Found ${filtered.length} relevant memories above threshold (from ${vecResults.length} candidates)`);
    return filtered.map((r) => formatMemoryLine(vectorResultToFormatable(r)));
  }

  logger?.debug?.(`${TAG} [embedding-search] No results above threshold ${threshold}`);
  return [];
}

// ============================
// Strategy: Hybrid (Keyword + Embedding + RRF)
// ============================

/**
 * Hybrid search: run keyword (FTS5) and embedding in parallel, merge with
 * Reciprocal Rank Fusion (RRF) to combine rank lists.
 *
 * RRF score for a record at rank r = 1 / (k + r), where k=60 is a constant.
 * If a record appears in both lists, its RRF scores are summed.
 *
 * If FTS5 is unavailable, the keyword side returns empty and RRF uses
 * embedding results only.
 */
async function searchHybrid(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
): Promise<SearchResult> {
  // Run keyword and embedding searches in parallel
  const candidateK = maxResults * 3; // retrieve more for merging

  const [keywordResult, embeddingResult] = await Promise.all([
    // Keyword search: FTS5 only (no in-memory fallback)
    (async () => {
      const tStart = performance.now();
      try {
        // Try FTS5 first
        if (vectorStore.isFtsAvailable()) {
          const ftsQuery = buildFtsQuery(userText);
          if (ftsQuery) {
            const ftsResults = await vectorStore.searchL1Fts(ftsQuery, candidateK);
            if (ftsResults.length > 0) {
              logger?.debug?.(`${TAG} [hybrid-keyword-fts] FTS5 found ${ftsResults.length} candidates`);
              // Convert FtsSearchResult to ScoredRecord for RRF merge
              const records = ftsResults.map((r): ScoredRecord => ({
                record: {
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
                },
                score: r.score,
              }));
              return { records, ms: performance.now() - tStart };
            }
          }
        }
        // FTS5 not available or returned no results — skip in-memory fallback
        logger?.debug?.(`${TAG} [hybrid-keyword] FTS5 unavailable or no results, skipping keyword part`);
        return { records: [] as ScoredRecord[], ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: keyword part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { records: [] as ScoredRecord[], ms: performance.now() - tStart };
      }
    })(),
    // Embedding search
    (async () => {
      const tStart = performance.now();
      try {
        logger?.debug?.(`${TAG} [hybrid-embedding] Generating query embedding...`);
        const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
        logger?.debug?.(
          `${TAG} [hybrid-embedding] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}...`,
        );
        const results = await vectorStore.searchL1Vector(queryEmbedding, candidateK, userText);
        logger?.debug?.(`${TAG} [hybrid-embedding] Got ${results.length} candidates`);
        return { results, ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: embedding part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { results: [] as L1SearchResult[], ms: performance.now() - tStart };
      }
    })(),
  ]);

  const keywordResults = keywordResult.records;
  const embeddingResults = embeddingResult.results;
  const timing: SearchTiming = {
    ftsMs: keywordResult.ms,
    embeddingMs: embeddingResult.ms,
    ftsHits: keywordResults.length,
    embeddingHits: embeddingResults.length,
  };

  if (keywordResults.length === 0 && embeddingResults.length === 0) {
    logger?.debug?.(`${TAG} Hybrid search: both strategies returned 0 results`);
    return { lines: [], timing };
  }

  // RRF merge: k=60 is a standard constant from the RRF paper (shared helper
  // rrfScoreForRank — same formula used by the KB retrieval + memory_search).

  // Map: record_id → fused entry. We carry the raw embedding cosine and a
  // timestamp alongside the RRF score so we can (a) apply the score threshold
  // (RC3) — the pure RRF rank loses the cosine — and (b) apply a recency boost.
  interface MergedEntry {
    rrfScore: number;
    formatable: FormatableMemory;
    /** Raw embedding cosine similarity (0–1) if this record came from the vector side, else undefined. */
    cosine?: number;
    /** Whether this record appeared in the keyword (FTS exact-term) list. */
    fromKeyword: boolean;
    /** Best available memory timestamp (ISO) for recency weighting, if any. */
    timestamp?: string;
  }
  const mergedMap = new Map<string, MergedEntry>();

  // Process keyword results (FTS exact-term hits — no cosine available)
  for (let rank = 0; rank < keywordResults.length; rank++) {
    const r = keywordResults[rank];
    const id = r.record.id;
    const rrfScore = rrfScoreForRank(rank);
    const ts = (r.record.timestamps && r.record.timestamps.length > 0) ? r.record.timestamps[0] : undefined;
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += rrfScore;
      existing.fromKeyword = true;
      if (!existing.timestamp && ts) existing.timestamp = ts;
    } else {
      mergedMap.set(id, { rrfScore, formatable: recordToFormatable(r.record), fromKeyword: true, timestamp: ts });
    }
  }

  // Process embedding results (carry the raw cosine for thresholding)
  for (let rank = 0; rank < embeddingResults.length; rank++) {
    const r = embeddingResults[rank];
    const id = r.record_id;
    const rrfScore = rrfScoreForRank(rank);
    const ts = r.timestamp_str || r.timestamp_start || undefined;
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += rrfScore;
      existing.cosine = Math.max(existing.cosine ?? 0, r.score);
      if (!existing.timestamp && ts) existing.timestamp = ts;
    } else {
      mergedMap.set(id, { rrfScore, formatable: vectorResultToFormatable(r), cosine: r.score, fromKeyword: false, timestamp: ts });
    }
  }

  // RC3 threshold gate: drop embedding-only candidates whose raw cosine is below
  // the threshold (mirrors the single-strategy searchByEmbedding path). Keyword
  // (FTS) hits are kept regardless — they are exact-term matches with no cosine
  // to threshold, and dropping them would silently disable keyword recall.
  const gated = [...mergedMap.entries()].filter(([, e]) => {
    if (e.fromKeyword) return true;
    return (e.cosine ?? 0) >= threshold;
  });

  const droppedByThreshold = mergedMap.size - gated.length;
  if (droppedByThreshold > 0) {
    logger?.debug?.(
      `${TAG} Hybrid threshold gate: dropped ${droppedByThreshold} embedding-only result(s) below cosine ${threshold}`,
    );
  }

  // RC3 recency boost: relevance (RRF) is primary; recency only nudges
  // similarly-relevant items so newer memories sort ahead of equally-relevant
  // older ones. Sort by the recency-boosted fused score and take top results.
  const nowMs = Date.now();
  const sorted = gated
    .map(([id, e]) => ({ id, e, ranked: applyRecencyBoost(e.rrfScore, e.timestamp, nowMs) }))
    .sort((a, b) => b.ranked - a.ranked)
    .slice(0, maxResults);

  if (sorted.length > 0) {
    logger?.debug?.(
      `${TAG} Hybrid search found ${sorted.length} results ` +
      `(keyword=${keywordResults.length}, embedding=${embeddingResults.length}, ` +
      `gated=${gated.length}, threshold=${threshold})`,
    );
    return { lines: sorted.map(({ e }) => formatMemoryLine(e.formatable)), timing };
  }

  logger?.debug?.(`${TAG} Hybrid search: no results after merge/threshold`);
  return { lines: [], timing };
}

// ============================
// Unified memory line formatter
// ============================

/**
 * Format a single memory record into a rich natural-language line for prompt injection.
 *
 * Time semantics:
 *   - timestamp (点时间): when the activity/event happened, e.g. "2025-03-01 mentioned something"
 *   - activity_start_time / activity_end_time (段时间): activity time range, e.g. "trip from 2025-05-01 to 2025-05-10"
 *   - All three time fields may be empty/undefined — handled gracefully.
 *
 * Output examples:
 *   - [persona] 用户叫王小明，30岁，是一名软件工程师。
 *   - [episodic|旅行计划] 用户计划五月去日本旅行。(活动时间: 2025-05-01 ~ 2025-05-10)
 *   - [episodic] 用户今天加班到很晚。(活动时间: 2025-03-01)
 *   - [instruction] 用户要求回答时使用中文，保持简洁。
 */
interface FormatableMemory {
  type: string;
  content: string;
  scene_name?: string;
  /** Activity time range start (段时间 start), may be empty */
  activity_start_time?: string;
  /** Activity time range end (段时间 end), may be empty */
  activity_end_time?: string;
  /** Activity point-in-time (点时间: when it happened), may be empty */
  timestamp?: string;
}

function formatMemoryLine(m: FormatableMemory): string {
  // 1. Type tag + optional scene name
  const tag = m.scene_name ? `${m.type}|${m.scene_name}` : m.type;

  // 2. Content (core)
  let line = `- [${tag}] ${m.content}`;

  // 3. Time info — prefer activity_start/end range; fall back to timestamp as point-in-time
  const start = formatTimestamp(m.activity_start_time);
  const end = formatTimestamp(m.activity_end_time);
  const point = formatTimestamp(m.timestamp);

  if (start && end) {
    // 段时间: both start and end
    line += ` (活动时间: ${start} ~ ${end})`;
  } else if (start) {
    // 段时间: only start
    line += ` (活动时间: ${start}起)`;
  } else if (end) {
    // 段时间: only end
    line += ` (活动时间: 至${end})`;
  } else if (point) {
    // 点时间: single timestamp
    line += ` (活动时间: ${point})`;
  }
  // If all three are empty → no time info appended (graceful)

  return line;
}

/**
 * Format an ISO 8601 timestamp to a concise date or datetime string.
 * - If the time part is 00:00:00 → show date only (e.g. "2025-03-01")
 * - Otherwise → show date + time (e.g. "2025-03-01 14:30")
 * - Returns undefined for empty/invalid inputs.
 */
function formatTimestamp(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  // Try to parse ISO format: "2025-03-01T14:30:00.000Z" or "2025-03-01"
  const match = ts.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2})?)?/);
  if (!match) return undefined;
  const datePart = match[1];
  const timePart = match[2];
  if (!timePart || timePart === "00:00") {
    return datePart;
  }
  return `${datePart} ${timePart}`;
}

/**
 * Build a FormatableMemory from a full MemoryRecord (keyword search path).
 * Handles empty metadata, empty timestamps array gracefully.
 */
function recordToFormatable(record: MemoryRecord): FormatableMemory {
  const meta = record.metadata as { activity_start_time?: string; activity_end_time?: string } | undefined;
  return {
    type: record.type,
    content: record.content,
    scene_name: record.scene_name || undefined,
    activity_start_time: meta?.activity_start_time || undefined,
    activity_end_time: meta?.activity_end_time || undefined,
    timestamp: (record.timestamps && record.timestamps.length > 0) ? record.timestamps[0] : undefined,
  };
}

/**
 * Build a FormatableMemory from a VectorSearchResult (embedding search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
function vectorResultToFormatable(r: L1SearchResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}

/**
 * Build a FormatableMemory from an FtsSearchResult (FTS5 keyword search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
function ftsResultToFormatable(r: L1FtsResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}
