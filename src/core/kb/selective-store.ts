/**
 * Store-backed pieces of the Phase-3 selective recall: who a memory belongs to
 * (project scoping), which owners the ledger proves are noise, and the project-scoped,
 * converged, event-first associative expansion.
 *
 * Plain functions over a `DatabaseSync` (the VectorStore delegates here) so they are
 * testable against an in-memory database. Every function is best-effort at its call
 * site: recall treats a throw as "no answer", never as a failed turn.
 */

import type { DatabaseSync } from "node:sqlite";
import type { KbEntity, KbEvent, KbFact } from "../store/types.js";
import {
  queryEntityById,
  queryEventsForEntity,
  queryHeadFacts,
  queryRelationsForEntity,
} from "./kb-queries.js";
import { isNoiseAttribute, spreadActivation, type WeightedNeighbor } from "./spreading-activation.js";
import { matchedTokenCount, ownerKey, projectsConflict, withSubject } from "./selective-recall.js";

/** Entity types that are about the USER, not a project: shown in every project. */
const USER_LEVEL_ENTITY_TYPES = new Set(["person", "preference"]);

export interface OwnerProjectInfo {
  /** The project the memory belongs to; "" when unknown (chat imports, untagged). */
  project: string;
  /** User-level memory (a person or preference): never project-filtered. */
  userLevel: boolean;
}

const IN_CHUNK = 400;

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** The project of a row: its own tag if any, else the session registry, else "" (user-level). */
function pickProject(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) if (typeof c === "string" && c.trim() !== "") return c.trim();
  return "";
}

/**
 * Project of each owner, batched. An event belongs to its own `project` tag or, when
 * that is empty/not real, to the project its session is registered under. A fact
 * belongs to the project of the event it was extracted from, else its entity's tag.
 * Keys of the result are `kind:id`.
 */
export function ownerProjects(
  db: DatabaseSync,
  owners: ReadonlyArray<{ owner_id: string; owner_kind: string }>,
): Map<string, OwnerProjectInfo> {
  const out = new Map<string, OwnerProjectInfo>();
  const events = owners.filter((o) => o.owner_kind === "event").map((o) => o.owner_id);
  const facts = owners.filter((o) => o.owner_kind === "fact").map((o) => o.owner_id);

  for (const ids of chunks(events, IN_CHUNK)) {
    const rows = db
      .prepare(
        `SELECT e.id AS id, e.project AS p, sp.project AS sp
           FROM events e LEFT JOIN session_projects sp ON sp.session_key = e.session_key
          WHERE e.id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as Array<{ id: string; p: string | null; sp: string | null }>;
    for (const r of rows) {
      out.set(ownerKey("event", r.id), { project: pickProject(r.p, r.sp), userLevel: false });
    }
  }
  for (const ids of chunks(facts, IN_CHUNK)) {
    const rows = db
      .prepare(
        `SELECT f.id AS id, ev.project AS p, sp.project AS sp, en.project AS ep, en.type AS et
           FROM facts f
           LEFT JOIN events ev ON ev.id = f.source_event_id
           LEFT JOIN session_projects sp ON sp.session_key = ev.session_key
           LEFT JOIN entities en ON en.id = f.entity_id
          WHERE f.id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as Array<{ id: string; p: string | null; sp: string | null; ep: string | null; et: string | null }>;
    for (const r of rows) {
      out.set(ownerKey("fact", r.id), {
        project: pickProject(r.p, r.sp, r.ep),
        userLevel: USER_LEVEL_ENTITY_TYPES.has(r.et ?? ""),
      });
    }
  }
  return out;
}

/** Keys (`kind:id`) of the owners that belong provably to ANOTHER project than `project`. */
export function otherProjectKeys(
  db: DatabaseSync,
  owners: ReadonlyArray<{ owner_id: string; owner_kind: string }>,
  project: string | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!project || project.trim() === "" || owners.length === 0) return out;
  for (const [key, info] of ownerProjects(db, owners)) {
    if (!info.userLevel && projectsConflict(info.project, project)) out.add(key);
  }
  return out;
}

/**
 * Owners injected at least `minInjections` times, judged, judgeable — and NEVER used.
 * Silent-turn markers (owner_kind = 'turn') are not memories and never counted.
 */
export function chronicNoiseKeys(db: DatabaseSync, minInjections: number): string[] {
  const rows = db
    .prepare(
      `SELECT owner_kind AS k, owner_id AS id
         FROM recall_ledger
        WHERE judged = 1 AND unjudgeable = 0 AND owner_kind != 'turn'
        GROUP BY owner_kind, owner_id
       HAVING COUNT(*) >= ? AND SUM(used) = 0`,
    )
    .all(Math.max(1, Math.floor(minInjections))) as Array<{ k: string; id: string }>;
  return rows.map((r) => ownerKey(r.k, r.id));
}

// ============================================================================
// Selective associative expansion
// ============================================================================

export interface SelectiveExpandOptions {
  hops?: number;
  maxNodes?: number;
  namespace?: string;
  /** Current project: other projects' entities, relations and memories are excluded. */
  project?: string;
  /** Distinctive prompt tokens, used to pick the fact that is about the prompt. */
  queryTokens?: readonly string[];
  /** Entities with more head facts than this are context, not seeds. */
  hubFactThreshold: number;
}

export interface ExpandedMemory {
  owner_id: string;
  owner_kind: "fact" | "event";
  text: string;
  entity_id: string;
  activation: number;
  /** Distinct seeds this entity was reached from. */
  seedCount: number;
}

interface EntityInfo {
  entity: KbEntity;
  usable: boolean;
}

const MAX_SEEDS = 12;
const EVENTS_SCANNED_PER_ENTITY = 6;

export function selectiveAssociativeExpand(
  db: DatabaseSync,
  seedIds: readonly string[],
  opts: SelectiveExpandOptions,
): ExpandedMemory[] {
  const namespace = opts.namespace ?? "default";
  const infoMemo = new Map<string, EntityInfo | null>();
  const info = (id: string): EntityInfo | null => {
    if (infoMemo.has(id)) return infoMemo.get(id) ?? null;
    const entity = queryEntityById(db, id);
    let result: EntityInfo | null = null;
    if (entity) {
      const userLevel = USER_LEVEL_ENTITY_TYPES.has(entity.type);
      const sameProject = userLevel || !projectsConflict(entity.project, opts.project);
      result = { entity, usable: sameProject && !isHub(db, entity.id, opts.hubFactThreshold) };
    }
    infoMemo.set(id, result);
    return result;
  };

  const adjacency = new Map<string, WeightedNeighbor[]>();
  const neighborsOf = (id: string): WeightedNeighbor[] => {
    let n = adjacency.get(id);
    if (!n) {
      n = queryRelationsForEntity(db, id)
        .filter((r) => r.valid_to == null && r.namespace === namespace)
        .map((r) => ({ id: r.src_entity_id === id ? r.dst_entity_id : r.src_entity_id, weight: r.support > 0 ? r.support : 1 }))
        .filter((x) => x.id && x.id !== id && info(x.id)?.usable === true); // same-project, non-hub edges only
      adjacency.set(id, n);
    }
    return n;
  };

  const seeds = [...new Set(seedIds.filter(Boolean))].filter((id) => info(id)?.usable).slice(0, MAX_SEEDS);
  if (seeds.length === 0) return [];
  const seedSet = new Set(seeds);

  const reached = new Map<string, { activation: number; seeds: Set<string> }>();
  for (const seed of seeds) {
    const spread = spreadActivation([{ id: seed, activation: 1 }], neighborsOf, {
      hops: opts.hops ?? 2,
      maxNodes: 24,
    });
    for (const [node, activation] of spread) {
      if (seedSet.has(node)) continue; // seeds are already represented by the query hits
      const cur = reached.get(node) ?? { activation: 0, seeds: new Set<string>() };
      cur.activation += activation;
      cur.seeds.add(seed);
      reached.set(node, cur);
    }
  }

  const ranked = [...reached.entries()].sort((a, b) => b[1].activation - a[1].activation).slice(0, (opts.maxNodes ?? 6) * 2);
  const out: ExpandedMemory[] = [];
  for (const [entityId, r] of ranked) {
    const entity = info(entityId)?.entity;
    if (!entity) continue;
    const rep = representativeMemory(db, entity, namespace, opts);
    if (rep) out.push({ ...rep, entity_id: entityId, activation: r.activation, seedCount: r.seeds.size });
  }
  return out;
}

const hubMemo = new WeakMap<DatabaseSync, Map<string, number>>();

/** Head-fact count above `threshold`: the entity is a hub (a whole project, the user, …). */
function isHub(db: DatabaseSync, entityId: string, threshold: number): boolean {
  let memo = hubMemo.get(db);
  if (!memo) {
    memo = new Map();
    hubMemo.set(db, memo);
  }
  let n = memo.get(entityId);
  if (n === undefined) {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM facts WHERE entity_id = ? AND superseded_by IS NULL AND valid_to IS NULL")
      .get(entityId) as { n: number };
    n = row.n;
    if (memo.size > 5000) memo.clear(); // bounded; counts drift slowly, a rebuild is cheap
    memo.set(entityId, n);
  }
  return n > threshold;
}

/**
 * The ONE memory an associatively reached entity contributes: its latest event of the
 * current project (events are 43.8% used when injected, bare facts 2.7%), else its
 * best head fact — ranked by the prompt, not alphabetically — rendered with the subject.
 */
function representativeMemory(
  db: DatabaseSync,
  entity: KbEntity,
  namespace: string,
  opts: SelectiveExpandOptions,
): Omit<ExpandedMemory, "entity_id" | "activation" | "seedCount"> | null {
  const events = queryEventsForEntity(db, entity.id, namespace, EVENTS_SCANNED_PER_ENTITY);
  const event = events.find((e) => !projectsConflict(eventProject(db, e), opts.project));
  if (event) {
    return { owner_id: event.id, owner_kind: "event", text: withSubject(entity.name, event.text) };
  }
  const fact = rankFactsForQuery(
    queryHeadFacts(db, entity.id).filter((f) => !isNoiseAttribute(f.attribute)),
    entity,
    opts.queryTokens ?? [],
  )[0];
  if (!fact) return null;
  return { owner_id: fact.id, owner_kind: "fact", text: `${entity.name} — ${fact.attribute}: ${fact.value}` };
}

/** Effective project of an event: its own tag, else its session's registered project. */
export function eventProject(db: DatabaseSync, e: Pick<KbEvent, "project" | "session_key">): string {
  if (e.project && e.project.trim() !== "") return e.project.trim();
  const row = db.prepare("SELECT project FROM session_projects WHERE session_key = ?").get(e.session_key) as
    | { project?: string }
    | undefined;
  return pickProject(row?.project);
}

/**
 * Head facts of one entity ordered by how much they are about the prompt (distinctive
 * tokens found in "attribute value"), then confidence, then recency — never A→Z.
 */
export function rankFactsForQuery(facts: readonly KbFact[], entity: Pick<KbEntity, "name">, tokens: readonly string[]): KbFact[] {
  return facts
    .map((f) => ({ f, overlap: matchedTokenCount(tokens, `${entity.name} ${f.attribute} ${f.value}`) }))
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        (b.f.confidence ?? 0) - (a.f.confidence ?? 0) ||
        (b.f.valid_from ?? "").localeCompare(a.f.valid_from ?? ""),
    )
    .map((x) => x.f);
}
