/**
 * KbDelta extraction schema (Phase 2).
 *
 * Validates the single JSON object the KB extractor LLM returns per window.
 * The contract (see docs/PHASE2_KB_EXTRACTION_SPEC.md):
 *   {
 *     language,
 *     entities: [{ ref, type, name, aliases, language }],
 *     facts:    [{ entity_ref, attribute, value, valid_from?, confidence, source_event_ref? }],
 *     events:   [{ ref, type, ts, text, entity_refs, source_message_ids }],
 *     relations:[{ src_ref, type, dst_ref }],
 *   }
 *
 * `ref` / `entity_ref` / `src_ref` / `dst_ref` / `source_event_ref` are
 * model-LOCAL labels resolved INSIDE this delta — never DB ids. The
 * `.superRefine` enforces referential integrity (no dangling refs) and unique
 * ref labels, so kb-writer.applyKbDelta can trust the structure and never has
 * to defend against a dangling reference.
 *
 * `parseKbDelta` NEVER throws: it returns a tagged result so the runner can
 * fail-closed (hold the cursor) on schema-invalid output exactly like the L1
 * runner does today.
 */

import { z } from "zod";

// ============================
// Enums (the canonical vocabularies — always English)
// ============================

export const KB_ENTITY_TYPES = [
  "person",
  "project",
  "library",
  "file",
  "decision",
  "bug",
  "preference",
  "concept",
] as const;

export const KB_EVENT_TYPES = [
  "decision",
  "bug",
  "fix",
  "config_change",
  "observation",
  "preference_stated",
  "task",
  "result",
] as const;

export const KB_RELATION_TYPES = [
  "uses",
  "depends-on",
  "fixed-by",
  "caused",
  "supersedes",
  "recurs-in",
  "decided-in",
  "related-to", // generic catch-all so an out-of-vocab edge is COERCED, never dropped
] as const;

/** Fallback relation type for out-of-vocabulary values (coerce, never drop). */
const RELATION_TYPE_FALLBACK = "related-to";

// ============================
// Field-level limits (mirror the kb-queries DB constraints + the spec caps)
// ============================

/** attribute keys are language-neutral English snake_case. */
const SNAKE_CASE_ATTRIBUTE = /^[a-z][a-z0-9_]*$/;

const NAME_MAX = 200;
const ALIAS_MAX = 200;
const ALIASES_MAX = 20;
const VALUE_MAX = 1000;
const ATTRIBUTE_MAX = 64;
const TEXT_MAX = 1000;
const ENTITY_REFS_MAX = 20;
const SOURCE_MESSAGE_IDS_MAX = 20;
const ENTITIES_MAX = 50;
const FACTS_MAX = 100;
const EVENTS_MAX = 100;
const RELATIONS_MAX = 50;

// ============================
// Per-item schemas
// ============================

const RefSchema = z.string().min(1).max(64);

const EntitySchema = z.object({
  ref: RefSchema,
  type: z.enum(KB_ENTITY_TYPES),
  name: z.string().min(1).max(NAME_MAX),
  aliases: z.array(z.string().min(1).max(ALIAS_MAX)).max(ALIASES_MAX).default([]),
  language: z.string().min(2).max(16).default("und"),
});

const FactSchema = z.object({
  entity_ref: RefSchema,
  attribute: z
    .string()
    .max(ATTRIBUTE_MAX)
    .regex(SNAKE_CASE_ATTRIBUTE, "attribute must be language-neutral English snake_case"),
  value: z.string().min(1).max(VALUE_MAX),
  valid_from: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).default(0.7),
  source_event_ref: RefSchema.optional(),
});

const EventSchema = z.object({
  ref: RefSchema,
  type: z.enum(KB_EVENT_TYPES),
  ts: z.string().min(1),
  text: z.string().min(1).max(TEXT_MAX),
  entity_refs: z.array(RefSchema).max(ENTITY_REFS_MAX).default([]),
  source_message_ids: z.array(z.string().min(1)).max(SOURCE_MESSAGE_IDS_MAX).default([]),
});

const RelationSchema = z.object({
  src_ref: RefSchema,
  type: z.enum(KB_RELATION_TYPES),
  dst_ref: RefSchema,
});

// ============================
// Top-level KbDelta schema
// ============================

export const KbDeltaSchema = z
  .object({
    language: z.string().min(2).max(16).default("und"),
    entities: z.array(EntitySchema).max(ENTITIES_MAX).default([]),
    facts: z.array(FactSchema).max(FACTS_MAX).default([]),
    events: z.array(EventSchema).max(EVENTS_MAX).default([]),
    relations: z.array(RelationSchema).max(RELATIONS_MAX).default([]),
  })
  .superRefine((delta, ctx) => {
    // ── No duplicate ENTITY ref labels ──
    const entityRefs = new Set<string>();
    delta.entities.forEach((e, i) => {
      if (entityRefs.has(e.ref)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate entity ref "${e.ref}"`,
          path: ["entities", i, "ref"],
        });
      }
      entityRefs.add(e.ref);
    });

    // ── No duplicate EVENT ref labels ──
    const eventRefs = new Set<string>();
    delta.events.forEach((ev, i) => {
      if (eventRefs.has(ev.ref)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate event ref "${ev.ref}"`,
          path: ["events", i, "ref"],
        });
      }
      eventRefs.add(ev.ref);
    });

    // ── Referential integrity: every entity reference resolves ──
    delta.facts.forEach((f, i) => {
      if (!entityRefs.has(f.entity_ref)) {
        ctx.addIssue({
          code: "custom",
          message: `fact references unknown entity ref "${f.entity_ref}"`,
          path: ["facts", i, "entity_ref"],
        });
      }
      if (f.source_event_ref !== undefined && !eventRefs.has(f.source_event_ref)) {
        ctx.addIssue({
          code: "custom",
          message: `fact references unknown event ref "${f.source_event_ref}"`,
          path: ["facts", i, "source_event_ref"],
        });
      }
    });

    delta.events.forEach((ev, i) => {
      ev.entity_refs.forEach((r, j) => {
        if (!entityRefs.has(r)) {
          ctx.addIssue({
            code: "custom",
            message: `event references unknown entity ref "${r}"`,
            path: ["events", i, "entity_refs", j],
          });
        }
      });
    });

    delta.relations.forEach((rel, i) => {
      if (!entityRefs.has(rel.src_ref)) {
        ctx.addIssue({
          code: "custom",
          message: `relation references unknown entity ref "${rel.src_ref}"`,
          path: ["relations", i, "src_ref"],
        });
      }
      if (!entityRefs.has(rel.dst_ref)) {
        ctx.addIssue({
          code: "custom",
          message: `relation references unknown entity ref "${rel.dst_ref}"`,
          path: ["relations", i, "dst_ref"],
        });
      }
    });
  });

// ============================
// Inferred types
// ============================

export type KbDelta = z.infer<typeof KbDeltaSchema>;
export type KbDeltaEntity = z.infer<typeof EntitySchema>;
export type KbDeltaFact = z.infer<typeof FactSchema>;
export type KbDeltaEvent = z.infer<typeof EventSchema>;
export type KbDeltaRelation = z.infer<typeof RelationSchema>;

// ============================
// Vocabulary coercion (resilience — never lose a window to vocab drift)
// ============================

const ENTITY_TYPE_SET: ReadonlySet<string> = new Set(KB_ENTITY_TYPES);
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(KB_EVENT_TYPES);
const RELATION_TYPE_SET: ReadonlySet<string> = new Set(KB_RELATION_TYPES);

/** Fallback entity type for out-of-vocabulary values (codes, secrets, ids, …). */
const ENTITY_TYPE_FALLBACK = "concept";
/** Fallback event type for out-of-vocabulary values. */
const EVENT_TYPE_FALLBACK = "observation";

/**
 * Coerce a free-form attribute key to language-neutral English snake_case so a
 * model that emits camelCase / spaces / punctuation ("preferredLanguage",
 * "IBAN delivery") does not fail the whole window. Mirrors SNAKE_CASE_ATTRIBUTE.
 */
function coerceAttribute(raw: unknown): string {
  if (typeof raw !== "string") return "value";
  let s = raw
    .normalize("NFKC")
    // camelCase / PascalCase → snake (insert _ at lower→Upper boundaries)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    // any run of non [a-z0-9] → single _
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (s.length === 0) return "value";
  // must start with a letter (regex anchor [a-z]); prefix otherwise.
  if (!/^[a-z]/.test(s)) s = `v_${s}`;
  return s.slice(0, ATTRIBUTE_MAX);
}

/**
 * Normalize a raw (JSON-parsed) KbDelta-shaped object BEFORE strict validation.
 *
 * RESILIENCE PRINCIPLE: a single out-of-vocabulary enum (the model loves
 * `type:"secret_code"`) must NEVER nuke an entire window's memory (the recurring
 * total-loss bug). Here we coerce the high-churn, low-risk vocabulary fields:
 *   - entity.type  ∉ enum → "concept"
 *   - event.type   ∉ enum → "observation"
 *   - fact.attribute       → snake_case
 *   - relation.type ∉ enum → DROP that relation (no safe generic fallback)
 * Structural integrity (refs, required fields, caps) is still enforced strictly
 * by KbDeltaSchema afterwards. Pure/immutable — returns a new object.
 */
export function normalizeRawKbDelta(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;

  const mapArray = <T>(v: unknown, fn: (item: Record<string, unknown>) => T): unknown =>
    Array.isArray(v)
      ? v.map((item) =>
          item !== null && typeof item === "object" && !Array.isArray(item)
            ? fn(item as Record<string, unknown>)
            : item,
        )
      : v;

  const entities = mapArray(obj.entities, (e) => {
    const t = e.type;
    return typeof t === "string" && ENTITY_TYPE_SET.has(t)
      ? e
      : { ...e, type: ENTITY_TYPE_FALLBACK };
  });

  const events = mapArray(obj.events, (ev) => {
    const t = ev.type;
    return typeof t === "string" && EVENT_TYPE_SET.has(t)
      ? ev
      : { ...ev, type: EVENT_TYPE_FALLBACK };
  });

  const facts = mapArray(obj.facts, (f) =>
    "attribute" in f ? { ...f, attribute: coerceAttribute(f.attribute) } : f,
  );

  // Relations need two passes:
  //  (1) COERCE an out-of-vocabulary edge type → generic "related-to" (keep the
  //      link, never drop it for an unknown type).
  //  (2) Relations may ONLY connect ENTITY refs. Kimi sometimes targets an EVENT
  //      ref (ev1) or a ref it never defined — that fails referential integrity
  //      and would REJECT the whole window. DROP such dangling edges here so the
  //      window survives with its entities/facts/events intact.
  const entityRefs = new Set<string>();
  if (Array.isArray(entities)) {
    for (const e of entities) {
      const ref = e !== null && typeof e === "object" ? (e as Record<string, unknown>).ref : undefined;
      if (typeof ref === "string") entityRefs.add(ref);
    }
  }
  const relations = Array.isArray(obj.relations)
    ? obj.relations
        .map((r) =>
          r !== null && typeof r === "object" && !Array.isArray(r)
            ? RELATION_TYPE_SET.has((r as Record<string, unknown>).type as string)
              ? r
              : { ...(r as Record<string, unknown>), type: RELATION_TYPE_FALLBACK }
            : r,
        )
        .filter((r) => {
          if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
          const rr = r as Record<string, unknown>;
          return (
            typeof rr.src_ref === "string" &&
            typeof rr.dst_ref === "string" &&
            entityRefs.has(rr.src_ref) &&
            entityRefs.has(rr.dst_ref)
          );
        })
    : obj.relations;

  return { ...obj, entities, events, facts, relations };
}

// ============================
// Parse result (never throws)
// ============================

export type ParseKbDeltaResult =
  | { ok: true; delta: KbDelta }
  | { ok: false; error: string };

/**
 * Validate a raw (already-JSON-parsed) object against KbDeltaSchema.
 *
 * NEVER throws — returns a tagged result. On failure, `error` is a compact,
 * single-line summary of the FIRST few Zod issues (path + message), suitable
 * for a fail-closed log line. The runner treats `ok:false` as a hard failure
 * and HOLDS the cursor; an empty-but-valid delta is `ok:true`.
 *
 * Raw input is first passed through `normalizeRawKbDelta` so out-of-vocabulary
 * enums are coerced (never a total-loss window) before strict structural checks.
 */
export function parseKbDelta(raw: unknown): ParseKbDeltaResult {
  const result = KbDeltaSchema.safeParse(normalizeRawKbDelta(raw));
  if (result.success) {
    return { ok: true, delta: result.data };
  }

  const issues = result.error.issues
    .slice(0, 5)
    .map((iss) => {
      const path = iss.path.length > 0 ? iss.path.join(".") : "(root)";
      return `${path}: ${iss.message}`;
    })
    .join("; ");
  const extra = result.error.issues.length > 5 ? ` (+${result.error.issues.length - 5} more)` : "";
  return { ok: false, error: `KbDelta validation failed — ${issues}${extra}` };
}
