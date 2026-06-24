/**
 * Bug clusters (B1) — cross-session failure clustering, deterministic, no LLM.
 *
 * Responsibility: load bug events + relations from DB, resolve file entities,
 * delegate graph construction to bug-cluster-graph.ts.
 *
 * Never throws on the consolidation path. Any error yields [].
 */

import type { DatabaseSync } from "node:sqlite";
import { EVIDENCE_MIN } from "./bug-similarity.js";
import { createKbVecEmbeddingReader, type EmbeddingReader } from "./bug-embeddings.js";
import { buildComponents, buildClusters, type BugEventNode } from "./bug-cluster-graph.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface FailureCluster {
  /** Sorted ids of the bug events in this cluster. */
  bugEventIds: string[];
  /** Text of each bug event (same order as bugEventIds). */
  bugTexts: string[];
  /** Number of distinct sessions contributing bugs to this cluster. */
  distinctSessionCount: number;
  /** Sorted list of distinct session keys. */
  sessionKeys: string[];
  namespace: string;
  project: string;
  /** Union of file entity ids (type='file') across all bugs in the cluster. */
  files: string[];
  /** Union of all entity ids (file + non-file) across all bugs in the cluster. */
  entityIds: string[];
  /**
   * Distinct error/type signatures — populated by B2 (lesson-trigger).
   * Left [] here intentionally; B2 owns this field.
   */
  errorSignatures: string[];
}

export interface SelectFailureClustersParams {
  namespace?: string;
  sinceTs?: string;
  /**
   * Injectable embedding reader. Omit to use the production sqlite-vec reader
   * (dims=1536). Tests should pass fakeEmbeddingReader from bug-embeddings.ts.
   */
  embeddingReader?: EmbeddingReader;
}

// ── Internal DB row types ─────────────────────────────────────────────────────

interface BugEventRow extends BugEventNode {
  entities_json: string;
}

interface RelationRow {
  src_entity_id: string;
  dst_entity_id: string;
}

interface EntityTypeRow {
  id: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseStringArray(json: string): string[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Load all bug events, build a weighted graph, find connected components,
 * and emit FailureClusters meeting EVIDENCE_MIN + SESSION_MIN. Returns []
 * when none qualify. Never throws: any internal error degrades to [].
 */
export function selectFailureClusters(
  db: DatabaseSync,
  params: SelectFailureClustersParams,
): FailureCluster[] {
  try {
    return _selectFailureClusters(db, params);
  } catch {
    return [];
  }
}

function _selectFailureClusters(
  db: DatabaseSync,
  params: SelectFailureClustersParams,
): FailureCluster[] {
  // ── 1. Load bug events ────────────────────────────────────────────────────
  const whereClauses: string[] = ["type = 'bug'"];
  const args: unknown[] = [];
  if (params.namespace) { whereClauses.push("namespace = ?"); args.push(params.namespace); }
  if (params.sinceTs) { whereClauses.push("ts > ?"); args.push(params.sinceTs); }

  const rows = db
    .prepare(
      `SELECT id, ts, session_key, namespace, project, text, entities_json
         FROM events WHERE ${whereClauses.join(" AND ")} ORDER BY id ASC`,
    )
    .all(...(args as never[])) as BugEventRow[];

  if (rows.length < EVIDENCE_MIN) return [];

  // ── 2. Read embeddings ────────────────────────────────────────────────────
  const reader = params.embeddingReader ?? createKbVecEmbeddingReader(db);
  const embeddings = new Map<string, Float32Array>();
  const entityMap = new Map<string, string[]>();

  for (const row of rows) {
    const vec = reader(row.id);
    if (vec) embeddings.set(row.id, vec);
    entityMap.set(row.id, parseStringArray(row.entities_json));
  }

  const processable = rows.filter((r) => embeddings.has(r.id));
  if (processable.length < EVIDENCE_MIN) return [];

  // ── 3. Resolve file entities (type='file') ────────────────────────────────
  const allEntityIds = new Set<string>();
  for (const row of processable) {
    for (const eid of entityMap.get(row.id) ?? []) allEntityIds.add(eid);
  }

  const fileEntityIds = new Set<string>();
  if (allEntityIds.size > 0) {
    try {
      const placeholders = [...allEntityIds].map(() => "?").join(", ");
      const entityRows = db
        .prepare(`SELECT id FROM entities WHERE id IN (${placeholders}) AND type = 'file'`)
        .all(...([...allEntityIds] as never[])) as EntityTypeRow[];
      for (const er of entityRows) fileEntityIds.add(er.id);
    } catch {
      // entities table absent in some tests — non-fatal, files stays empty.
    }
  }

  // ── 4. Load causal relations ──────────────────────────────────────────────
  const causalEntityPairs = new Set<string>();
  try {
    const relRows = db
      .prepare(`SELECT src_entity_id, dst_entity_id FROM relations WHERE type IN ('caused', 'fixed-by')`)
      .all() as RelationRow[];
    for (const rel of relRows) {
      causalEntityPairs.add(`${rel.src_entity_id}|${rel.dst_entity_id}`);
      causalEntityPairs.add(`${rel.dst_entity_id}|${rel.src_entity_id}`);
    }
  } catch {
    // relations table may not exist in tests — non-fatal.
  }

  // ── 5. Build graph + emit clusters ───────────────────────────────────────
  const nodeById = new Map(processable.map((r) => [r.id, r as BugEventNode]));
  const components = buildComponents(processable, embeddings, entityMap, causalEntityPairs);
  return buildClusters(components, nodeById, entityMap, fileEntityIds);
}
