/**
 * Bug cluster graph — weighted graph construction and connected-component
 * extraction for B1 cross-session failure clustering.
 *
 * Consumed by bug-clusters.ts. Pure: no DB access, no I/O.
 * Immutable: every function returns new objects, nothing is mutated in place.
 */

import {
  bugEdgeWeight,
  TAU,
  EVIDENCE_MIN,
  SESSION_MIN,
  type BugEventFeatures,
} from "./bug-similarity.js";
import { UnionFind } from "./union-find.js";
import type { FailureCluster } from "./bug-clusters.js";

// ── Internal row shape (subset used here) ─────────────────────────────────────

export interface BugEventNode {
  id: string;
  session_key: string;
  namespace: string;
  project: string;
  text: string;
}

// ── Graph helpers ─────────────────────────────────────────────────────────────

/**
 * Run union-find over the processable bug events, joining pairs whose edge
 * weight meets TAU. Returns connected components as a Map<root, id[]>.
 */
export function buildComponents(
  nodes: readonly BugEventNode[],
  embeddings: ReadonlyMap<string, Float32Array>,
  entityMap: ReadonlyMap<string, readonly string[]>,
  causalEntityPairs: ReadonlySet<string>,
): Map<string, string[]> {
  const uf = new UnionFind(nodes.map((n) => n.id));

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const aEntities = entityMap.get(a.id) ?? [];
      const bEntities = entityMap.get(b.id) ?? [];

      const aFeatures: BugEventFeatures = {
        embedding: embeddings.get(a.id)!,
        contextIds: aEntities,
      };
      const bFeatures: BugEventFeatures = {
        embedding: embeddings.get(b.id)!,
        contextIds: bEntities,
      };

      const linked = isRelationLinked(aEntities, bEntities, causalEntityPairs);
      if (bugEdgeWeight(aFeatures, bFeatures, linked) >= TAU) {
        uf.union(a.id, b.id);
      }
    }
  }

  return uf.components();
}

/** True iff any entity pair (one from each event) is in causalEntityPairs. */
function isRelationLinked(
  aIds: readonly string[],
  bIds: readonly string[],
  pairs: ReadonlySet<string>,
): boolean {
  for (const aId of aIds) {
    for (const bId of bIds) {
      if (pairs.has(`${aId}|${bId}`)) return true;
    }
  }
  return false;
}

// ── Cluster emission ───────────────────────────────────────────────────────────

/**
 * Convert connected components into FailureClusters, applying EVIDENCE_MIN and
 * SESSION_MIN guards. Returns clusters sorted by their first bug event id.
 */
export function buildClusters(
  components: Map<string, string[]>,
  nodeById: ReadonlyMap<string, BugEventNode>,
  entityMap: ReadonlyMap<string, readonly string[]>,
  fileEntityIds: ReadonlySet<string>,
): FailureCluster[] {
  const clusters: FailureCluster[] = [];

  for (const [, componentIds] of components) {
    const sortedIds = [...componentIds].sort();
    if (sortedIds.length < EVIDENCE_MIN) continue;

    const sessionSet = new Set<string>();
    for (const id of sortedIds) {
      const node = nodeById.get(id);
      if (node) sessionSet.add(node.session_key);
    }
    if (sessionSet.size < SESSION_MIN) continue;

    const bugTexts: string[] = [];
    const entityUnion = new Set<string>();
    const fileUnion = new Set<string>();

    for (const id of sortedIds) {
      const node = nodeById.get(id);
      if (!node) continue;
      bugTexts.push(node.text);
      for (const eid of entityMap.get(id) ?? []) {
        entityUnion.add(eid);
        if (fileEntityIds.has(eid)) fileUnion.add(eid);
      }
    }

    const firstNode = nodeById.get(sortedIds[0]);
    clusters.push({
      bugEventIds: sortedIds,
      bugTexts,
      distinctSessionCount: sessionSet.size,
      sessionKeys: [...sessionSet].sort(),
      namespace: firstNode?.namespace ?? "default",
      project: firstNode?.project ?? "",
      files: [...fileUnion].sort(),
      entityIds: [...entityUnion].sort(),
      // errorSignatures populated by B2 (lesson-trigger); intentionally [] here.
      errorSignatures: [],
    });
  }

  return clusters.sort((a, b) => a.bugEventIds[0].localeCompare(b.bugEventIds[0]));
}
