/**
 * KB retrieval (read path) — Phase 4 of the entity-centric redesign.
 *
 * `kbRecall(query, ...)` is the entity-centric counterpart of the legacy L1
 * hybrid recall in auto-recall.ts. It runs THREE candidate sources in parallel,
 * fuses them with RRF, reweights by recency + entity/fact importance, optionally
 * reranks (flag-gated, no-op for now), and returns a CALIBRATED 0-1 relevance
 * score plus a compact, progressively-disclosable result line per owner.
 *
 * Pipeline (blueprint §Retrieval):
 *   parallel candidates:
 *     A) searchKbFts(query)            — BM25 over kb_fts (exact-term recall)
 *     B) embed(query) → searchKbVector — cosine over kb_vec (semantic recall)
 *     C) entity-name match             — tokenize query → queryEntitiesByTokens
 *                                        → expand to each entity's HEAD facts
 *   → RRF(k=60) collapse by owner_id   (shared rrfScoreForRank — NOT a fork)
 *   → reweight: recency (applyRecencyBoost) + importance (entity.importance,
 *               fact confidence·support)  [boosts only — relevance stays primary]
 *   → rerank(): flag-gated, currently a no-op passthrough, fail-open by design
 *   → calibrate to 0-1: interpretable score (top cosine / normalized blend) —
 *               NEVER the raw RRF magnitude
 *
 * Only HEAD facts (superseded_by IS NULL AND valid_to IS NULL) and current
 * events are returned. Superseded facts are dropped at fetch time.
 *
 * Design notes:
 *   - Fault-tolerant like the rest of the store layer: any single candidate
 *     source that throws degrades to empty rather than failing the whole recall.
 *   - Immutable style: builds new arrays/objects, never mutates inputs.
 *   - Progressive disclosure: returns short lines + owner ids; the caller injects
 *     a compact index and fetches the full entity page on demand (later phase).
 */

import type { IMemoryStore, KbEntity, KbFact } from "../store/types.js";
import type { EmbeddingService, EmbeddingCallOptions } from "../store/embedding.js";
import { buildFtsQuery } from "../store/sqlite.js";
import { sanitizeText } from "../../utils/sanitize.js";
import { applyRecencyBoost, rrfScoreForRank } from "../hooks/auto-recall.js";

const TAG = "[memory-tdai] [kb-recall]";

// ============================
// Types
// ============================

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** Owner kinds kbRecall can return. */
export type KbRecallOwnerKind = "fact" | "event";

/**
 * A single recalled KB item.
 *
 * `score` is the CALIBRATED 0-1 relevance (interpretable; derived from cosine /
 * a normalized blend) — never the raw RRF magnitude. `text` is the compact line
 * to inject. `owner_id` lets the caller fetch the full entity page on demand.
 */
export interface KbRecallResult {
  owner_id: string;
  owner_kind: KbRecallOwnerKind;
  /** Calibrated relevance in [0,1] (higher is better). */
  score: number;
  /** Compact display line: fact → "{entity} — {attribute}: {value}"; event → text. */
  text: string;
  /** Owning entity id (for a fact hit; absent for free-standing events). */
  entity_id?: string;
  /** Fact attribute (for a fact hit). */
  attribute?: string;
  /** World-time timestamp (event ts, or fact valid_from). */
  ts?: string;
}

export interface KbRecallOptions {
  store: IMemoryStore;
  embeddingService?: EmbeddingService;
  /** Namespace scope (default "default"). */
  namespace?: string;
  /** Active locale (reserved for future projection-aware rendering). */
  locale?: string;
  /** Max results to return (default 5). */
  maxResults?: number;
  /** When true, run the rerank() stage (default false / no-op passthrough). */
  rerank?: boolean;
  /** Per-call embedding timeout override (recall-path). */
  embeddingTimeoutMs?: number;
  logger?: Logger;
}

// ============================
// Rerank interface (Phase 4: no-op passthrough, fail-open)
// ============================

/**
 * A reranker takes the fused candidate list (already ordered) plus the query and
 * returns a possibly-reordered list. Phase 4 ships ONLY the no-op passthrough;
 * Kimi list-rerank / a local cross-encoder slot in here behind `recall.rerank`
 * in a later phase. The contract is fail-open: a reranker that throws or times
 * out MUST be treated by the caller as "no change" so recall never breaks.
 */
export interface Reranker {
  rerank(query: string, items: FusedCandidate[]): Promise<FusedCandidate[]>;
}

/** Default reranker: identity passthrough (Phase 4 baseline = calibrated RRF). */
export const noopReranker: Reranker = {
  async rerank(_query: string, items: FusedCandidate[]): Promise<FusedCandidate[]> {
    return items;
  },
};

// ============================
// Internal candidate / fused shapes
// ============================

/** One owner candidate from a single source, with its rank in that source list. */
interface RankedCandidate {
  ownerId: string;
  ownerKind: KbRecallOwnerKind;
  /** 0-based rank within the source list this candidate came from. */
  rank: number;
  /** Raw cosine (0-1) if this candidate came from the vector source, else undefined. */
  cosine?: number;
}

/** A candidate after RRF fusion across sources (collapsed by owner_id). */
export interface FusedCandidate {
  ownerId: string;
  ownerKind: KbRecallOwnerKind;
  /** Summed RRF contribution across the sources this owner appeared in. */
  rrfScore: number;
  /** Best cosine across vector hits for this owner (undefined if never a vector hit). */
  cosine?: number;
  /** Whether this owner appeared in the FTS (exact-term) source. */
  fromFts: boolean;
  /** Whether this owner appeared in the entity-name-match source. */
  fromEntityMatch: boolean;
}

/** A fully-rendered candidate (row fetched, superseded facts already dropped). */
interface RenderedCandidate {
  fused: FusedCandidate;
  result: Omit<KbRecallResult, "score">;
  /** World-time timestamp for recency weighting. */
  ts?: string;
  /** Importance multiplier in [~0,1+] derived from the owning entity/fact. */
  importance: number;
}

// ============================
// Tuning constants
// ============================

/**
 * Over-fetch factor for each candidate source so RRF/reweight have room to work
 * before trimming to maxResults. Mirrors the L1 hybrid path (candidateK).
 */
const CANDIDATE_FANOUT = 3;

/**
 * Importance boost weight applied multiplicatively, like RECENCY_WEIGHT. Kept
 * small so RELEVANCE stays dominant — importance only nudges similarly-relevant
 * items. final = recencyBoosted * (1 + IMPORTANCE_WEIGHT * importance).
 */
const IMPORTANCE_WEIGHT = 0.15;

// ============================
// Tokenization for the entity-name-match source
// ============================

/**
 * Split a query into lexical tokens for entity-name matching. Reuses the same
 * Unicode word-class split buildFtsQuery falls back to, so the entity-match
 * source sees the same tokens the FTS source does. (We intentionally do NOT run
 * jieba here — entity name match is a coarse lexical contains-check; the FTS
 * source already covers segmented recall.)
 */
function tokenizeQuery(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(tokens.map((t) => t.trim()).filter((t) => t.length >= 2))];
}

// ============================
// Candidate sources (each fault-tolerant: returns [] on any failure)
// ============================

/** Source A: BM25 over kb_fts. */
function recallFts(
  store: IMemoryStore,
  query: string,
  limit: number,
  logger?: Logger,
): RankedCandidate[] {
  if (!store.searchKbFts) return [];
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];
  try {
    const rows = store.searchKbFts(ftsQuery, limit);
    return rows.map((r, rank) => ({
      ownerId: r.owner_id,
      ownerKind: normalizeOwnerKind(r.owner_kind),
      rank,
    }));
  } catch (err) {
    logger?.warn?.(`${TAG} FTS candidate source failed (non-fatal): ${errMsg(err)}`);
    return [];
  }
}

/** Source B: embed the query (hardened path) + cosine over kb_vec. */
async function recallVector(
  store: IMemoryStore,
  embeddingService: EmbeddingService | undefined,
  query: string,
  limit: number,
  embeddingCallOpts: EmbeddingCallOptions | undefined,
  logger?: Logger,
): Promise<RankedCandidate[]> {
  if (!store.searchKbVector || !embeddingService) return [];
  try {
    const queryEmbedding = await embeddingService.embed(query, embeddingCallOpts);
    const rows = store.searchKbVector(queryEmbedding, limit);
    return rows.map((r, rank) => ({
      ownerId: r.owner_id,
      ownerKind: normalizeOwnerKind(r.owner_kind),
      rank,
      cosine: r.score,
    }));
  } catch (err) {
    logger?.warn?.(`${TAG} vector candidate source failed (non-fatal): ${errMsg(err)}`);
    return [];
  }
}

/**
 * Source C: entity-name match → each matched entity's HEAD facts become fact
 * candidates. Higher entity token-coverage ranks first; within one entity its
 * head facts keep entity order. Returns fact owners (kind="fact") so they fuse
 * with the FTS/vector fact hits by owner_id.
 */
function recallEntityMatch(
  store: IMemoryStore,
  query: string,
  namespace: string,
  limit: number,
  logger?: Logger,
): RankedCandidate[] {
  if (!store.queryEntitiesByTokens || !store.queryHeadFacts) return [];
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  try {
    const entities = store.queryEntitiesByTokens(tokens, namespace, limit);
    const out: RankedCandidate[] = [];
    let rank = 0;
    for (const entity of entities) {
      const heads = store.queryHeadFacts(entity.id);
      for (const head of heads) {
        out.push({ ownerId: head.id, ownerKind: "fact", rank });
        rank += 1;
        if (out.length >= limit) return out;
      }
    }
    return out;
  } catch (err) {
    logger?.warn?.(`${TAG} entity-match candidate source failed (non-fatal): ${errMsg(err)}`);
    return [];
  }
}

// ============================
// RRF fusion (collapse by owner_id) — uses the shared rrfScoreForRank helper
// ============================

/**
 * Fuse the three ranked candidate lists with Reciprocal Rank Fusion, collapsing
 * by owner_id. An owner that appears in multiple sources SUMS its per-source RRF
 * contributions (same semantics as the L1 hybrid path). We carry the best cosine
 * + source-membership flags so later stages can calibrate the score.
 */
function fuseRrf(sources: RankedCandidate[][]): FusedCandidate[] {
  const map = new Map<string, FusedCandidate>();
  const SOURCE_FTS = 0;
  const SOURCE_ENTITY = 2;

  sources.forEach((list, sourceIndex) => {
    for (const cand of list) {
      const contribution = rrfScoreForRank(cand.rank);
      const existing = map.get(cand.ownerId);
      if (existing) {
        existing.rrfScore += contribution;
        if (cand.cosine != null) {
          existing.cosine = Math.max(existing.cosine ?? 0, cand.cosine);
        }
        if (sourceIndex === SOURCE_FTS) existing.fromFts = true;
        if (sourceIndex === SOURCE_ENTITY) existing.fromEntityMatch = true;
      } else {
        map.set(cand.ownerId, {
          ownerId: cand.ownerId,
          ownerKind: cand.ownerKind,
          rrfScore: contribution,
          cosine: cand.cosine,
          fromFts: sourceIndex === SOURCE_FTS,
          fromEntityMatch: sourceIndex === SOURCE_ENTITY,
        });
      }
    }
  });

  return [...map.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

// ============================
// Render + importance (drops superseded facts here)
// ============================

/**
 * Resolve a fused candidate into a display row + recency ts + importance, OR
 * null when it should be excluded (e.g. a superseded / missing fact, a missing
 * event). This is where the "only HEAD facts / current data" invariant is
 * enforced on the READ side.
 */
function renderCandidate(
  store: IMemoryStore,
  fused: FusedCandidate,
): RenderedCandidate | null {
  if (fused.ownerKind === "fact") {
    return renderFact(store, fused);
  }
  if (fused.ownerKind === "event") {
    return renderEvent(store, fused);
  }
  return null;
}

function renderFact(store: IMemoryStore, fused: FusedCandidate): RenderedCandidate | null {
  const fact = store.queryFactById?.(fused.ownerId) ?? null;
  if (!fact) return null;
  // HEAD-only invariant: drop superseded / historical facts at read time.
  if (fact.superseded_by !== null || fact.valid_to !== null) return null;

  const entity = store.queryEntityById?.(fact.entity_id) ?? null;
  const entityName = entity?.name ?? fact.entity_id;
  const text = `${entityName} — ${fact.attribute}: ${fact.value}`;

  return {
    fused,
    result: {
      owner_id: fused.ownerId,
      owner_kind: "fact",
      text,
      entity_id: fact.entity_id,
      attribute: fact.attribute,
      ts: fact.valid_from,
    },
    ts: fact.valid_from,
    importance: factImportance(fact, entity),
  };
}

function renderEvent(store: IMemoryStore, fused: FusedCandidate): RenderedCandidate | null {
  const event = store.queryEventById?.(fused.ownerId) ?? null;
  if (!event) return null;
  return {
    fused,
    result: {
      owner_id: fused.ownerId,
      owner_kind: "event",
      text: event.text,
      ts: event.ts,
    },
    ts: event.ts,
    importance: eventImportance(),
  };
}

/**
 * Importance term for a fact, in [0,1]. Blends the owning entity's importance
 * (0-100 → 0-1) with the fact's own confidence and corroboration (support).
 * This is a BOOST input only (see IMPORTANCE_WEIGHT) — it must stay bounded so
 * it can never dominate relevance.
 */
function factImportance(fact: KbFact, entity: KbEntity | null): number {
  const entityImp = clamp01((entity?.importance ?? 50) / 100);
  const confidence = clamp01(fact.confidence);
  // Diminishing-returns support: 1→0, 2→~0.5, 4→0.75, capped at 1.
  const support = fact.support > 0 ? 1 - 1 / fact.support : 0;
  // Average the three signals into a single bounded importance.
  return clamp01((entityImp + confidence + support) / 3);
}

/** Events carry no entity/confidence here; give them a neutral mid importance. */
function eventImportance(): number {
  return 0.5;
}

// ============================
// Calibration (0-1 interpretable relevance — NEVER raw RRF)
// ============================

/**
 * Calibrate a fused candidate to an interpretable 0-1 relevance score.
 *
 *   - Vector hits: use the raw cosine directly (already a meaningful 0-1
 *     similarity). This is the most interpretable signal we have.
 *   - Non-vector hits (FTS-only / entity-match-only): no cosine available, so
 *     derive a calibrated value from the RRF magnitude normalized against the
 *     theoretical single-source maximum (rank 0 → rrfScoreForRank(0)). A hit in
 *     N sources sums up to N×max, so we divide by that max and squash into 0-1
 *     with a saturating transform, leaving headroom below a true #1 cosine.
 *
 * The returned score is what the user/agent sees; the raw RRF magnitude is an
 * internal ranking quantity and is deliberately never surfaced.
 */
function calibrateScore(fused: FusedCandidate): number {
  if (fused.cosine != null) {
    return clamp01(fused.cosine);
  }
  // FTS / entity-match only: normalize RRF against one source's rank-0 max.
  const singleSourceMax = rrfScoreForRank(0);
  const normalized = fused.rrfScore / singleSourceMax; // ~ number of strong sources
  // Saturating map: 1 strong source → 0.5, more sources push toward (but never
  // reach) 1. Keeps lexical-only hits below a perfect-cosine semantic hit.
  return clamp01(normalized / (normalized + 1));
}

// ============================
// Public API
// ============================

/**
 * Entity-centric KB recall. Returns up to `maxResults` calibrated, compact
 * results. Never throws: any internal failure degrades to fewer/no results.
 */
export async function kbRecall(
  query: string,
  options: KbRecallOptions,
): Promise<KbRecallResult[]> {
  const {
    store,
    embeddingService,
    namespace = "default",
    maxResults = 5,
    rerank = false,
    embeddingTimeoutMs,
    logger,
  } = options;

  const cleanQuery = sanitizeText(query);
  if (cleanQuery.length < 2) {
    logger?.debug?.(`${TAG} query too short (clean=${cleanQuery.length}) — skipping`);
    return [];
  }

  const candidateLimit = maxResults * CANDIDATE_FANOUT;
  const embeddingCallOpts: EmbeddingCallOptions | undefined = embeddingTimeoutMs
    ? { timeoutMs: embeddingTimeoutMs }
    : undefined;

  // ── Parallel candidate recall (order MUST match fuseRrf source indices) ──
  //    0 = FTS, 1 = vector, 2 = entity-name match.
  const [ftsCandidates, vectorCandidates, entityCandidates] = await Promise.all([
    Promise.resolve(recallFts(store, cleanQuery, candidateLimit, logger)),
    recallVector(store, embeddingService, cleanQuery, candidateLimit, embeddingCallOpts, logger),
    Promise.resolve(recallEntityMatch(store, cleanQuery, namespace, candidateLimit, logger)),
  ]);

  if (
    ftsCandidates.length === 0 &&
    vectorCandidates.length === 0 &&
    entityCandidates.length === 0
  ) {
    logger?.debug?.(`${TAG} all candidate sources returned 0`);
    return [];
  }

  // ── RRF fusion (collapse by owner_id) ──
  const fused = fuseRrf([ftsCandidates, vectorCandidates, entityCandidates]);

  // ── Rerank stage (flag-gated, fail-open). Phase 4 = no-op passthrough. ──
  let ranked = fused;
  if (rerank) {
    try {
      ranked = await noopReranker.rerank(cleanQuery, fused);
    } catch (err) {
      // Fail-open: keep the un-reranked fused order so recall never breaks.
      logger?.warn?.(`${TAG} rerank failed — keeping fused order (fail-open): ${errMsg(err)}`);
      ranked = fused;
    }
  }

  // ── Render rows (drops superseded facts / missing rows here) ──
  const rendered: RenderedCandidate[] = [];
  for (const candidate of ranked) {
    const r = renderCandidate(store, candidate);
    if (r) rendered.push(r);
  }

  if (rendered.length === 0) {
    logger?.debug?.(`${TAG} no current rows after rendering (all superseded/missing)`);
    return [];
  }

  // ── Reweight by recency + importance (relevance stays primary), then sort.
  //    The recency/importance boosts apply to the RRF magnitude for ORDERING;
  //    the user-facing score is the separate calibrated 0-1 value below.
  const nowMs = Date.now();
  const reweighted = rendered.map((r) => {
    const recencyBoosted = applyRecencyBoost(r.fused.rrfScore, r.ts, nowMs);
    const ranking = recencyBoosted * (1 + IMPORTANCE_WEIGHT * r.importance);
    return { rendered: r, ranking };
  });
  reweighted.sort((a, b) => b.ranking - a.ranking);

  // ── Calibrate + trim to maxResults. Returned score = calibrated 0-1 ──
  const results: KbRecallResult[] = reweighted
    .slice(0, maxResults)
    .map(({ rendered: r }) => ({
      ...r.result,
      score: calibrateScore(r.fused),
    }));

  logger?.debug?.(
    `${TAG} returning ${results.length} result(s) ` +
    `(fts=${ftsCandidates.length}, vec=${vectorCandidates.length}, ` +
    `entity=${entityCandidates.length}, fused=${fused.length}, rerank=${rerank})`,
  );

  return results;
}

// ============================
// Helpers
// ============================

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Normalize a raw owner_kind string to the two kinds kbRecall returns. */
function normalizeOwnerKind(kind: string): KbRecallOwnerKind {
  return kind === "event" ? "event" : "fact";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
