/**
 * Principle clusters (Pilastro C, Fase 2) — cross-session clustering of
 * NON-failure recurring memory (decisions/preferences) that share a common
 * entity. Deterministic, no LLM, no embeddings (unlike bug-clusters, which use
 * semantic similarity): grouping is by shared entity id, so a principle is
 * EARNED across sessions, never an anecdote.
 *
 * Boundary with Pilastro A (Mistake Notebook): failure types (bug/fix) belong to
 * `lessons`; we exclude them here. We also skip our own atoms (principle,
 * session_recap). Never throws: any error yields [].
 */
import type { KbEvent } from "../store/types.js";

/** Minimum distinct recurrences (events) for a cluster to qualify. */
export const PRINCIPLE_EVIDENCE_MIN = 2;
/** Minimum distinct sessions — the anecdote guard (a principle spans sessions). */
export const PRINCIPLE_SESSION_MIN = 2;
/** Event types that carry non-failure "hard-won" knowledge. */
export const DEFAULT_ELIGIBLE_TYPES = ["decision"] as const;

/** A qualifying cross-session cluster keyed on one shared entity. */
export interface PrincipleCluster {
  /** The shared entity that anchors the cluster (its "domain"). */
  domainEntity: string;
  /** Sorted ids of the events in this cluster. */
  eventIds: string[];
  /** Event texts (same order as eventIds). */
  texts: string[];
  /**
   * Sorted distinct session_ids contributing to the cluster. session_id (NOT
   * session_key) is the real "different session" axis: session_key is stable per
   * PROJECT, so recurrences within one project share it — only session_id changes
   * per chat. Same trap as the rollover bug.
   */
  sessionIds: string[];
  /** Dominant session_key (most events) — anchors the principle to its project. */
  sessionKey: string;
  /** Union of source_message_ids across the cluster (provenance). */
  sourceMessageIds: string[];
  /** Most common non-empty project across the cluster. */
  project: string;
}

export interface SelectPrincipleClustersOptions {
  evidenceMin?: number;
  sessionMin?: number;
  eligibleTypes?: readonly string[];
}

function deriveProject(events: readonly KbEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) if (e.project) counts.set(e.project, (counts.get(e.project) ?? 0) + 1);
  let best = "";
  let bestN = 0;
  for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
  return best;
}

export function selectPrincipleClusters(
  events: readonly KbEvent[],
  opts: SelectPrincipleClustersOptions,
): PrincipleCluster[] {
  try {
    const evidenceMin = opts.evidenceMin ?? PRINCIPLE_EVIDENCE_MIN;
    const sessionMin = opts.sessionMin ?? PRINCIPLE_SESSION_MIN;
    const eligible = new Set(opts.eligibleTypes ?? DEFAULT_ELIGIBLE_TYPES);

    // Group eligible events by each shared entity id.
    const byEntity = new Map<string, KbEvent[]>();
    for (const e of events) {
      if (!eligible.has(e.type)) continue;
      for (const ent of e.entities ?? []) {
        if (!ent) continue;
        const bucket = byEntity.get(ent);
        if (bucket) bucket.push(e);
        else byEntity.set(ent, [e]);
      }
    }

    const clusters: PrincipleCluster[] = [];
    for (const [entity, group] of byEntity) {
      const byId = new Map(group.map((e) => [e.id, e]));
      const uniq = [...byId.values()];
      if (uniq.length < evidenceMin) continue;
      // Distinct SESSIONS = distinct session_id (session_key is per-project).
      const sessions = new Set(uniq.map((e) => e.session_id).filter(Boolean));
      if (sessions.size < sessionMin) continue;

      const sorted = [...uniq].sort((a, b) => a.id.localeCompare(b.id));
      const provenance = new Set<string>();
      for (const e of sorted) for (const m of e.source_message_ids ?? []) provenance.add(m);

      // Dominant session_key (most events; ties broken by sort for determinism).
      const skCounts = new Map<string, number>();
      for (const e of sorted) skCounts.set(e.session_key, (skCounts.get(e.session_key) ?? 0) + 1);
      let domSk = "";
      let domN = -1;
      for (const sk of [...skCounts.keys()].sort()) {
        const n = skCounts.get(sk)!;
        if (n > domN) { domN = n; domSk = sk; }
      }

      clusters.push({
        domainEntity: entity,
        eventIds: sorted.map((e) => e.id),
        texts: sorted.map((e) => e.text),
        sessionIds: [...sessions].sort(),
        sessionKey: domSk,
        sourceMessageIds: [...provenance],
        project: deriveProject(sorted),
      });
    }

    return clusters.sort((a, b) => a.domainEntity.localeCompare(b.domainEntity));
  } catch {
    return [];
  }
}
