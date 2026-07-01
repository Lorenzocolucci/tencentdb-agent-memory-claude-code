/**
 * behavioral-law-capture — Percorso A, Slice A2b (capture logic, no live hook).
 *
 * When Lorenzo states a behavioral law, persist it as a `rule_<slug>` HEAD fact on
 * his person entity. The persona projection (Slice A2a) then surfaces it in the
 * always-on "Process & Working-Style Rules" section — the law comes to the agent
 * every session, deterministically, without semantic recall.
 *
 * Precision guard: detectDirective already rejects status notes ("non ho toccato")
 * via its non-stopword set — that is the PRIMARY guard. The strength threshold is a
 * secondary knob. We err toward CAPTURING (a non-coder's laws are precious; a bit
 * of noise is visible and can be tombstoned/refined later by the retract path + the
 * LLM refinement of Slice A3). Dedup: the slug is derived from the rule text, so
 * restating the same law hits the same attribute and SUPERSEDES (reinforces),
 * never duplicates.
 *
 * Off the critical path: any store error is swallowed — capture must never break a
 * conversation. Pure w.r.t. its inputs otherwise (no globals, no I/O of its own).
 */

import { detectDirective, type DirectiveKind } from "./behavioral-law-detector.js";
import { confidenceAfterAvoidance } from "./lesson-reinforcement.js";

/** Minimum detector strength to persist a law. The detector's status-note
 *  rejection is the main precision guard; this only drops the very weakest hits. */
export const CAPTURE_MIN_STRENGTH = 0.35;
export const RULE_ATTR_PREFIX = "rule_";
/** Cap the stored rule value; the LLM refinement (A3) will shorten/clean later. */
export const MAX_RULE_LEN = 240;
/** Cap the slug so the attribute key stays short and stable. */
const MAX_SLUG_LEN = 48;

/** The minimal store surface the capture needs (a subset of IMemoryStore). */
export interface LawCaptureStore {
  upsertFact?(params: {
    entityId: string;
    attribute: string;
    value: string;
    confidence?: number;
    now: string;
  }): unknown;
  /** Optional: current HEAD facts of the entity, so a re-stated law can be
   *  reinforced (its confidence raised) rather than overwritten. Absent on the
   *  minimal fakes → capture degrades gracefully to the detector strength. */
  queryHeadFacts?(entityId: string): Array<{ attribute: string; confidence: number }>;
}

export interface LawCaptureResult {
  captured: boolean;
  attribute?: string;
  kind?: DirectiveKind;
  strength?: number;
  /** True when this law already existed and its confidence was RAISED (the
   *  willingness bridge: reiteration strengthens; see {@link confidenceAfterAvoidance}). */
  reinforced?: boolean;
}

/**
 * Deterministic dedup slug from a rule's text: lowercase, unicode-normalized,
 * non-alphanumerics → "_", collapsed and trimmed, capped. Same law text → same
 * slug → supersede (reinforce), never a duplicate fact.
 */
export function ruleSlug(text: string): string {
  const slug = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/_$/g, "");
  return slug.length > 0 ? slug : "law";
}

/**
 * Detect and persist a behavioral law from a user message. Returns whether a law
 * was captured (and its attribute/kind) for logging/tests. Never throws.
 */
export function captureBehavioralLaw(params: {
  store: LawCaptureStore;
  userEntityId: string;
  userText: string;
  now: string;
  /** Override the strength floor (default {@link CAPTURE_MIN_STRENGTH}). */
  minStrength?: number;
}): LawCaptureResult {
  const { store, userEntityId, userText, now } = params;
  if (!store?.upsertFact || !userEntityId) return { captured: false };

  const candidate = detectDirective(userText);
  if (!candidate) return { captured: false };

  const floor = params.minStrength ?? CAPTURE_MIN_STRENGTH;
  if (candidate.strength < floor) return { captured: false };

  const attribute = `${RULE_ATTR_PREFIX}${ruleSlug(candidate.text)}`;
  const value =
    candidate.text.length > MAX_RULE_LEN ? candidate.text.slice(0, MAX_RULE_LEN) : candidate.text;

  // Willingness bridge: if this exact law already exists, RAISE its confidence
  // (reiteration = reinforcement, diminishing returns toward the cap) instead of
  // overwriting it with the fresh single-shot detector strength. A first-time law
  // keeps the detector strength. Reused, tested dynamics from lesson-reinforcement.
  const prior = store.queryHeadFacts?.(userEntityId)?.find((f) => f.attribute === attribute);
  const reinforced = prior !== undefined;
  const confidence = reinforced
    ? confidenceAfterAvoidance(Math.max(prior.confidence, candidate.strength))
    : candidate.strength;

  try {
    store.upsertFact({ entityId: userEntityId, attribute, value, confidence, now });
  } catch {
    return { captured: false }; // off the critical path — never break capture
  }

  return { captured: true, attribute, kind: candidate.kind, strength: candidate.strength, reinforced };
}

/** The person-entity name laws are attached to (Lorenzo's choice, 2026-07-01). */
export const DEFAULT_USER_NAME = "Lorenzo";

/** Store surface for the turn hook: resolve the user entity + write the fact. */
export interface LawHookStore extends LawCaptureStore {
  resolveOrCreateEntity?(params: {
    namespace?: string;
    type: string;
    name: string;
    now: string;
  }): { id: string };
}

/**
 * Turn-level entry point (called from performAutoCapture with the user's message).
 * Detects a law FIRST — only on a hit does it resolve/create the canonical user
 * person entity and persist the rule. So non-law turns touch the store not at all.
 * Never throws.
 */
export function captureLawFromUserTurn(params: {
  store: LawHookStore;
  userText: string;
  now: string;
  namespace?: string;
  userName?: string;
  minStrength?: number;
}): LawCaptureResult {
  const { store, userText, now } = params;
  if (!store?.resolveOrCreateEntity || !store?.upsertFact || !userText) return { captured: false };

  const floor = params.minStrength ?? CAPTURE_MIN_STRENGTH;
  const candidate = detectDirective(userText);
  if (!candidate || candidate.strength < floor) return { captured: false };

  let entityId: string;
  try {
    const entity = store.resolveOrCreateEntity({
      namespace: params.namespace,
      type: "person",
      name: params.userName ?? DEFAULT_USER_NAME,
      now,
    });
    entityId = entity.id;
  } catch {
    return { captured: false }; // never break capture
  }

  return captureBehavioralLaw({ store, userEntityId: entityId, userText, now, minStrength: floor });
}
