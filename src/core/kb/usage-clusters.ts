/**
 * Usage clusters (Slice B1, Percorso B — implicit tendencies) — cross-session
 * clustering of recurring BEHAVIORAL patterns by SEMANTIC similarity.
 *
 * This is the second clustering axis the design calls "il nodo tecnico vero":
 * principle-clusters groups by SHARED ENTITY, but many behaviors ("aspetta la
 * mia risposta") anchor to no entity and never cluster there. Here we group by
 * embedding similarity instead — the entity axis is orthogonal, so an
 * entity-less behavior still earns a cluster once it recurs across sessions.
 *
 * Deterministic, no LLM, no DB: embeddings are injected. Anti-anecdote guard:
 * ≥ USAGE_EVIDENCE_MIN events across ≥ USAGE_SESSION_MIN distinct session_id.
 * Never throws: any error yields [].
 *
 * Boundary: bugs belong to `lessons`; explicit laws ("how to work with you")
 * belong to Percorso A. We exclude those types here (usage = "what you do").
 */

import type { KbEvent } from "../store/types.js";
import { UnionFind } from "./union-find.js";
import {
  usageEdgeWeight,
  USAGE_TAU,
  USAGE_EVIDENCE_MIN,
  USAGE_SESSION_MIN,
  type UsageEventFeatures,
} from "./usage-similarity.js";

/** Behavioral/usage event types (NOT bugs, NOT explicit laws). */
export const DEFAULT_USAGE_ELIGIBLE_TYPES = ["preference_stated", "observation"] as const;

/** A qualifying cross-session cluster of semantically-related behaviors. */
export interface UsageCluster {
  /** Representative text of the cluster (its "name"): the first event by id. */
  theme: string;
  /** Sorted ids of the events in this cluster. */
  eventIds: string[];
  /** Event texts (same order as eventIds). */
  texts: string[];
  /** Sorted distinct session_ids — the real cross-session axis. */
  sessionIds: string[];
  /** Dominant session_key (most events) — anchors the pattern to its project. */
  sessionKey: string;
  /** Union of source_message_ids across the cluster (provenance). */
  sourceMessageIds: string[];
  /** Most common non-empty project across the cluster. */
  project: string;
}

export interface SelectUsageClustersOptions {
  /** Injected embeddings by event id (dims must match across events). */
  embeddings: ReadonlyMap<string, Float32Array>;
  eligibleTypes?: readonly string[];
  evidenceMin?: number;
  sessionMin?: number;
  tau?: number;
}

function deriveProject(events: readonly KbEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) if (e.project) counts.set(e.project, (counts.get(e.project) ?? 0) + 1);
  let best = "";
  let bestN = 0;
  for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
  return best;
}

/** Dominant session_key (most events; ties broken by sort for determinism). */
function dominantSessionKey(events: readonly KbEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.session_key, (counts.get(e.session_key) ?? 0) + 1);
  let best = "";
  let bestN = -1;
  for (const sk of [...counts.keys()].sort()) {
    const n = counts.get(sk)!;
    if (n > bestN) { bestN = n; best = sk; }
  }
  return best;
}

export function selectUsageClusters(
  events: readonly KbEvent[],
  opts: SelectUsageClustersOptions,
): UsageCluster[] {
  try {
    const evidenceMin = opts.evidenceMin ?? USAGE_EVIDENCE_MIN;
    const sessionMin = opts.sessionMin ?? USAGE_SESSION_MIN;
    const tau = opts.tau ?? USAGE_TAU;
    const eligible = new Set(opts.eligibleTypes ?? DEFAULT_USAGE_ELIGIBLE_TYPES);
    const embeddings = opts.embeddings;

    if (!Array.isArray(events)) return [];

    // Processable = eligible type AND has an embedding. Sorted by id for a
    // deterministic pairwise order and stable cluster output.
    const processable = events
      .filter((e) => eligible.has(e.type) && embeddings.has(e.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (processable.length < evidenceMin) return [];

    // Semantic graph: union events whose edge weight meets tau.
    const uf = new UnionFind(processable.map((e) => e.id));
    for (let i = 0; i < processable.length; i++) {
      for (let j = i + 1; j < processable.length; j++) {
        const a = processable[i];
        const b = processable[j];
        const fa: UsageEventFeatures = { embedding: embeddings.get(a.id)!, contextIds: a.entities ?? [] };
        const fb: UsageEventFeatures = { embedding: embeddings.get(b.id)!, contextIds: b.entities ?? [] };
        if (usageEdgeWeight(fa, fb) >= tau) uf.union(a.id, b.id);
      }
    }

    const byId = new Map(processable.map((e) => [e.id, e]));
    const clusters: UsageCluster[] = [];

    for (const [, componentIds] of uf.components()) {
      const sortedIds = [...componentIds].sort();
      if (sortedIds.length < evidenceMin) continue;

      const group = sortedIds.map((id) => byId.get(id)!).filter(Boolean);
      // Distinct SESSIONS = distinct session_id (session_key is per-project).
      const sessions = new Set(group.map((e) => e.session_id).filter(Boolean));
      if (sessions.size < sessionMin) continue;

      const provenance = new Set<string>();
      for (const e of group) for (const m of e.source_message_ids ?? []) provenance.add(m);

      clusters.push({
        theme: group[0].text,
        eventIds: sortedIds,
        texts: group.map((e) => e.text),
        sessionIds: [...sessions].sort(),
        sessionKey: dominantSessionKey(group),
        sourceMessageIds: [...provenance],
        project: deriveProject(group),
      });
    }

    return clusters.sort((a, b) => a.eventIds[0].localeCompare(b.eventIds[0]));
  } catch {
    return [];
  }
}
