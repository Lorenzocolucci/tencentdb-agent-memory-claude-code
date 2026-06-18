/**
 * KB queries — Entity-Centric Core data layer (Phase 1).
 *
 * This module holds the PURE logic + SQL for the new entity-centric tables
 * (entities, facts, events, relations) and the kb_vec/kb_fts recall surfaces.
 * It is ADDITIVE: it does not touch the existing l0_ / l1_ tables and does not
 * change any capture/recall behavior yet (that is wired up in later phases).
 *
 * Why a separate module (not all inside sqlite.ts)?
 *   - The supersession algorithm is the trickiest piece of the whole redesign.
 *     Keeping it isolated, small, and heavily commented makes it auditable by a
 *     non-developer and unit-testable on a temp DB.
 *   - sqlite.ts stays focused on L0/L1; it simply delegates the KB methods here.
 *
 * Everything here is SYNCHRONOUS (matches the node:sqlite DatabaseSync API used
 * by the rest of the store) and uses parameterized queries (no string concat of
 * user data → no SQL injection).
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  KbEntity,
  KbEvent,
  KbEventInput,
  KbFact,
  KbRelation,
  KbRelationInput,
} from "../store/types.js";

// ============================================================================
// ID helpers
// ============================================================================

/**
 * Deterministic 16-hex-char id from the given parts.
 * Used for entities and relations so the SAME real-world thing always maps to
 * the SAME id — which is what makes the whole pipeline idempotent.
 *
 * Parts are joined with "|" (a separator that never appears inside a namespace,
 * type, or canonical_key after normalization) before hashing.
 */
function sha1Id(prefix: string, parts: string[]): string {
  const hash = createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
  return `${prefix}_${hash}`;
}

/** Deterministic entity id: ent_+sha1(namespace|type|canonical_key)[:16]. */
export function entityId(namespace: string, type: string, canonicalKey: string): string {
  return sha1Id("ent", [namespace, type, canonicalKey]);
}

/** Deterministic relation id: rel_+sha1(namespace|src|type|dst)[:16]. */
export function relationId(
  namespace: string,
  srcEntityId: string,
  type: string,
  dstEntityId: string,
): string {
  return sha1Id("rel", [namespace, srcEntityId, type, dstEntityId]);
}

// Base-32 (Crockford) alphabet used by ULIDs — no I, L, O, U to avoid ambiguity.
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Monotonic guard so two ids generated in the same millisecond still sort. */
let _lastUlidMs = -1;
let _ulidCounter = 0;

/**
 * Generate a ULID-like, time-sortable id.
 *
 * Format: <prefix>_<10-char base32 timestamp><randomness>.
 * The timestamp prefix makes ids sort in creation order lexicographically —
 * which is exactly what we want for facts/events (newest id > older id), so a
 * plain `ORDER BY id` walks them chronologically.
 *
 * Not a spec-perfect ULID (we use Math.random for the entropy section, which is
 * fine for an id that only needs to be unique + sortable within one DB), but it
 * preserves the sortable-by-time property the blueprint relies on.
 *
 * `nowMs` is injectable so tests can force a deterministic, ordered sequence.
 */
export function ulidLike(prefix: string, nowMs: number = Date.now()): string {
  // 48-bit millisecond timestamp → 10 base32 chars.
  let ms = Math.max(0, Math.floor(nowMs));
  let ts = "";
  for (let i = 9; i >= 0; i--) {
    ts = ULID_ALPHABET[ms % 32] + ts;
    ms = Math.floor(ms / 32);
  }

  // Monotonic tiebreaker: if multiple ids are minted in the SAME ms, bump a
  // counter so the later id still sorts after the earlier one. This guarantees
  // that, within a single process, id order == call order even at sub-ms speed.
  if (nowMs === _lastUlidMs) {
    _ulidCounter++;
  } else {
    _lastUlidMs = nowMs;
    _ulidCounter = 0;
  }
  let counter = _ulidCounter;
  let counterStr = "";
  for (let i = 3; i >= 0; i--) {
    counterStr = ULID_ALPHABET[counter % 32] + counterStr;
    counter = Math.floor(counter / 32);
  }

  // 6 random chars of entropy so concurrent processes don't collide.
  let rand = "";
  for (let i = 0; i < 6; i++) {
    rand += ULID_ALPHABET[Math.floor(Math.random() * 32)];
  }

  return `${prefix}_${ts}${counterStr}${rand}`;
}

/** Reset the ULID monotonic state — test-only. @internal */
export function _resetUlidStateForTest(): void {
  _lastUlidMs = -1;
  _ulidCounter = 0;
}

// ============================================================================
// Canonical key — deterministic entity dedup key
// ============================================================================

/**
 * Base normalization shared by every entity type:
 *   NFKC (collapse compatibility forms) → lowercase → trim → collapse internal
 *   whitespace runs to a single space.
 *
 * This is what makes "TypeScript", "typescript", and "  TypeScript " resolve to
 * the same entity.
 */
function normalizeBase(name: string): string {
  return name.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Normalize a file path to a posix-style canonical form:
 *   - backslashes → forward slashes (Windows → posix)
 *   - collapse duplicate slashes
 *   - drop a single trailing slash
 * NFKC + lowercase + trim still apply (paths are matched case-insensitively here
 * — acceptable on Windows/macOS; a future lint job can split genuinely distinct
 * case-sensitive paths if it ever matters).
 */
function normalizeFilePath(name: string): string {
  const base = normalizeBase(name).replace(/\\/g, "/").replace(/\/+/g, "/");
  // Drop a trailing slash unless the whole path IS "/".
  return base.length > 1 ? base.replace(/\/$/, "") : base;
}

/**
 * Normalize a library name by stripping a trailing version suffix so
 * "react@18.2.0", "react 18", and "react" all collapse to "react".
 * Recognizes the common forms: "name@version", "name version", "name==version",
 * "name>=version", and a bare trailing semver token.
 */
function normalizeLibrary(name: string): string {
  let base = normalizeBase(name);
  // Strip a trailing version constraint. The operator part can be a RUN of
  // range characters (npm-style), e.g. "@^3.16.2", "==1.2.3", ">=1.2", "~=1.0".
  // [@=<>~^ ]+ consumes the whole operator run before the leading digit.
  base = base.replace(/\s*[@=<>~^]+\s*v?\d[\w.\-]*$/i, "");
  // "name 1.2.3" (space-separated bare version token, no operator)
  base = base.replace(/\s+v?\d[\w.\-]*$/i, "");
  return base.trim();
}

/**
 * Compute the canonical_key for an entity.
 *
 * The key is `${normalizedType}:${normalizedName}` so the same name under two
 * different types stays distinct (e.g. a person named "Sofia" vs a project
 * named "Sofia"). Type-specific name normalization:
 *   - file     → posix path normalize
 *   - library  → strip version suffix
 *   - person / everything else → base normalize (NFKC, lower, trim)
 */
export function canonicalKey(type: string, name: string): string {
  const t = normalizeBase(type);
  let normName: string;
  switch (t) {
    case "file":
      normName = normalizeFilePath(name);
      break;
    case "library":
      normName = normalizeLibrary(name);
      break;
    case "person":
    default:
      normName = normalizeBase(name);
      break;
  }
  return `${t}:${normName}`;
}

/**
 * Normalize a fact VALUE for equality comparison.
 *
 * Two values are "the same fact" (corroboration, not a new version) when their
 * normalized forms match. We deliberately normalize only lightly (NFKC + trim +
 * collapse whitespace) — we do NOT lowercase, because for many attributes case
 * carries meaning (e.g. an env var name, a code symbol). Display always uses the
 * original stored value.
 */
function normalizeFactValue(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

// ============================================================================
// Row mappers (SQL row → typed object)
// ============================================================================

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rowToEntity(row: Record<string, unknown>): KbEntity {
  return {
    id: row.id as string,
    type: row.type as string,
    name: row.name as string,
    canonical_key: row.canonical_key as string,
    namespace: row.namespace as string,
    project: (row.project as string) ?? "",
    language: (row.language as string) ?? "und",
    aliases: parseJsonArray(row.aliases_json),
    importance: (row.importance as number) ?? 50,
    created_time: row.created_time as string,
    updated_time: row.updated_time as string,
  };
}

function rowToFact(row: Record<string, unknown>): KbFact {
  return {
    id: row.id as string,
    entity_id: row.entity_id as string,
    attribute: row.attribute as string,
    value: row.value as string,
    language: (row.language as string) ?? "und",
    valid_from: row.valid_from as string,
    valid_to: (row.valid_to as string | null) ?? null,
    learned_at: row.learned_at as string,
    superseded_by: (row.superseded_by as string | null) ?? null,
    superseded_at: (row.superseded_at as string | null) ?? null,
    source_event_id: (row.source_event_id as string | null) ?? null,
    confidence: (row.confidence as number) ?? 0.7,
    support: (row.support as number) ?? 1,
    namespace: row.namespace as string,
    created_time: row.created_time as string,
  };
}

function rowToEvent(row: Record<string, unknown>): KbEvent {
  return {
    id: row.id as string,
    ts: row.ts as string,
    recorded_at: row.recorded_at as string,
    session_key: row.session_key as string,
    session_id: (row.session_id as string) ?? "",
    namespace: row.namespace as string,
    project: (row.project as string) ?? "",
    type: row.type as string,
    text: row.text as string,
    language: (row.language as string) ?? "und",
    entities: parseJsonArray(row.entities_json),
    source_message_ids: parseJsonArray(row.source_message_ids_json),
  };
}

// ============================================================================
// Input validation helpers
// ============================================================================

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`[kb-queries] ${field} must be a non-empty string`);
  }
  return value;
}

// ============================================================================
// Entity resolution
// ============================================================================

/**
 * Resolve an entity by canonical key, or create it.
 *
 * Resolution order (deterministic, NO LLM):
 *   1. Exact match on (namespace, type, canonical_key)        → return it.
 *   2. Alias match: an existing entity (same ns+type) whose aliases_json
 *      contains the normalized name                            → merge the
 *      incoming display name into its aliases and return it.
 *   3. Otherwise create a fresh entity with the deterministic sha1 id.
 *
 * Aliases let "TS" find the "TypeScript" entity once that alias has been
 * recorded, without a fuzzy/LLM step. Near-duplicate reconciliation that needs
 * judgement is a separate, non-destructive lint job (later phase).
 */
export function resolveOrCreateEntity(
  db: DatabaseSync,
  params: {
    namespace?: string;
    type: string;
    name: string;
    aliases?: string[];
    language?: string;
    project?: string;
    now: string;
  },
): KbEntity {
  const namespace = params.namespace?.trim() || "default";
  const type = requireNonEmpty(params.type, "type");
  const name = requireNonEmpty(params.name, "name");
  const now = requireNonEmpty(params.now, "now");
  const language = params.language?.trim() || "und";
  const project = params.project ?? "";
  const incomingAliases = (params.aliases ?? []).map((a) => a.trim()).filter(Boolean);

  const key = canonicalKey(type, name);
  const normType = normalizeBase(type);

  // ── 1. Exact (namespace, type, canonical_key) match ──
  const exact = db
    .prepare("SELECT * FROM entities WHERE namespace = ? AND type = ? AND canonical_key = ?")
    .get(namespace, normType, key) as Record<string, unknown> | undefined;
  if (exact) {
    // Merge any NEW aliases the caller supplied (idempotent — set union).
    const merged = mergeAliasesIfNeeded(db, exact, incomingAliases, now);
    return merged;
  }

  // ── 2. Alias match ──
  // Look for an entity in the same ns+type whose recorded aliases already
  // contain this name (normalized). We compare on the normalized form so
  // "TypeScript" matches a stored alias "typescript".
  const normName = normalizeBase(name);
  const candidates = db
    .prepare("SELECT * FROM entities WHERE namespace = ? AND type = ?")
    .all(namespace, normType) as Array<Record<string, unknown>>;
  for (const cand of candidates) {
    const aliases = parseJsonArray(cand.aliases_json).map((a) => normalizeBase(a));
    if (aliases.includes(normName)) {
      // Merge the incoming display name (+ any extra aliases) into the entity.
      const merged = mergeAliasesIfNeeded(db, cand, [name, ...incomingAliases], now);
      return merged;
    }
  }

  // ── 3. Create ──
  const id = entityId(namespace, normType, key);
  // Seed aliases with the supplied list (display name is held in `name`, not
  // duplicated into aliases — aliases are ALTERNATE spellings only).
  const aliasesJson = JSON.stringify([...new Set(incomingAliases)]);
  db.prepare(
    `INSERT INTO entities (
       id, type, name, canonical_key, namespace, project, language,
       aliases_json, importance, created_time, updated_time
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace, type, canonical_key) DO NOTHING`,
  ).run(id, normType, name, key, namespace, project, language, aliasesJson, 50, now, now);

  // Re-read (handles the rare race where a concurrent writer inserted first).
  const created = db
    .prepare("SELECT * FROM entities WHERE namespace = ? AND type = ? AND canonical_key = ?")
    .get(namespace, normType, key) as Record<string, unknown>;
  return rowToEntity(created);
}

/**
 * Merge new aliases into an existing entity row (set union). Returns the
 * up-to-date entity. Only writes when something actually changed (keeps
 * updated_time stable for pure re-reads → idempotent).
 */
function mergeAliasesIfNeeded(
  db: DatabaseSync,
  row: Record<string, unknown>,
  newAliases: string[],
  now: string,
): KbEntity {
  const current = parseJsonArray(row.aliases_json);
  const currentSet = new Set(current.map((a) => normalizeBase(a)));
  const toAdd = newAliases.filter((a) => {
    const norm = normalizeBase(a);
    // Don't add the display name itself as an alias, and skip ones we already have.
    return norm.length > 0 && norm !== normalizeBase(row.name as string) && !currentSet.has(norm);
  });

  if (toAdd.length === 0) {
    return rowToEntity(row);
  }

  const merged = [...current, ...toAdd];
  db.prepare("UPDATE entities SET aliases_json = ?, updated_time = ? WHERE id = ?").run(
    JSON.stringify(merged),
    now,
    row.id as string,
  );
  return rowToEntity({ ...row, aliases_json: JSON.stringify(merged), updated_time: now });
}

export function queryEntityById(db: DatabaseSync, id: string): KbEntity | null {
  const row = db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEntity(row) : null;
}

export function queryEntityByKey(
  db: DatabaseSync,
  namespace: string,
  type: string,
  canonicalKeyValue: string,
): KbEntity | null {
  const row = db
    .prepare("SELECT * FROM entities WHERE namespace = ? AND type = ? AND canonical_key = ?")
    .get(namespace, normalizeBase(type), canonicalKeyValue) as Record<string, unknown> | undefined;
  return row ? rowToEntity(row) : null;
}

// ============================================================================
// Events (append-only)
// ============================================================================

/**
 * Insert an event. APPEND-ONLY: events are never updated or deleted. The id is
 * a time-sortable ULID-like value (unless the caller supplies one), so events
 * sort chronologically by id.
 */
export function insertEvent(
  db: DatabaseSync,
  event: KbEventInput,
  nowMs: number = Date.now(),
): KbEvent {
  const ts = requireNonEmpty(event.ts, "ts");
  const sessionKey = requireNonEmpty(event.sessionKey, "sessionKey");
  const type = requireNonEmpty(event.type, "type");
  const text = requireNonEmpty(event.text, "text");

  const id = event.id?.trim() || ulidLike("evt", nowMs);
  const recordedAt = event.recordedAt?.trim() || new Date(nowMs).toISOString();
  const sessionId = event.sessionId ?? "";
  const namespace = event.namespace?.trim() || "default";
  const project = event.project ?? "";
  const language = event.language?.trim() || "und";
  const entities = event.entities ?? [];
  const sourceMessageIds = event.sourceMessageIds ?? [];

  db.prepare(
    `INSERT INTO events (
       id, ts, recorded_at, session_key, session_id, namespace, project,
       type, text, language, entities_json, source_message_ids_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ts,
    recordedAt,
    sessionKey,
    sessionId,
    namespace,
    project,
    type,
    text,
    language,
    JSON.stringify(entities),
    JSON.stringify(sourceMessageIds),
  );

  return {
    id,
    ts,
    recorded_at: recordedAt,
    session_key: sessionKey,
    session_id: sessionId,
    namespace,
    project,
    type,
    text,
    language,
    entities,
    source_message_ids: sourceMessageIds,
  };
}

// ============================================================================
// Facts — bi-temporal supersession upsert (the heart of the redesign)
// ============================================================================

/**
 * Upsert a single (entity, attribute) fact using bi-temporal supersession.
 *
 * KEY CONCEPT — the "HEAD" fact:
 *   For each (entity_id, attribute) there is at most ONE current fact: the row
 *   with superseded_by IS NULL AND valid_to IS NULL. That is the "head" — the
 *   value we believe is true RIGHT NOW. Older/replaced facts are kept forever
 *   (audit trail); they are simply no longer the head.
 *
 * THE ALGORITHM (no LLM, no DELETE — ever):
 *   Find the current head for (entity, attribute).
 *
 *   A) No head exists
 *        → INSERT a new head. (First time we learn this attribute.)
 *
 *   B) Head exists and the new value is the SAME (normalized) as the head
 *        → CORROBORATION. Don't create a new version. Instead:
 *            support  := support + 1            (we've seen it again)
 *            confidence := max(old, new)        (best evidence wins)
 *            valid_from := min(old, new)         (earliest known true-from)
 *          The head row is updated in place; no history is written.
 *
 *   C) Head exists and the new value is DIFFERENT, and the new fact is NEWER
 *      in world-time (valid_from >= head.valid_from)
 *        → SUPERSEDE. The belief changed. Two writes:
 *            1. Close the old head: set valid_to = new.valid_from,
 *               superseded_by = <new id>, superseded_at = now. (Kept, not deleted.)
 *            2. INSERT the new value as the new head.
 *
 *   D) Head exists and the new value is DIFFERENT, but the new fact is OLDER
 *      in world-time (valid_from < head.valid_from)
 *        → BACKFILL HISTORY. We just learned something that was true in the
 *          PAST, before the current head. The head must NOT change. We INSERT
 *          the older value as a CLOSED historical row:
 *            valid_to     = head.valid_from   (it stopped being true when head began)
 *            superseded_by = head.id          (the head replaced it)
 *            superseded_at = now
 *          The head row is left completely untouched.
 *
 * Why this matters: it lets the memory hold "what we believe now" AND "what was
 * true before" without ever destroying information — the exact failure mode the
 * old LLM-destructive dedup caused.
 */
export function upsertFact(
  db: DatabaseSync,
  params: {
    entityId: string;
    attribute: string;
    value: string;
    validFrom?: string;
    confidence?: number;
    sourceEventId?: string | null;
    language?: string;
    namespace?: string;
    now: string;
  },
  nowMs: number = Date.now(),
): KbFact {
  const entityIdValue = requireNonEmpty(params.entityId, "entityId");
  const attribute = requireNonEmpty(params.attribute, "attribute");
  const value = requireNonEmpty(params.value, "value");
  const now = requireNonEmpty(params.now, "now");
  const validFrom = params.validFrom?.trim() || now;
  const confidence = clampConfidence(params.confidence);
  const sourceEventId = params.sourceEventId ?? null;
  const language = params.language?.trim() || "und";
  const namespace = params.namespace?.trim() || "default";

  // Find the current HEAD for this (entity, attribute).
  const headRow = db
    .prepare(
      `SELECT * FROM facts
       WHERE entity_id = ? AND attribute = ?
         AND superseded_by IS NULL AND valid_to IS NULL`,
    )
    .get(entityIdValue, attribute) as Record<string, unknown> | undefined;

  // ── Case A: no head → insert the first head ──
  if (!headRow) {
    return insertHeadFact(db, {
      entityIdValue,
      attribute,
      value,
      language,
      validFrom,
      learnedAt: now,
      sourceEventId,
      confidence,
      namespace,
      now,
      nowMs,
    });
  }

  const head = rowToFact(headRow);
  const sameValue = normalizeFactValue(head.value) === normalizeFactValue(value);

  // ── Case B: same value → corroborate the head in place (no new version) ──
  if (sameValue) {
    const newSupport = head.support + 1;
    const newConfidence = Math.max(head.confidence, confidence);
    // Keep the EARLIEST known valid_from (string ISO compare preserves order).
    const newValidFrom = validFrom < head.valid_from ? validFrom : head.valid_from;
    db.prepare(
      "UPDATE facts SET support = ?, confidence = ?, valid_from = ? WHERE id = ?",
    ).run(newSupport, newConfidence, newValidFrom, head.id);
    return { ...head, support: newSupport, confidence: newConfidence, valid_from: newValidFrom };
  }

  // ── Different value: newer (supersede) vs older (backfill history) ──
  if (validFrom >= head.valid_from) {
    // Case C: SUPERSEDE — the new value is the newer belief.
    const newHead = insertHeadFact(db, {
      entityIdValue,
      attribute,
      value,
      language,
      validFrom,
      learnedAt: now,
      sourceEventId,
      confidence,
      namespace,
      now,
      nowMs,
    });
    // Close the OLD head (keep the row; just mark it superseded). The old head's
    // world-time ends exactly when the new head's world-time begins.
    db.prepare(
      "UPDATE facts SET valid_to = ?, superseded_by = ?, superseded_at = ? WHERE id = ?",
    ).run(validFrom, newHead.id, now, head.id);
    return newHead;
  }

  // Case D: BACKFILL — the new value is OLDER than the head. Insert it as a
  // CLOSED historical row and leave the head untouched.
  return insertClosedHistoricalFact(db, {
    entityIdValue,
    attribute,
    value,
    language,
    validFrom,
    validTo: head.valid_from, // stopped being true when the head began
    learnedAt: now,
    supersededBy: head.id,
    supersededAt: now,
    sourceEventId,
    confidence,
    namespace,
    now,
    nowMs,
  });
}

/** Clamp confidence into [0,1]; default 0.7 when undefined/invalid. */
function clampConfidence(c: number | undefined): number {
  if (typeof c !== "number" || Number.isNaN(c)) return 0.7;
  return Math.min(1, Math.max(0, c));
}

/** Insert a fresh HEAD fact (valid_to NULL, superseded_by NULL). */
function insertHeadFact(
  db: DatabaseSync,
  f: {
    entityIdValue: string;
    attribute: string;
    value: string;
    language: string;
    validFrom: string;
    learnedAt: string;
    sourceEventId: string | null;
    confidence: number;
    namespace: string;
    now: string;
    nowMs: number;
  },
): KbFact {
  const id = ulidLike("fact", f.nowMs);
  db.prepare(
    `INSERT INTO facts (
       id, entity_id, attribute, value, language, valid_from, valid_to, learned_at,
       superseded_by, superseded_at, source_event_id, confidence, support,
       namespace, created_time
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    f.entityIdValue,
    f.attribute,
    f.value,
    f.language,
    f.validFrom,
    f.learnedAt,
    f.sourceEventId,
    f.confidence,
    f.namespace,
    f.now,
  );
  return {
    id,
    entity_id: f.entityIdValue,
    attribute: f.attribute,
    value: f.value,
    language: f.language,
    valid_from: f.validFrom,
    valid_to: null,
    learned_at: f.learnedAt,
    superseded_by: null,
    superseded_at: null,
    source_event_id: f.sourceEventId,
    confidence: f.confidence,
    support: 1,
    namespace: f.namespace,
    created_time: f.now,
  };
}

/** Insert a CLOSED historical fact (valid_to + superseded_by set up-front). */
function insertClosedHistoricalFact(
  db: DatabaseSync,
  f: {
    entityIdValue: string;
    attribute: string;
    value: string;
    language: string;
    validFrom: string;
    validTo: string;
    learnedAt: string;
    supersededBy: string;
    supersededAt: string;
    sourceEventId: string | null;
    confidence: number;
    namespace: string;
    now: string;
    nowMs: number;
  },
): KbFact {
  const id = ulidLike("fact", f.nowMs);
  db.prepare(
    `INSERT INTO facts (
       id, entity_id, attribute, value, language, valid_from, valid_to, learned_at,
       superseded_by, superseded_at, source_event_id, confidence, support,
       namespace, created_time
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    f.entityIdValue,
    f.attribute,
    f.value,
    f.language,
    f.validFrom,
    f.validTo,
    f.learnedAt,
    f.supersededBy,
    f.supersededAt,
    f.sourceEventId,
    f.confidence,
    f.namespace,
    f.now,
  );
  return {
    id,
    entity_id: f.entityIdValue,
    attribute: f.attribute,
    value: f.value,
    language: f.language,
    valid_from: f.validFrom,
    valid_to: f.validTo,
    learned_at: f.learnedAt,
    superseded_by: f.supersededBy,
    superseded_at: f.supersededAt,
    source_event_id: f.sourceEventId,
    confidence: f.confidence,
    support: 1,
    namespace: f.namespace,
    created_time: f.now,
  };
}

/** Current (HEAD) facts for an entity. */
export function queryHeadFacts(db: DatabaseSync, entityIdValue: string): KbFact[] {
  const rows = db
    .prepare(
      `SELECT * FROM facts
       WHERE entity_id = ? AND superseded_by IS NULL AND valid_to IS NULL
       ORDER BY attribute ASC`,
    )
    .all(entityIdValue) as Array<Record<string, unknown>>;
  return rows.map(rowToFact);
}

// ============================================================================
// Read primitives for retrieval (Phase 4 — fetch a single row by id)
// ============================================================================
//
// Retrieval gets back only an owner_id from the kb_vec/kb_fts recall surfaces.
// To render a compact result line (and to drop superseded facts) it must fetch
// the underlying row. These are tiny, read-only, parameterized lookups.

/**
 * Fetch a single fact by id (any version, HEAD or historical). Retrieval uses
 * this to (a) verify a vector/FTS fact hit is still the HEAD before showing it
 * and (b) render "{entity} — {attribute}: {value}".
 */
export function queryFactById(db: DatabaseSync, id: string): KbFact | null {
  const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToFact(row) : null;
}

/** Fetch a single event by id (events are append-only / immutable). */
export function queryEventById(db: DatabaseSync, id: string): KbEvent | null {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEvent(row) : null;
}

/**
 * Entity-name match (Phase 4 retrieval, candidate source C).
 *
 * Tokenize the query upstream, pass the NORMALIZED tokens in here, and this
 * returns entities whose display name, any alias, or canonical_key contains a
 * token. This is a deterministic lexical recall path (NO LLM, NO embedding) so
 * "Sofia" finds the Sofia project even when the vector side is weak.
 *
 * Matching is done in JS against the lightweight entity set (entities are the
 * smallest KB table — one row per real-world thing), which keeps the SQL a
 * single bounded scan and the match logic readable + alias-aware. The query is
 * scoped by namespace; an empty token list returns nothing.
 */
export function queryEntitiesByTokens(
  db: DatabaseSync,
  tokens: string[],
  namespace: string = "default",
  limit: number = 20,
): KbEntity[] {
  const normTokens = [...new Set(tokens.map((t) => normalizeBase(t)).filter((t) => t.length > 0))];
  if (normTokens.length === 0) return [];

  const rows = db
    .prepare("SELECT * FROM entities WHERE namespace = ?")
    .all(namespace) as Array<Record<string, unknown>>;

  // Score each entity by how many distinct query tokens it matches (name /
  // alias / canonical_key, all normalized). Higher token coverage ranks first.
  const scored: Array<{ entity: KbEntity; matches: number }> = [];
  for (const row of rows) {
    const entity = rowToEntity(row);
    const haystacks = [
      normalizeBase(entity.name),
      normalizeBase(entity.canonical_key),
      ...entity.aliases.map((a) => normalizeBase(a)),
    ];
    let matches = 0;
    for (const token of normTokens) {
      if (haystacks.some((h) => h.includes(token))) matches += 1;
    }
    if (matches > 0) scored.push({ entity, matches });
  }

  return scored
    .sort((a, b) => b.matches - a.matches)
    .slice(0, limit)
    .map((s) => s.entity);
}

// ============================================================================
// Relations (idempotent by unique edge)
// ============================================================================

/**
 * Upsert a relation edge. Idempotent by UNIQUE(namespace, src, type, dst):
 * re-applying the same edge bumps `support` instead of creating a duplicate.
 */
export function upsertRelation(db: DatabaseSync, rel: KbRelationInput): KbRelation {
  const srcEntityId = requireNonEmpty(rel.srcEntityId, "srcEntityId");
  const type = requireNonEmpty(rel.type, "type");
  const dstEntityId = requireNonEmpty(rel.dstEntityId, "dstEntityId");
  const now = requireNonEmpty(rel.now, "now");
  const namespace = rel.namespace?.trim() || "default";
  const validFrom = rel.validFrom?.trim() || now;
  const sourceEventId = rel.sourceEventId ?? null;

  const id = relationId(namespace, srcEntityId, type, dstEntityId);
  db.prepare(
    `INSERT INTO relations (
       id, src_entity_id, type, dst_entity_id, namespace,
       valid_from, valid_to, support, source_event_id, created_time
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
     ON CONFLICT(namespace, src_entity_id, type, dst_entity_id)
       DO UPDATE SET support = support + 1`,
  ).run(id, srcEntityId, type, dstEntityId, namespace, validFrom, sourceEventId, now);

  const row = db.prepare("SELECT * FROM relations WHERE id = ?").get(id) as Record<string, unknown>;
  return {
    id: row.id as string,
    src_entity_id: row.src_entity_id as string,
    type: row.type as string,
    dst_entity_id: row.dst_entity_id as string,
    namespace: row.namespace as string,
    valid_from: row.valid_from as string,
    valid_to: (row.valid_to as string | null) ?? null,
    support: row.support as number,
    source_event_id: (row.source_event_id as string | null) ?? null,
    created_time: row.created_time as string,
  };
}

/** Stable, unique chunk id for a kb_vec owner + chunk index. */
export function kbChunkId(ownerKind: string, ownerId: string, index: number): string {
  return `${ownerKind}:${ownerId}#${index}`;
}
