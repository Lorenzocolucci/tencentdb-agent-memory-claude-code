/**
 * Situation → memory injection (Context Fingerprint / Idea 1, the "inject" half).
 *
 * Given the current situation and the stored fingerprints, find the most similar
 * PAST situation and surface the memories that mattered then — proactive
 * injection by the SHAPE of the work, learned across sessions, not by a query.
 *
 * Two-tier voice (Lorenzo's choice — more suggestions, honestly framed):
 *   strong → assertive ("last time you were in a situation like this…")
 *   medium → tentative ("possibly related — loosely similar past situation…")
 *   none   → silent (explicit /recall covers it; premature-closure guard).
 *
 * GOLDEN RULE: silent unless relevant. Owners already shown this session are
 * deduped; if nothing new survives, return null.
 */

import type { IMemoryStore } from "../store/types.js";
import type { StoredFingerprint } from "../kb/fingerprint-writer.js";
import {
  scoreFingerprint,
  classifyMatch,
  type Fingerprint,
  type MatchThresholds,
  type MatchTier,
} from "./fingerprint-similarity.js";

const MAX_OWNERS = 3;
const MAX_LINE = 160;

export interface SituationMatch {
  /** The `<situation-memory>` block to inject. */
  block: string;
  /** Owner ids actually surfaced (for session dedup + fingerprint learning). */
  ownerIds: string[];
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1)}…` : t;
}

function header(tier: Exclude<MatchTier, "none">): string {
  return tier === "strong"
    ? "📌 Last time you were in a situation like this, this mattered (proactive — reference, not a task):"
    : "🔎 Possibly related — from a loosely similar past situation (low confidence, verify before trusting):";
}

/** Pick the highest-scoring stored fingerprint, or null when none score > 0. */
function bestMatch(current: Fingerprint, fingerprints: StoredFingerprint[]): { fp: StoredFingerprint; score: number } | null {
  let best: { fp: StoredFingerprint; score: number } | null = null;
  for (const fp of fingerprints) {
    const score = scoreFingerprint(current, fp);
    if (score > 0 && (!best || score > best.score)) best = { fp, score };
  }
  return best;
}

/**
 * Build the proactive situation-memory block, or null when nothing worth
 * surfacing (no match, weak match, or every owner already shown).
 */
export function buildSituationInjection(
  store: IMemoryStore,
  current: Fingerprint,
  fingerprints: StoredFingerprint[],
  alreadyInjectedOwnerIds: ReadonlySet<string>,
  thresholds?: MatchThresholds,
): SituationMatch | null {
  if (!store.queryEntityById || !store.queryHeadFacts) return null; // backend without KB reads → silence
  if (fingerprints.length === 0) return null;

  const best = bestMatch(current, fingerprints);
  if (!best) return null;
  const tier = classifyMatch(best.score, thresholds);
  if (tier === "none") return null;

  const lines: string[] = [];
  const surfaced: string[] = [];
  for (const ownerId of best.fp.matchedOwnerIds) {
    if (surfaced.length >= MAX_OWNERS) break;
    if (alreadyInjectedOwnerIds.has(ownerId)) continue; // shown already this session
    const entity = store.queryEntityById(ownerId);
    if (!entity) continue; // owner no longer resolves → skip
    const facts = store.queryHeadFacts(entity.id);
    const snippet = facts[0] ? `: ${clip(facts[0].value)}` : "";
    lines.push(`- ${entity.name}${snippet}`);
    surfaced.push(ownerId);
  }

  if (surfaced.length === 0) return null; // everything deduped or unresolved → silence

  const block =
    "<situation-memory>\n" + header(tier) + "\n" + lines.join("\n") + "\n</situation-memory>";
  return { block, ownerIds: surfaced };
}
