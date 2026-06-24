/**
 * lessons-runner-db.ts (B2a, internal) — DB I/O helpers for the lessons
 * orchestrator. Extracted so lessons-runner.ts stays ≤200 lines.
 *
 * Never throws: any internal DB error degrades to empty result.
 */

import type { DatabaseSync } from "node:sqlite";

// ── Internal row shapes ───────────────────────────────────────────────────────

interface RelationRow {
  src_entity_id: string;
  dst_entity_id: string;
  type: string;
}

interface FixEventRow {
  id: string;
  text: string;
}

interface EntityRow {
  id: string;
}

// ── Entity map ────────────────────────────────────────────────────────────────

/**
 * Load entities_json for each event id. Returns map id → entityId[].
 * Never throws.
 */
export function loadEntityMap(
  db: DatabaseSync,
  eventIds: readonly string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>(eventIds.map((id) => [id, []]));
  if (eventIds.length === 0) return result;
  try {
    const ph = eventIds.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT id, entities_json FROM events WHERE id IN (${ph})`)
      .all(...(eventIds as never[])) as Array<{ id: string; entities_json: string }>;
    for (const row of rows) {
      try {
        const arr = JSON.parse(row.entities_json);
        result.set(
          row.id,
          Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [],
        );
      } catch {
        // malformed → empty
      }
    }
  } catch {
    // events query failure → non-fatal
  }
  return result;
}

// ── Per-bug file resolver ─────────────────────────────────────────────────────

/**
 * Resolve file entities (type='file') for each bug event id.
 * Returns map bugEventId → fileEntityIds[]. Never throws.
 */
export function resolvePerBugFiles(
  db: DatabaseSync,
  bugEventIds: readonly string[],
  entityMapRaw: Map<string, string[]>,
): Map<string, string[]> {
  const result = new Map<string, string[]>(bugEventIds.map((id) => [id, []]));

  const allIds = new Set<string>();
  for (const bugId of bugEventIds) {
    for (const eid of entityMapRaw.get(bugId) ?? []) allIds.add(eid);
  }
  if (allIds.size === 0) return result;

  try {
    const ph = [...allIds].map(() => "?").join(", ");
    const fileRows = db
      .prepare(`SELECT id FROM entities WHERE id IN (${ph}) AND type = 'file'`)
      .all(...([...allIds] as never[])) as EntityRow[];
    const fileSet = new Set(fileRows.map((r) => r.id));

    for (const bugId of bugEventIds) {
      const files = (entityMapRaw.get(bugId) ?? []).filter((eid) => fileSet.has(eid));
      result.set(bugId, files);
    }
  } catch {
    // entities table may be absent in tests — non-fatal
  }

  return result;
}

// ── Fix event loader ──────────────────────────────────────────────────────────

/**
 * Find fix event texts linked to bugEventIds via fixed-by / caused relations.
 * Returns deduplicated fix texts. Never throws.
 *
 * Correct chain (verified on live KB where 20/20 relation endpoints are ent_*):
 *   1. Collect all bug entity ids from entityMap (already built by the runner).
 *   2. Find relations of type 'fixed-by'/'caused' where EITHER endpoint is a
 *      bug entity id; collect the OTHER-side entity ids (fix/resolution entities).
 *   3. Find events whose entities_json contains any fix entity id; exclude the
 *      cluster's own bug events (circularity guard).
 *   4. Return deduplicated texts. Best-effort: [] on any empty chain or error.
 *
 * @param entityMap  Map from bug event id → entity ids (pass the map already
 *                   built by loadEntityMap in the runner — no extra DB query).
 */
export function loadFixTexts(
  db: DatabaseSync,
  bugEventIds: readonly string[],
  entityMap: Map<string, string[]>,
): string[] {
  if (bugEventIds.length === 0) return [];
  try {
    // Step 1: collect all entity ids linked to the bug events.
    const bugEntityIds = new Set<string>();
    for (const bugId of bugEventIds) {
      for (const eid of entityMap.get(bugId) ?? []) bugEntityIds.add(eid);
    }
    if (bugEntityIds.size === 0) return [];

    // Step 2: find relations where either endpoint is a bug entity id.
    const bugEntArr = [...bugEntityIds];
    const ph = bugEntArr.map(() => "?").join(", ");
    const relRows = db
      .prepare(
        `SELECT src_entity_id, dst_entity_id, type FROM relations
          WHERE (src_entity_id IN (${ph}) AND type IN ('fixed-by','caused'))
             OR (dst_entity_id IN (${ph}) AND type IN ('fixed-by','caused'))`,
      )
      .all(...(bugEntArr as never[]), ...(bugEntArr as never[])) as RelationRow[];

    // Collect the "other side" entity ids (the candidate fix / resolution entities).
    const fixEntityIds = new Set<string>();
    for (const rel of relRows) {
      if (bugEntityIds.has(rel.src_entity_id)) {
        // bug-entity → fixed-by / caused → fix/effect entity
        fixEntityIds.add(rel.dst_entity_id);
      }
      if (bugEntityIds.has(rel.dst_entity_id)) {
        // fix/cause entity → fixed-by / caused → bug-entity (reverse direction)
        fixEntityIds.add(rel.src_entity_id);
      }
    }
    // Remove bug entities themselves from the fix candidate set.
    for (const bugEnt of bugEntityIds) fixEntityIds.delete(bugEnt);
    if (fixEntityIds.size === 0) return [];

    // Step 3: find events whose entities_json contains any fix entity id,
    // but exclude the cluster's own bug events.
    const bugEventSet = new Set(bugEventIds);
    const seen = new Set<string>();
    const texts: string[] = [];

    for (const fixEntId of fixEntityIds) {
      // LIKE search: entities_json is a JSON array, e.g. '["ent_foo","ent_bar"]'
      // We search for the quoted entity id to avoid partial-id matches.
      const rows = db
        .prepare(
          `SELECT id, text FROM events
            WHERE entities_json LIKE ?
              AND id NOT IN (${bugEventIds.map(() => "?").join(", ")})`,
        )
        .all(
          `%"${fixEntId}"%` as never,
          ...(bugEventIds as never[]),
        ) as FixEventRow[];

      for (const row of rows) {
        if (!bugEventSet.has(row.id) && row.text && !seen.has(row.text)) {
          seen.add(row.text);
          texts.push(row.text);
        }
      }
    }

    return texts;
  } catch {
    return [];
  }
}
