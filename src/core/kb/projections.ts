/**
 * KB projections (Phase 5) — DETERMINISTIC rendering of the session-start memory
 * (persona + scene blocks) and an entity "wiki page" FROM the entity-centric KB
 * (entities/facts/events/relations). NO LLM. NO tool-calling. Pure functions.
 *
 * Why deterministic projections replace the old LLM generators:
 *   The old persona-generator / scene-extractor each ran a separate LLM agent at
 *   session boundaries. Those calls were slow, non-deterministic, and could
 *   hallucinate or DROP facts. Now the single KB extraction stage owns ALL
 *   writes; these projections simply RE-RENDER what is already in the KB into the
 *   exact files the start-of-session injection reads (persona.md + scene_blocks/),
 *   so NO hook change is needed and the output is stable across runs.
 *
 * Output-format contracts this module MUST honor (verified against the live
 * dataDir + the injection code that consumes them):
 *   - persona.md   : markdown body, escapeXmlTags-safe, with the scene-navigation
 *                    section appended via generateSceneNavigation() — exactly the
 *                    shape PersonaGenerator produced + <user-persona> injection
 *                    expects.
 *   - scene_blocks/<name>.md : META-delimited block (formatSceneBlock) whose META
 *                    (created/updated/summary/heat) is what syncSceneIndex reads
 *                    to rebuild .metadata/scene_index.json, which in turn feeds
 *                    generateSceneNavigation() / the <scene-navigation> injection.
 *   - entity page  : a standalone markdown "wiki page" (Current facts / History /
 *                    Related [[links]] / Timeline).
 *
 * Immutability: every helper builds NEW strings/arrays/objects; nothing the store
 * returns is mutated.
 */

import type {
  KbEntity,
  KbEvent,
  KbFact,
  KbRelation,
} from "../store/types.js";
import { escapeXmlTags } from "../../utils/sanitize.js";

// ============================================================================
// Store surface (the exact read subset the projections need)
// ============================================================================
//
// Declaring it locally (instead of the full IMemoryStore) keeps the projections
// unit-testable on any object that exposes these KB reads, and documents the
// precise dependency.

export interface ProjectionStore {
  listEntities(namespace?: string, opts?: { types?: string[]; limit?: number }): KbEntity[];
  listRecentEvents(namespace?: string, opts?: { sinceTs?: string; limit?: number }): KbEvent[];
  queryHeadFacts(entityId: string): KbFact[];
  queryAllFacts(entityId: string): KbFact[];
  queryEntityById(id: string): KbEntity | null;
  queryRelationsForEntity(entityId: string): KbRelation[];
  queryEventsForEntity(entityId: string, namespace?: string, limit?: number): KbEvent[];
}

export interface ProjectionOptions {
  /** Namespace to project (default "default"). */
  namespace?: string;
  /** Active locale label used in section headers (default "en"). Facts keep their source language; only headers are localized. */
  locale?: string;
}

// ============================================================================
// Persona allow-list (the ONLY attributes that may surface in persona.md)
// ============================================================================
//
// Blueprint §Owner-decision 3: identity/role, languages, OS+stack+tooling
// preferences, process/working-style rules, active projects, credential
// LOCATIONS (NEVER secret values).
//
// Each entry maps a canonical attribute key → the persona section it renders in.
// Attribute matching is on the snake_case fact.attribute (language-neutral key),
// case-insensitively. Anything NOT in the allow-list is excluded — that is the
// security boundary: a fact like "secret_code" / "api_key" / "password" can never
// leak into the injected persona, because only listed attributes are rendered.

type PersonaSection = "identity" | "languages" | "preferences" | "process" | "credentials";

/**
 * Allow-list of persona attribute keys → section. Exact keys are matched first;
 * a small set of prefixes (below) catches systematic families (e.g. any
 * "*_location" / "*_path" credential-LOCATION attribute) WITHOUT ever matching a
 * secret-value attribute.
 */
const PERSONA_ATTR_SECTIONS: Record<string, PersonaSection> = {
  // ── identity / role ──
  role: "identity",
  occupation: "identity",
  job_title: "identity",
  title: "identity",
  identity: "identity",
  location: "identity",
  timezone: "identity",
  // ── languages (spoken / written) ──
  language: "languages",
  languages: "languages",
  spoken_language: "languages",
  // ── OS + stack + tooling preferences ──
  os: "preferences",
  operating_system: "preferences",
  platform: "preferences",
  stack: "preferences",
  tech_stack: "preferences",
  framework: "preferences",
  tooling: "preferences",
  tool: "preferences",
  editor: "preferences",
  preference: "preferences",
  language_preference: "preferences",
  // ── process / working-style rules ──
  process: "process",
  workflow: "process",
  working_style: "process",
  rule: "process",
  convention: "process",
  communication_style: "process",
};

/**
 * Attribute PREFIXES that are always allow-listed (credential LOCATIONS only).
 * These deliberately match the LOCATION of a secret, never its value:
 *   "credentials_location", "config_path", "secret_file" → allowed (a path)
 * The secret VALUE attributes ("secret_code", "api_key", "password", "token")
 * are NOT listed anywhere and are therefore excluded by construction.
 */
const PERSONA_LOCATION_SUFFIXES = ["_location", "_path", "_file", "_dir"] as const;

/** Snake_case-normalize an attribute for allow-list matching. */
function normAttr(attribute: string): string {
  return attribute.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, "_");
}

/**
 * Classify a fact attribute into a persona section, or null if it is NOT
 * allow-listed (→ excluded from persona). Credential-LOCATION suffixes map to the
 * "credentials" section; everything else must be an exact allow-list key.
 */
function personaSectionFor(attribute: string): PersonaSection | null {
  const key = normAttr(attribute);
  const exact = PERSONA_ATTR_SECTIONS[key];
  if (exact) return exact;
  if (PERSONA_LOCATION_SUFFIXES.some((sfx) => key.endsWith(sfx))) return "credentials";
  return null;
}

// ============================================================================
// projectPersona — person/preference entities + allow-listed HEAD facts → md
// ============================================================================

interface PersonaSectionDef {
  key: PersonaSection;
  heading: string;
}

const PERSONA_SECTION_ORDER: PersonaSectionDef[] = [
  { key: "identity", heading: "Identity & Role" },
  { key: "languages", heading: "Languages" },
  { key: "preferences", heading: "OS, Stack & Tooling Preferences" },
  { key: "process", heading: "Process & Working-Style Rules" },
  { key: "credentials", heading: "Credential Locations" },
];

/** One rendered persona line: "- {entity}: {attribute} → {value}". */
interface PersonaLine {
  section: PersonaSection;
  text: string;
}

/**
 * Build the persona.md BODY (without scene navigation) from the KB.
 *
 * Gathers `person` + `preference` entities and their HEAD facts; keeps ONLY
 * allow-listed attributes; renders a stable, sectioned markdown document. The
 * body is escapeXmlTags-sanitized so it cannot break out of the <user-persona>
 * injection boundary. Scene navigation is appended separately by projectAll().
 *
 * Deterministic: entities are listed in a stable order (already sorted by the
 * store), and within each section lines are sorted alphabetically.
 */
export function projectPersonaBody(store: ProjectionStore, opts: ProjectionOptions = {}): string {
  const namespace = opts.namespace?.trim() || "default";
  const entities = store.listEntities(namespace, { types: ["person", "preference"] });

  const lines: PersonaLine[] = [];
  for (const entity of entities) {
    const heads = store.queryHeadFacts(entity.id);
    for (const fact of heads) {
      const section = personaSectionFor(fact.attribute);
      if (!section) continue; // NOT allow-listed → excluded (secret values land here)
      lines.push({
        section,
        text: `- **${entity.name}** — ${humanizeAttr(fact.attribute)}: ${fact.value}`,
      });
    }
  }

  const bodyParts: string[] = ["# User Profile (deterministic projection from KB)"];
  bodyParts.push(
    "> Generated deterministically from the entity-centric knowledge base. " +
      "Only allow-listed attributes appear here (identity, languages, preferences, " +
      "process rules, active projects, credential locations). Secret values are never projected.",
  );

  for (const def of PERSONA_SECTION_ORDER) {
    const sectionLines = lines
      .filter((l) => l.section === def.key)
      .map((l) => l.text)
      .sort((a, b) => a.localeCompare(b));
    if (sectionLines.length === 0) continue;
    bodyParts.push(`## ${def.heading}`);
    bodyParts.push([...new Set(sectionLines)].join("\n"));
  }

  // Active projects: the project entities themselves (name + any HEAD facts that
  // are allow-listed). Listed as a dedicated section because "active projects" is
  // its own allow-list category in the blueprint.
  const projectEntities = store.listEntities(namespace, { types: ["project"] });
  if (projectEntities.length > 0) {
    const projLines = projectEntities
      .map((p) => `- **${p.name}**`)
      .sort((a, b) => a.localeCompare(b));
    bodyParts.push("## Active Projects");
    bodyParts.push([...new Set(projLines)].join("\n"));
  }

  const body = bodyParts.join("\n\n").trim();
  // Sanitize for safe <user-persona> injection (mirrors PersonaGenerator step 10).
  return escapeXmlTags(body);
}

// ============================================================================
// projectScenes — group recent events into scene blocks + a scene index
// ============================================================================

/** A rendered scene ready to be written to scene_blocks/<filename>. */
export interface ProjectedScene {
  /** Relative filename under scene_blocks/, e.g. "scene-sofia.md". */
  filename: string;
  /** Full file content (META header + markdown body) — write verbatim. */
  content: string;
  /** Index metadata (mirrors what syncSceneIndex would parse from the META). */
  index: {
    filename: string;
    summary: string;
    heat: number;
    created: string;
    updated: string;
  };
}

export interface ProjectScenesResult {
  scenes: ProjectedScene[];
}

const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

/**
 * Group recent events into scenes and render one scene block per scene.
 *
 * Grouping rule (deterministic, NO LLM):
 *   - Each event is assigned to its DOMINANT entity = the first entity id it
 *     references that resolves to an entity (events list their entity ids in a
 *     stable order). Events with no resolvable entity fall into a single
 *     "general activity" scene.
 *   - One scene per dominant entity, containing that entity's recent events in
 *     reverse-chronological order (newest first).
 *
 * Scene META:
 *   - created  = oldest event ts in the scene
 *   - updated  = newest event ts in the scene
 *   - summary  = "{entity name}: {n} event(s)" (deterministic, no LLM)
 *   - heat     = event count (a deterministic salience proxy)
 *
 * `limit` bounds how many recent events are scanned (default 200).
 */
export function projectScenes(
  store: ProjectionStore,
  opts: ProjectionOptions & { limit?: number } = {},
): ProjectScenesResult {
  const namespace = opts.namespace?.trim() || "default";
  const events = store.listRecentEvents(namespace, { limit: opts.limit ?? 200 });

  // entityId → events (preserve newest-first order from listRecentEvents).
  const byEntity = new Map<string, KbEvent[]>();
  const GENERAL = "__general__";

  for (const event of events) {
    const dominant = dominantEntityId(store, event) ?? GENERAL;
    const bucket = byEntity.get(dominant);
    if (bucket) {
      byEntity.set(dominant, [...bucket, event]);
    } else {
      byEntity.set(dominant, [event]);
    }
  }

  const scenes: ProjectedScene[] = [];
  // Stable iteration: sort group keys so the output is deterministic.
  const keys = [...byEntity.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const groupEvents = byEntity.get(key)!;
    const entity = key === GENERAL ? null : store.queryEntityById(key);
    const sceneName = entity ? entity.name : "General Activity";
    const slug = slugify(entity ? `${entity.type}-${entity.name}` : "general-activity");
    const filename = `scene-${slug}.md`;

    // ts ordering: events arrived newest-first; created = min ts, updated = max.
    const tsList = groupEvents.map((e) => e.ts).filter((t) => t.length > 0).sort();
    const created = tsList[0] ?? "";
    const updated = tsList[tsList.length - 1] ?? "";
    const heat = groupEvents.length;
    const summary = `${sceneName}: ${groupEvents.length} event(s)`;

    const content = renderSceneBlock({
      sceneName,
      created,
      updated,
      summary,
      heat,
      events: groupEvents,
    });

    scenes.push({
      filename,
      content,
      index: { filename, summary, heat, created, updated },
    });
  }

  return { scenes };
}

/** Resolve an event's dominant entity id (first referenced id that resolves). */
function dominantEntityId(store: ProjectionStore, event: KbEvent): string | null {
  for (const id of event.entities) {
    const entity = store.queryEntityById(id);
    if (entity) return entity.id;
  }
  return null;
}

/** Render a single scene block file (META header + deterministic markdown body). */
function renderSceneBlock(args: {
  sceneName: string;
  created: string;
  updated: string;
  summary: string;
  heat: number;
  events: KbEvent[];
}): string {
  const meta = [
    META_START,
    `created: ${args.created}`,
    `updated: ${args.updated}`,
    `summary: ${args.summary}`,
    `heat: ${args.heat}`,
    META_END,
  ].join("\n");

  const bodyLines: string[] = [`# ${args.sceneName}`, "", "## Timeline", ""];
  for (const event of args.events) {
    // newest-first (listRecentEvents order). "- [ts] (type) text".
    const ts = event.ts || event.recorded_at || "";
    bodyLines.push(`- [${ts}] (${event.type}) ${oneLine(event.text)}`);
  }

  const body = escapeXmlTags(bodyLines.join("\n").trim());
  return `${meta}\n\n${body}\n`;
}

// ============================================================================
// renderEntityPage — entity "wiki page" markdown
// ============================================================================

/**
 * Render a deterministic entity "wiki page":
 *   # {name} ({type})
 *   ## Current facts      — HEAD facts (superseded_by IS NULL AND valid_to IS NULL)
 *   ## History            — superseded facts (kept forever; audit trail)
 *   ## Related            — [[entity]] links from relations touching this entity
 *   ## Timeline           — events referencing this entity (newest first)
 *
 * Returns "" when the entity id does not resolve (caller decides what to do).
 */
export function renderEntityPage(
  store: ProjectionStore,
  entityId: string,
  opts: { locale?: string; namespace?: string } = {},
): string {
  const entity = store.queryEntityById(entityId);
  if (!entity) return "";
  const namespace = opts.namespace?.trim() || entity.namespace || "default";

  const allFacts = store.queryAllFacts(entity.id);
  const current = allFacts.filter((f) => f.superseded_by === null && f.valid_to === null);
  const history = allFacts.filter((f) => f.superseded_by !== null || f.valid_to !== null);

  const parts: string[] = [];
  parts.push(`# ${entity.name} (${entity.type})`);
  if (entity.aliases.length > 0) {
    parts.push(`*Aliases: ${entity.aliases.join(", ")}*`);
  }

  // ── Current facts ──
  parts.push("## Current facts");
  if (current.length > 0) {
    parts.push(current.map((f) => renderFactLine(f)).join("\n"));
  } else {
    parts.push("_(none)_");
  }

  // ── History (superseded facts) ──
  parts.push("## History");
  if (history.length > 0) {
    parts.push(
      history
        .map((f) => {
          const until = f.valid_to ?? "(superseded)";
          return `- **${humanizeAttr(f.attribute)}**: ${f.value} _(until ${until})_`;
        })
        .join("\n"),
    );
  } else {
    parts.push("_(none)_");
  }

  // ── Related [[entity]] links ──
  parts.push("## Related");
  const relations = store.queryRelationsForEntity(entity.id);
  const relLines = renderRelationLines(store, entity.id, relations);
  parts.push(relLines.length > 0 ? relLines.join("\n") : "_(none)_");

  // ── Timeline (events) ──
  parts.push("## Timeline");
  const events = store.queryEventsForEntity(entity.id, namespace, 50);
  if (events.length > 0) {
    parts.push(
      events
        .map((e) => `- [${e.ts || e.recorded_at}] (${e.type}) ${oneLine(e.text)}`)
        .join("\n"),
    );
  } else {
    parts.push("_(none)_");
  }

  return escapeXmlTags(parts.join("\n\n").trim()) + "\n";
}

/** "- **{attribute}**: {value}" for a HEAD fact (with support/confidence note). */
function renderFactLine(fact: KbFact): string {
  return `- **${humanizeAttr(fact.attribute)}**: ${fact.value}`;
}

/**
 * Render the Related section lines. For every relation touching `entityId`, link
 * to the OTHER endpoint as a [[Name]] wiki-link. Deterministic order is already
 * guaranteed by queryRelationsForEntity.
 */
function renderRelationLines(
  store: ProjectionStore,
  entityId: string,
  relations: KbRelation[],
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const rel of relations) {
    const isSrc = rel.src_entity_id === entityId;
    const otherId = isSrc ? rel.dst_entity_id : rel.src_entity_id;
    const other = store.queryEntityById(otherId);
    const otherName = other ? other.name : otherId;
    // Direction-aware phrasing keeps the edge meaning readable.
    const line = isSrc
      ? `- ${rel.type} → [[${otherName}]]`
      : `- [[${otherName}]] → ${rel.type}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

// ============================================================================
// Small pure helpers
// ============================================================================

/** Collapse a (possibly multi-line) string to a single line for list rendering. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Human-readable attribute label: "tech_stack" → "tech stack". */
function humanizeAttr(attribute: string): string {
  return attribute.replace(/_/g, " ").trim();
}

/**
 * Slugify a display name into a filesystem-safe, deterministic scene filename
 * stem. Keeps unicode letters/digits, replaces everything else with "-", and
 * trims/collapses separators. Falls back to a short hash-free placeholder if the
 * result is empty (e.g. a name made entirely of punctuation).
 */
function slugify(name: string): string {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "scene";
}
