/**
 * Selective KB retrieval (Phase 3, "silent unless useful") — the query path.
 *
 * Same three candidate sources as kbRecall (FTS, vector, entity-name match) and the
 * same RRF fusion, but with the rules that make injection earn its place:
 *
 *   - the prompt is reduced to its DISTINCTIVE words (whole words, ≥4 chars, no filler);
 *     a prompt with none ("ok procedi") retrieves nothing;
 *   - an entity named in the prompt is a seed only when it is not a hub (a whole project
 *     or the user have thousands of facts: they are context, not an address);
 *   - a fact is a candidate because ITS TEXT is about the prompt, ranked by the prompt
 *     and never alphabetically; the entity's latest event is preferred over a bare fact;
 *   - every candidate gets a REAL 0-1 relevance (selective-recall.relevanceScore) and is
 *     dropped below τ — a turn with nothing above τ injects nothing;
 *   - at most `maxFactsPerEntity` memories per entity, every line carries its subject.
 *
 * Fault-tolerant like the rest of the store layer: a failing source degrades to empty.
 */

import type { SelectiveRecallConfig } from "../../config.js";
import type { IMemoryStore, KbEntity } from "../store/types.js";
import type { EmbeddingCallOptions } from "../store/embedding.js";
import { sanitizeText } from "../../utils/sanitize.js";
import { applyRecencyBoost } from "../hooks/auto-recall.js";
import {
  fuseRrf,
  recallFts,
  recallVector,
  timed,
  type FusedCandidate,
  type KbRecallOptions,
  type KbRecallResult,
  type RankedCandidate,
} from "./retrieval.js";
import { isNoiseAttribute } from "./spreading-activation.js";
import {
  distinctiveTokens,
  evidencePoints,
  matchedTokenCount,
  ownerKey,
  relevanceScore,
  totalPoints,
  withSubject,
} from "./selective-recall.js";
import { rankFactsForQuery } from "./selective-store.js";

const TAG = "[memory-tdai] [kb-recall-selective]";
const CANDIDATE_FANOUT = 3;
const ENTITIES_MATCHED = 8;
const FACTS_PER_ENTITY_CANDIDATES = 4;
const EVENTS_PER_ENTITY_CANDIDATES = 2;
/** Ranking nudge (NOT relevance): an entity's event is used ~16× more often than a bare fact. */
const EVENT_PREFERENCE = 1.1;
const IMPORTANCE_WEIGHT = 0.15;
/** A prompt word mentioned by at most this many KB documents is "rare" (names something). */
const RARE_TOKEN_MAX_DOCS = 100;

export interface KbSelectiveOptions
  extends Pick<
    KbRecallOptions,
    "store" | "embeddingService" | "namespace" | "embeddingTimeoutMs" | "skipVector" | "allowBruteForceVector" | "phaseMs" | "logger"
  > {
  selective: SelectiveRecallConfig;
  /** Owner keys ("kind:id") to drop before ranking: other projects, chronic noise, recently shown. */
  excludeOwners?: (owners: Array<{ owner_id: string; owner_kind: string }>) => Set<string>;
}

interface SelCandidate {
  fused: FusedCandidate;
  result: Omit<KbRecallResult, "score">;
  /** The text the prompt is matched against: attribute+value for a fact, the text of an event. */
  body: string;
  /** Name of the entity the memory is about (the subject shown on its line), if known. */
  subject?: string;
  entityId?: string;
  importance: number;
}

export async function kbRecallSelective(query: string, options: KbSelectiveOptions): Promise<KbRecallResult[]> {
  const { store, embeddingService, namespace = "default", selective, skipVector = false, phaseMs, logger } = options;
  const cleanQuery = sanitizeText(query);
  const tokens = distinctiveTokens(cleanQuery);
  if (tokens.length === 0) {
    logger?.debug?.(`${TAG} no distinctive words in the prompt — nothing to retrieve`);
    return [];
  }
  const limit = selective.maxLines * CANDIDATE_FANOUT;
  const embeddingCallOpts: EmbeddingCallOptions | undefined = options.embeddingTimeoutMs
    ? { timeoutMs: options.embeddingTimeoutMs }
    : undefined;

  const [fts, vector, entity] = await Promise.all([
    Promise.resolve(timed(phaseMs, "fts", () => recallFts(store, tokens.join(" "), limit, logger))),
    skipVector
      ? Promise.resolve<RankedCandidate[]>([])
      : withBudget(
          recallVector(store, embeddingService, cleanQuery, limit, embeddingCallOpts, options.allowBruteForceVector ?? false, logger),
          VECTOR_BUDGET_MS,
          [],
        ),
    Promise.resolve(timed(phaseMs, "entityMatch", () => recallEntitySelective(store, tokens, namespace, selective, limit, logger))),
  ]);
  if (fts.length + vector.length + entity.length === 0) return [];

  const rendered = timed(phaseMs, "render", () => renderAll(store, fuseRrf([fts, vector, entity])));
  const rare = readRareTokens(store, tokens);
  const maxPoints = totalPoints(tokens, rare);
  const excluded = options.excludeOwners?.(rendered.map((c) => ({ owner_id: c.result.owner_id, owner_kind: c.result.owner_kind }))) ?? new Set<string>();
  const nowMs = Date.now();

  const scored = rendered
    .filter((c) => !excluded.has(ownerKey(c.result.owner_kind, c.result.owner_id)))
    .map((c) => {
      const relevance = relevanceScore(
        {
          cosine: c.fused.cosine,
          ftsScore: c.fused.ftsScore,
          // Anchored = the memory's subject is named by a whole word of the prompt,
          // whichever route (entity match, FTS, vector) brought the candidate in.
          entityMatch: c.fused.fromEntityMatch || (c.subject !== undefined && matchedTokenCount(tokens, c.subject) > 0),
          points: evidencePoints(tokens, c.body, rare),
          maxPoints,
        },
        { minPoints: selective.minEvidencePoints, anchoredMinPoints: selective.anchoredMinEvidencePoints },
      );
      const ranking =
        relevance *
        applyRecencyBoost(1, c.result.ts, nowMs) *
        (1 + IMPORTANCE_WEIGHT * c.importance) *
        (c.result.owner_kind === "event" ? EVENT_PREFERENCE : 1);
      return { c, relevance, ranking };
    })
    .filter((s) => s.relevance >= selective.minRelevance)
    .sort((a, b) => b.ranking - a.ranking);

  return capPerEntity(scored, selective.maxFactsPerEntity)
    .slice(0, selective.maxLines)
    .map((s) => ({ ...s.c.result, score: s.relevance }));
}

/** The remote query embedding must not hold the lexical sources hostage: past this it counts as empty. */
const VECTOR_BUDGET_MS = 1500;

async function withBudget<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Words of the prompt that few KB documents mention (the store answers from a bounded FTS count). */
function readRareTokens(store: IMemoryStore, tokens: readonly string[]): Set<string> {
  try {
    const fn = (store as { rareKbTokens?: (t: readonly string[], maxDocs: number) => Set<string> }).rareKbTokens;
    return typeof fn === "function" ? fn.call(store, tokens, RARE_TOKEN_MAX_DOCS) : new Set<string>();
  } catch {
    return new Set<string>(); // fail-closed on rarity: fewer points, never more noise
  }
}

/** Keep at most `max` memories per entity, preserving rank order. Events without an entity are free. */
function capPerEntity<T extends { c: SelCandidate }>(items: readonly T[], max: number): T[] {
  const perEntity = new Map<string, number>();
  const out: T[] = [];
  for (const it of items) {
    const id = it.c.entityId;
    if (id) {
      const n = perEntity.get(id) ?? 0;
      if (n >= max) continue;
      perEntity.set(id, n + 1);
    }
    out.push(it);
  }
  return out;
}

/**
 * Source C, selective: entities named by a whole distinctive word, hubs skipped. Each
 * contributes its latest events and the head facts that are ABOUT the prompt (ranked by
 * it, never A→Z). Relevance gating happens later, on the text actually matched.
 */
function recallEntitySelective(
  store: IMemoryStore,
  tokens: readonly string[],
  namespace: string,
  selective: SelectiveRecallConfig,
  limit: number,
  logger?: KbSelectiveOptions["logger"],
): RankedCandidate[] {
  if (!store.queryEntitiesByTokens || !store.queryHeadFacts) return [];
  try {
    const out: RankedCandidate[] = [];
    let rank = 0;
    for (const entity of store.queryEntitiesByTokens([...tokens], namespace, ENTITIES_MATCHED)) {
      const heads = store.queryHeadFacts(entity.id);
      if (heads.length > selective.hubFactThreshold) continue; // hub: context, not a seed
      const events = store.queryEventsForEntity?.(entity.id, namespace, EVENTS_PER_ENTITY_CANDIDATES) ?? [];
      for (const e of events) out.push({ ownerId: e.id, ownerKind: "event", rank: rank++ });
      const facts = rankFactsForQuery(heads.filter((f) => !isNoiseAttribute(f.attribute)), entity, tokens)
        .slice(0, FACTS_PER_ENTITY_CANDIDATES);
      for (const f of facts) out.push({ ownerId: f.id, ownerKind: "fact", rank: rank++ });
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    logger?.warn?.(`${TAG} entity-match source failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function renderAll(store: IMemoryStore, fused: FusedCandidate[]): SelCandidate[] {
  const out: SelCandidate[] = [];
  const names = new Map<string, KbEntity | null>();
  const entityOf = (id: string): KbEntity | null => {
    if (!names.has(id)) names.set(id, store.queryEntityById?.(id) ?? null);
    return names.get(id) ?? null;
  };
  for (const f of fused) {
    const c = f.ownerKind === "event" ? renderEvent(store, f, entityOf) : renderFact(store, f, entityOf);
    if (c) out.push(c);
  }
  return out;
}

function renderFact(
  store: IMemoryStore,
  fused: FusedCandidate,
  entityOf: (id: string) => KbEntity | null,
): SelCandidate | null {
  const fact = store.queryFactById?.(fused.ownerId) ?? null;
  if (!fact || fact.superseded_by !== null || fact.valid_to !== null) return null; // HEAD only
  const entity = entityOf(fact.entity_id);
  return {
    fused,
    result: {
      owner_id: fused.ownerId,
      owner_kind: "fact",
      text: `${entity?.name ?? fact.entity_id} — ${fact.attribute}: ${fact.value}`,
      entity_id: fact.entity_id,
      attribute: fact.attribute,
      ts: fact.valid_from,
    },
    body: `${fact.attribute} ${fact.value}`,
    subject: entity?.name,
    entityId: fact.entity_id,
    importance: Math.min(1, Math.max(0, ((entity?.importance ?? 50) / 100 + fact.confidence) / 2)),
  };
}

function renderEvent(
  store: IMemoryStore,
  fused: FusedCandidate,
  entityOf: (id: string) => KbEntity | null,
): SelCandidate | null {
  const event = store.queryEventById?.(fused.ownerId) ?? null;
  if (!event) return null;
  const firstEntity = event.entities[0];
  const subject = firstEntity ? entityOf(firstEntity)?.name : undefined;
  return {
    fused,
    result: {
      owner_id: fused.ownerId,
      owner_kind: "event",
      text: withSubject(subject, event.text),
      ts: event.ts,
      ...(firstEntity ? { entity_id: firstEntity } : {}),
    },
    body: event.text,
    subject,
    entityId: firstEntity,
    importance: 0.5,
  };
}
