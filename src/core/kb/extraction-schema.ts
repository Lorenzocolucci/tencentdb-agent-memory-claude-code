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
] as const;

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
 */
export function parseKbDelta(raw: unknown): ParseKbDeltaResult {
  const result = KbDeltaSchema.safeParse(raw);
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
