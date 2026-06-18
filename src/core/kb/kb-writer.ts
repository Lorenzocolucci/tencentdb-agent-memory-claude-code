/**
 * KB writer (Phase 2) — deterministic application of a validated KbDelta.
 *
 * `applyKbDelta` is the ONLY write path for the entity-centric core. It takes a
 * schema-validated `KbDelta` (model-local refs, no DB ids) and applies it to the
 * store with a deterministic, NO-LLM, NO-DELETE algorithm:
 *
 *   1. resolve/create every entity      → refMap[ref] = entityId
 *   2. insert every event (append-only) → eventIdMap[ref] = eventId
 *   3. upsert every fact (bi-temporal supersession in kb-queries)
 *   4. upsert every relation (idempotent by unique edge)
 *   5. AFTER the write: embed each affected HEAD fact ("{name} — {attr}: {value}")
 *      and each new event.text into kb_vec / kb_fts so P4 retrieval can find them.
 *
 * The delta's `.superRefine` already guarantees referential integrity, so the
 * resolve/insert order above can map every fact/relation/event reference without
 * defending against dangling refs.
 *
 * Embedding NEVER throws out of this function: a persistent embed failure is
 * logged LOUDLY (the fact/event lives in the DB but is not yet vector-recallable
 * and is flagged for reindex) — mirroring the RC2 pattern in l1-writer.ts.
 */

import type {
  KbEntity,
  KbEvent,
  KbFact,
  KbRelation,
  KbEventInput,
  KbRelationInput,
} from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";
import type { KbDelta } from "./extraction-schema.js";

const TAG = "[memory-tdai][kb-writer]";

// ============================
// Store capability surface
// ============================

/**
 * The exact subset of the store the writer needs. Declaring it locally (instead
 * of depending on the full `IMemoryStore`) keeps the writer testable on any
 * object that implements these KB primitives — and documents precisely which
 * methods must be present for the "kb" engine to function.
 */
export interface KbWriterStore {
  resolveOrCreateEntity(params: {
    namespace?: string;
    type: string;
    name: string;
    aliases?: string[];
    language?: string;
    project?: string;
    now: string;
  }): KbEntity;
  insertEvent(event: KbEventInput): KbEvent;
  upsertFact(params: {
    entityId: string;
    attribute: string;
    value: string;
    validFrom?: string;
    confidence?: number;
    sourceEventId?: string | null;
    language?: string;
    namespace?: string;
    now: string;
  }): KbFact;
  upsertRelation(rel: KbRelationInput): KbRelation;
  queryEntityById(id: string): KbEntity | null;
  upsertKbVector(
    ownerId: string,
    ownerKind: string,
    chunks: Float32Array | Float32Array[],
    updatedTime?: string,
  ): boolean;
  upsertKbFts(params: {
    ownerId: string;
    ownerKind: string;
    content: string;
    entityType?: string;
    namespace?: string;
    attribute?: string;
    updatedTime?: string;
  }): boolean;
}

// ============================
// Context + result
// ============================

export interface ApplyKbDeltaContext {
  /** Store implementing the KB write/embed primitives. */
  store: KbWriterStore;
  /** Embedding service (hardened). When absent, embedding is skipped (loud warn). */
  embeddingService?: EmbeddingService;
  /** Namespace tag (default "default"). */
  namespace?: string;
  /** Project tag stored on entities/events (cross-project recall by default). */
  project?: string;
  /** Session key for the inserted events. */
  sessionKey: string;
  /** Session id for the inserted events. */
  sessionId?: string;
  /** Learn-time ISO timestamp ("now"). */
  now: string;
  logger?: Logger;
}

export interface ApplyKbDeltaResult {
  entities: KbEntity[];
  facts: KbFact[];
  events: KbEvent[];
  relations: KbRelation[];
  /** Number of owners (facts + events) whose vector/FTS were written. */
  embedded: number;
}

// ============================
// Core
// ============================

/**
 * Apply a validated KbDelta to the store. See file header for the algorithm.
 */
export async function applyKbDelta(
  delta: KbDelta,
  ctx: ApplyKbDeltaContext,
): Promise<ApplyKbDeltaResult> {
  const namespace = ctx.namespace?.trim() || "default";
  const project = ctx.project ?? "";
  const { store, sessionKey, now, logger } = ctx;

  // ── 1. Entities → refMap[ref] = entityId ──
  const refMap = new Map<string, string>();
  const entities: KbEntity[] = [];
  for (const e of delta.entities) {
    const entity = store.resolveOrCreateEntity({
      namespace,
      type: e.type,
      name: e.name,
      aliases: e.aliases,
      language: e.language,
      project,
      now,
    });
    refMap.set(e.ref, entity.id);
    entities.push(entity);
  }

  // ── 2. Events (append-only) → eventIdMap[ref] = eventId ──
  const eventIdMap = new Map<string, string>();
  const events: KbEvent[] = [];
  for (const ev of delta.events) {
    // Map the event's entity refs to resolved entity ids (skip any that somehow
    // didn't resolve — superRefine guarantees they exist, this is defensive).
    const entityIds = ev.entity_refs
      .map((r) => refMap.get(r))
      .filter((id): id is string => typeof id === "string");

    const inserted = store.insertEvent({
      ts: ev.ts,
      recordedAt: now,
      sessionKey,
      sessionId: ctx.sessionId ?? "",
      namespace,
      project,
      type: ev.type,
      text: ev.text,
      language: delta.language,
      entities: entityIds,
      sourceMessageIds: ev.source_message_ids,
    });
    eventIdMap.set(ev.ref, inserted.id);
    events.push(inserted);
  }

  // ── 3. Facts (bi-temporal supersession) — collect affected HEAD facts ──
  const facts: KbFact[] = [];
  for (const f of delta.facts) {
    const entityId = refMap.get(f.entity_ref);
    if (!entityId) continue; // defensive: superRefine guarantees resolution
    const sourceEventId =
      f.source_event_ref !== undefined ? eventIdMap.get(f.source_event_ref) ?? null : null;

    const fact = store.upsertFact({
      entityId,
      attribute: f.attribute,
      value: f.value,
      validFrom: f.valid_from,
      confidence: f.confidence,
      sourceEventId,
      language: delta.language,
      namespace,
      now,
    });
    facts.push(fact);
  }

  // ── 4. Relations (idempotent by unique edge) ──
  const relations: KbRelation[] = [];
  for (const rel of delta.relations) {
    const srcId = refMap.get(rel.src_ref);
    const dstId = refMap.get(rel.dst_ref);
    if (!srcId || !dstId) continue; // defensive
    const upserted = store.upsertRelation({
      srcEntityId: srcId,
      type: rel.type,
      dstEntityId: dstId,
      namespace,
      sourceEventId: null,
      now,
    });
    relations.push(upserted);
  }

  // ── 5. Embed (after the write): HEAD facts + new events into kb_vec/kb_fts ──
  // Only the rows that ended as the current HEAD are worth indexing. upsertFact
  // returns the HEAD it wrote for cases A/B/C; a case-D backfill returns a CLOSED
  // historical row (superseded_by set) which we skip — it's not the current
  // belief, so it must not pollute recall.
  const embedded = await embedAffected({ facts, events, ctx, namespace });

  return { entities, facts, events, relations, embedded };
}

// ============================
// Embedding (loud-on-failure, never throws)
// ============================

async function embedAffected(args: {
  facts: KbFact[];
  events: KbEvent[];
  ctx: ApplyKbDeltaContext;
  namespace: string;
}): Promise<number> {
  const { facts, events, ctx, namespace } = args;
  const { store, embeddingService, logger } = ctx;

  if (!embeddingService) {
    if (facts.length > 0 || events.length > 0) {
      logger?.error(
        `${TAG} NO embedding service wired — ${facts.length} fact(s) + ${events.length} event(s) ` +
        `written WITHOUT vectors (NOT recallable by semantic search); flagged for reindex.`,
      );
    }
    return 0;
  }

  let embedded = 0;

  // ── HEAD facts: "{entity.name} — {attribute}: {value}" ──
  for (const fact of facts) {
    // A case-D backfill is a CLOSED row (not the head) — never index it.
    if (fact.superseded_by !== null || fact.valid_to !== null) continue;

    const entity = store.queryEntityById(fact.entity_id);
    const entityName = entity?.name ?? fact.entity_id;
    const text = `${entityName} — ${fact.attribute}: ${fact.value}`;

    const ok = await embedOwner({
      ownerId: fact.id,
      ownerKind: "fact",
      text,
      entityType: entity?.type ?? "",
      attribute: fact.attribute,
      namespace,
      ctx,
    });
    if (ok) embedded++;
  }

  // ── New events: event.text ──
  for (const event of events) {
    const ok = await embedOwner({
      ownerId: event.id,
      ownerKind: "event",
      text: event.text,
      entityType: "",
      attribute: "",
      namespace,
      ctx,
    });
    if (ok) embedded++;
  }

  return embedded;
}

/**
 * Embed one owner (fact/event) into kb_vec + kb_fts. NEVER throws.
 * On persistent embed failure logs LOUDLY (the row is not vector-recallable and
 * flagged for reindex) — mirroring the RC2 pattern in l1-writer.ts.
 * FTS is written even if the vector embed fails (keyword recall still works).
 */
async function embedOwner(args: {
  ownerId: string;
  ownerKind: string;
  text: string;
  entityType: string;
  attribute: string;
  namespace: string;
  ctx: ApplyKbDeltaContext;
}): Promise<boolean> {
  const { ownerId, ownerKind, text, entityType, attribute, namespace, ctx } = args;
  const { store, embeddingService, now, logger } = ctx;

  // FTS first — keyword recall must work even when the vector embed fails.
  store.upsertKbFts({
    ownerId,
    ownerKind,
    content: text,
    entityType,
    namespace,
    attribute,
    updatedTime: now,
  });

  const chunks = await embedChunksWithRetry(embeddingService!, text, ownerId, ownerKind, logger);
  if (!chunks) {
    logger?.error(
      `${TAG} ${ownerKind} ${ownerId} written WITHOUT a vector (embedding unavailable) — ` +
      `NOT recallable by semantic search; flagged for reindex.`,
    );
    return false;
  }

  const upsertOk = store.upsertKbVector(ownerId, ownerKind, chunks, now);
  if (!upsertOk) {
    logger?.error(
      `${TAG} upsertKbVector returned false for ${ownerKind} ${ownerId} despite a valid embedding — ` +
      `vector may be MISSING (NOT recallable); flagged for reindex.`,
    );
    return false;
  }
  return true;
}

/**
 * Embed `text` into chunk vectors with ONE bounded retry (fresh retry budget).
 * Returns the chunk vectors, or undefined if both attempts fail / produce no
 * chunks. Mirrors l1-writer.ts::embedChunksWithRetry.
 */
async function embedChunksWithRetry(
  embeddingService: EmbeddingService,
  text: string,
  ownerId: string,
  ownerKind: string,
  logger?: Logger,
): Promise<Float32Array[] | undefined> {
  const MAX_EMBED_ATTEMPTS = 2; // initial + 1 retry
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_EMBED_ATTEMPTS; attempt++) {
    try {
      const chunks = await embeddingService.embedChunks(text);
      if (chunks.length === 0) {
        logger?.warn(
          `${TAG} Embedding produced 0 chunks for ${ownerKind} ${ownerId} (attempt ${attempt}); ` +
          `row will be FTS-only.`,
        );
        return undefined;
      }
      if (attempt > 1) {
        logger?.info(`${TAG} Embedding retry SUCCEEDED for ${ownerKind} ${ownerId} on attempt ${attempt}.`);
      }
      return chunks;
    } catch (embedErr) {
      lastErr = embedErr;
      const msg = embedErr instanceof Error ? embedErr.message : String(embedErr);
      if (attempt < MAX_EMBED_ATTEMPTS) {
        logger?.warn(
          `${TAG} Embedding attempt ${attempt}/${MAX_EMBED_ATTEMPTS} FAILED for ${ownerKind} ${ownerId}, ` +
          `retrying: ${msg}`,
        );
      }
    }
  }
  logger?.error(
    `${TAG} Embedding FAILED after ${MAX_EMBED_ATTEMPTS} attempts for ${ownerKind} ${ownerId}: ` +
    `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
  return undefined;
}
