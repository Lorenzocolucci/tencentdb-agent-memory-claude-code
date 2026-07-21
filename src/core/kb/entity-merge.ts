/**
 * Entity merge — Consolidation Cura #2, Phase 2b (the mutation core).
 *
 * WHAT: merge near-duplicate entities (satellites) into a canonical entity,
 * non-destructively: re-key the satellites' facts onto the canonical, fold their
 * names into the canonical's aliases, mark satellites `merged_into = canonical`,
 * then resolve the (canonical, attribute) HEAD collisions the re-key creates by
 * REPLAYING upsertFact's bi-temporal semantics (supersede on different value,
 * corroborate on same value) — the SAME rule Cura #1's backfill uses.
 *
 * WHY: fragmented entities ("OpenAI" × 40) keep the same fact under different
 * entity_ids, so upsertFact never collides them. Merging + re-keying makes the
 * keys collide so the existing engine collapses same-attribute contradictions.
 *
 * SAFETY: satellites are kept (marked merged_into); facts are re-keyed and losers
 * closed (valid_to/superseded_by), never removed; events re-keyed in place. The
 * ONE place rows are DELETEd is relation re-keying (Cura #2c), which has no
 * soft-delete column:
 *   - FOLD: a duplicate of an existing canonical edge is dropped AFTER its support
 *     is added to the survivor → support preserved, row removed.
 *   - SELF-LOOP: an edge that collapses to (canonical→canonical) is dropped and
 *     its support intentionally DISCARDED — a relation to itself is noise, there
 *     is no survivor to carry it. No HEAD fact/event is ever lost this way.
 * One transaction. Deterministic (recency by valid_from→learned_at→id; no LLM).
 * Reversible via a DB backup (the coarse rollback).
 */

import type { DatabaseSync } from "node:sqlite";
import { normalizeFactValue, relationId } from "./kb-queries.js";

/** Whether a table exists (mergeEntities tolerates facts-only fixtures without `events`). */
function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** Idempotently add the additive `merged_into` column to `entities`. */
export function ensureMergedIntoColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "merged_into")) {
    db.prepare("ALTER TABLE entities ADD COLUMN merged_into TEXT").run();
  }
}

export interface CanonicalCandidate {
  id: string;
  importance: number;
  factCount: number;
  createdTime: string;
}

/**
 * Pick the canonical from a cluster: highest importance, then most facts, then
 * earliest created_time, then id (stable). Pure + deterministic.
 */
export function pickCanonical(candidates: CanonicalCandidate[]): string {
  if (candidates.length === 0) throw new Error("pickCanonical: empty cluster");
  return [...candidates].sort(
    (a, b) =>
      b.importance - a.importance ||
      b.factCount - a.factCount ||
      (a.createdTime < b.createdTime ? -1 : a.createdTime > b.createdTime ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  )[0].id;
}

export interface CanonGrouping {
  /** canonical id → its satellite ids (sorted, deterministic). */
  byCanon: Map<string, string[]>;
  /** ids whose merged_into chain hit a cycle → skipped (should never occur). */
  cyclic: string[];
}

/**
 * Group already-merged satellites by their ULTIMATE canonical, following
 * `merged_into` chains. Pure + deterministic (rows sorted by id), cycle-safe
 * (a cyclic chain lists the id in `cyclic` and drops it from grouping). Used by
 * the Cura #2c relation backfill.
 */
export function groupByUltimateCanonical(
  rows: ReadonlyArray<{ id: string; merged_into: string }>,
): CanonGrouping {
  const parent = new Map(rows.map((r) => [r.id, r.merged_into]));
  const ultimate = (id: string): string | null => {
    let cur = id;
    const seen = new Set<string>([id]);
    while (parent.has(cur)) {
      const nxt = parent.get(cur) as string;
      if (seen.has(nxt)) return null; // cycle
      seen.add(nxt);
      cur = nxt;
    }
    return cur;
  };
  const byCanon = new Map<string, string[]>();
  const cyclic: string[] = [];
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sorted) {
    const canon = ultimate(r.id);
    if (canon === null) { cyclic.push(r.id); continue; }
    if (canon === r.id) continue; // an entity that is its own canonical isn't a satellite
    const arr = byCanon.get(canon);
    if (arr) arr.push(r.id);
    else byCanon.set(canon, [r.id]);
  }
  return { byCanon, cyclic };
}

interface FactRow {
  id: string;
  attribute: string;
  value: string;
  confidence: number;
  support: number;
  valid_from: string;
  learned_at: string;
}

function byRecency(a: FactRow, b: FactRow): number {
  if (a.valid_from !== b.valid_from) return a.valid_from < b.valid_from ? -1 : 1;
  if (a.learned_at !== b.learned_at) return a.learned_at < b.learned_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Resolve (entityId, attribute) HEAD collisions by replaying upsertFact
 * Cases B/C over each attribute's competing HEADs. Returns rows closed.
 * Mutates within the caller's transaction. NON-destructive.
 */
export function resolveEntityHeadCollisions(db: DatabaseSync, entityId: string, nowIso: string): number {
  const heads = db
    .prepare(
      "SELECT id, attribute, value, confidence, support, valid_from, learned_at FROM facts " +
        "WHERE entity_id = ? AND superseded_by IS NULL AND valid_to IS NULL",
    )
    .all(entityId) as unknown as FactRow[];

  const byAttr = new Map<string, FactRow[]>();
  for (const f of heads) {
    const arr = byAttr.get(f.attribute);
    if (arr) arr.push(f);
    else byAttr.set(f.attribute, [f]);
  }

  const close = db.prepare("UPDATE facts SET valid_to = ?, superseded_by = ?, superseded_at = ? WHERE id = ?");
  const fold = db.prepare("UPDATE facts SET support = ?, confidence = ?, valid_from = ? WHERE id = ?");
  let closed = 0;

  for (const members of byAttr.values()) {
    if (members.length < 2) continue;
    members.sort(byRecency);
    let head = { ...members[0], folded: false };
    const flush = () => {
      if (head.folded) fold.run(head.support, head.confidence, head.valid_from, head.id);
    };
    for (let i = 1; i < members.length; i++) {
      const m = members[i];
      if (normalizeFactValue(head.value) === normalizeFactValue(m.value)) {
        head.support += m.support;
        head.confidence = Math.max(head.confidence, m.confidence);
        if (m.valid_from < head.valid_from) head.valid_from = m.valid_from;
        head.folded = true;
        close.run(m.valid_from, head.id, nowIso, m.id);
        closed++;
      } else {
        flush();
        close.run(m.valid_from, m.id, nowIso, head.id);
        closed++;
        head = { ...m, folded: false };
      }
    }
    flush();
  }
  return closed;
}

export interface RelationRekeyResult {
  /** Satellite edges re-pointed onto the canonical (no conflicting canonical edge). */
  relationsRekeyed: number;
  /** Satellite edges whose (ns,src,type,dst) already existed on the canonical → support folded, duplicate dropped. */
  relationsFolded: number;
  /** Satellite edges that became a self-loop (src==dst==canonical) after re-key → dropped (meaningless). */
  relationsSelfLoopsDropped: number;
}

/**
 * Re-key relations from satellites onto the canonical, conflict-safe, within the
 * caller's transaction. Cura #2c.
 *
 * WHY: mergeEntities re-keys facts + events but relations (src/dst_entity_id)
 * kept pointing at the merged-away satellites, so queryRelationsForEntity(canon)
 * missed them — the canonical's "Related [[entity]]" links + relation-based recall
 * were incomplete for exactly the entity that absorbed the duplicates.
 *
 * SEMANTICS (deterministic, sequential):
 *   - map each touched edge's src/dst: satellite → canonical.
 *   - src==dst after mapping → self-loop → DROP (a relation to itself is noise).
 *   - target (ns,src',type,dst') already exists (canonical had that edge, or an
 *     earlier satellite already produced it) → FOLD support into the survivor,
 *     DROP this duplicate (support is preserved — "non-destructive in spirit").
 *   - otherwise → re-point this row (and recompute its deterministic id).
 */
export function rekeyRelationsOnMerge(
  db: DatabaseSync,
  canonicalId: string,
  satelliteIds: readonly string[],
): RelationRekeyResult {
  const out: RelationRekeyResult = { relationsRekeyed: 0, relationsFolded: 0, relationsSelfLoopsDropped: 0 };
  if (!tableExists(db, "relations") || satelliteIds.length === 0) return out;

  const satSet = new Set(satelliteIds);
  interface RelRow { id: string; src_entity_id: string; type: string; dst_entity_id: string; namespace: string; support: number }

  // Gather every edge touching a satellite (as src OR dst), deduped by id.
  const touched = new Map<string, RelRow>();
  const sel = db.prepare(
    "SELECT id, src_entity_id, type, dst_entity_id, namespace, support FROM relations WHERE src_entity_id = ? OR dst_entity_id = ?",
  );
  for (const sid of satelliteIds) {
    for (const r of sel.all(sid, sid) as unknown as RelRow[]) touched.set(r.id, r);
  }

  const findExisting = db.prepare(
    "SELECT id FROM relations WHERE namespace = ? AND src_entity_id = ? AND type = ? AND dst_entity_id = ? AND id != ?",
  );
  const foldSupport = db.prepare("UPDATE relations SET support = support + ? WHERE id = ?");
  const del = db.prepare("DELETE FROM relations WHERE id = ?");
  const move = db.prepare("UPDATE relations SET id = ?, src_entity_id = ?, dst_entity_id = ? WHERE id = ?");

  for (const r of touched.values()) {
    const src2 = satSet.has(r.src_entity_id) ? canonicalId : r.src_entity_id;
    const dst2 = satSet.has(r.dst_entity_id) ? canonicalId : r.dst_entity_id;
    if (src2 === dst2) {
      del.run(r.id);
      out.relationsSelfLoopsDropped++;
      continue;
    }
    const existing = findExisting.get(r.namespace, src2, r.type, dst2, r.id) as { id: string } | undefined;
    if (existing) {
      // Fold only `support` (the quantity spreading-activation reads). The dropped
      // row's provenance (valid_from/source_event_id) and the unused `weight`
      // column are intentionally not merged — not consumed by recall today.
      foldSupport.run(r.support, existing.id);
      del.run(r.id);
      out.relationsFolded++;
    } else {
      // No conflicting edge → re-point + recompute the deterministic id so future
      // upsertRelation(canonical,type,dst) resolves to this same row.
      move.run(relationId(r.namespace, src2, r.type, dst2), src2, dst2, r.id);
      out.relationsRekeyed++;
    }
  }
  return out;
}

export interface MergePlan {
  canonicalId: string;
  satelliteIds: string[];
}

export interface MergeResult {
  canonicalId: string;
  satellitesMerged: number;
  factsRekeyed: number;
  headCollisionsResolved: number;
  aliasesAdded: number;
  /** Distinct events whose entities_json referenced a satellite → re-keyed to canonical. */
  eventsRekeyed: number;
  /** Satellite relation edges re-pointed onto the canonical (Cura #2c). */
  relationsRekeyed: number;
  /** Satellite relation edges whose target already existed → support folded, duplicate dropped. */
  relationsFolded: number;
  /** Satellite relation edges that became self-loops after re-key → dropped. */
  relationsSelfLoopsDropped: number;
}

/**
 * Merge satellites into the canonical entity, in one transaction. Non-destructive.
 * Preconditions: all ids exist, same namespace+type as canonical, satellites not
 * already merged. Throws (and rolls back) on violation — never partial-writes.
 */
export function mergeEntities(db: DatabaseSync, plan: MergePlan, nowIso: string): MergeResult {
  ensureMergedIntoColumn(db);
  const { canonicalId, satelliteIds } = plan;
  const satellites = satelliteIds.filter((id) => id !== canonicalId);

  const canon = db.prepare("SELECT id, type, namespace, aliases_json, name FROM entities WHERE id = ?").get(canonicalId) as
    | { id: string; type: string; namespace: string; aliases_json: string; name: string }
    | undefined;
  if (!canon) throw new Error(`mergeEntities: canonical ${canonicalId} not found`);

  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const aliasSet = new Set<string>(JSON.parse(canon.aliases_json || "[]") as string[]);
    const before = aliasSet.size;
    let factsRekeyed = 0;

    const rekey = db.prepare("UPDATE facts SET entity_id = ? WHERE entity_id = ?");
    const markMerged = db.prepare("UPDATE entities SET merged_into = ?, updated_time = ? WHERE id = ?");

    for (const sid of satellites) {
      const s = db.prepare("SELECT id, type, namespace, name, aliases_json, merged_into FROM entities WHERE id = ?").get(sid) as
        | { id: string; type: string; namespace: string; name: string; aliases_json: string; merged_into: string | null }
        | undefined;
      if (!s) throw new Error(`mergeEntities: satellite ${sid} not found`);
      if (s.type !== canon.type) throw new Error(`mergeEntities: type mismatch ${sid} (${s.type} ≠ ${canon.type})`);
      if (s.namespace !== canon.namespace) throw new Error(`mergeEntities: namespace mismatch ${sid}`);
      if (s.merged_into) throw new Error(`mergeEntities: ${sid} already merged into ${s.merged_into}`);

      // Fold the satellite's display name + aliases into the canonical.
      aliasSet.add(s.name);
      for (const a of JSON.parse(s.aliases_json || "[]") as string[]) aliasSet.add(a);

      const info = rekey.run(canonicalId, sid);
      factsRekeyed += Number(info.changes ?? 0);
      markMerged.run(canonicalId, nowIso, sid);
    }

    // Do not keep the canonical's own name as an alias.
    aliasSet.delete(canon.name);
    db.prepare("UPDATE entities SET aliases_json = ?, updated_time = ? WHERE id = ?").run(
      JSON.stringify([...aliasSet]),
      nowIso,
      canonicalId,
    );

    // Re-key events that reference a satellite id in entities_json → canonical
    // (dedup), so the canonical's timeline + associative (Hebbian) recall stay
    // complete. Facts alone aren't enough: events reference entities too.
    // Tolerant of a DB without an `events` table (facts-only fixtures).
    let eventsRekeyed = 0;
    if (tableExists(db, "events")) {
      const satSet = new Set(satellites);
      const selEvents = db.prepare("SELECT id, entities_json FROM events WHERE entities_json LIKE ?");
      const updEvent = db.prepare("UPDATE events SET entities_json = ? WHERE id = ?");
      const affected = new Map<string, string[]>();
      for (const sid of satellites) {
        for (const row of selEvents.all(`%${sid}%`) as Array<{ id: string; entities_json: string }>) {
          if (affected.has(row.id)) continue;
          let arr: string[];
          try {
            arr = JSON.parse(row.entities_json || "[]") as string[];
          } catch {
            continue;
          }
          if (!arr.some((e) => satSet.has(e))) continue; // LIKE substring false positive
          affected.set(row.id, arr);
        }
      }
      for (const [eid, arr] of affected) {
        const next = [...new Set(arr.map((e) => (satSet.has(e) ? canonicalId : e)))];
        updEvent.run(JSON.stringify(next), eid);
      }
      eventsRekeyed = affected.size;
    }

    // Re-key relations (Cura #2c): satellite edges → canonical, conflict-safe.
    const rel = rekeyRelationsOnMerge(db, canonicalId, satellites);

    const headCollisionsResolved = resolveEntityHeadCollisions(db, canonicalId, nowIso);

    db.prepare("COMMIT").run();
    return {
      canonicalId,
      satellitesMerged: satellites.length,
      factsRekeyed,
      headCollisionsResolved,
      aliasesAdded: aliasSet.size - before,
      eventsRekeyed,
      relationsRekeyed: rel.relationsRekeyed,
      relationsFolded: rel.relationsFolded,
      relationsSelfLoopsDropped: rel.relationsSelfLoopsDropped,
    };
  } catch (err) {
    try {
      db.prepare("ROLLBACK").run();
    } catch {
      /* keep original err */
    }
    throw err;
  }
}
