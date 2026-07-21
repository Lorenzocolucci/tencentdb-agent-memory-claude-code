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
 * SAFETY: never DELETEs. Satellites are kept (marked merged_into); facts are
 * re-keyed and losers closed (valid_to/superseded_by), never removed. One
 * transaction. Deterministic (recency by valid_from→learned_at→id; no LLM).
 * Reversible: the satellite rows + closed facts remain; a DB backup is the
 * coarse rollback.
 */

import type { DatabaseSync } from "node:sqlite";
import { normalizeFactValue } from "./kb-queries.js";

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

    const headCollisionsResolved = resolveEntityHeadCollisions(db, canonicalId, nowIso);

    db.prepare("COMMIT").run();
    return {
      canonicalId,
      satellitesMerged: satellites.length,
      factsRekeyed,
      headCollisionsResolved,
      aliasesAdded: aliasSet.size - before,
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
