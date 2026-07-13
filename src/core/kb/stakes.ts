/**
 * stakes.ts — the "consequential action" gate for Grounded Trust (Phase 2).
 *
 * The pillar's ask-loop must fire ONLY when three conditions hold together:
 *
 *     high-stakes action  AND  uncertain memory  AND  not-yet-confirmed
 *
 * Phase 1 (provenance) delivered the last two (`trust=unverified`). This module
 * delivers the FIRST — a deterministic decision "would acting on this recalled
 * memory cross a line that warrants asking Lorenzo?". A false positive costs ONE
 * question, never a wrong action; so the patterns favor precision but the cost of
 * a miss is small. Two branches:
 *
 *   - OPERATIVE — the one-way doors (payment / credential / destructive / prod /
 *     exfil), recognized by content. Reuses the existing secret redactor's signal
 *     for credentials; adds narrow patterns for the rest (the redactor does NOT
 *     cover IBAN/destructive/exfil — verified in `src/utils/redact-secrets.ts`).
 *   - VISION — weighty product/direction decisions, recognized NOT by a text
 *     pattern but by WEIGHT: an extractor `type="decision"` event whose
 *     distinctiveness (Idea 5) clears a conservative-high threshold.
 *
 * Pure & total: no side effects, never throws (unknown → "none").
 */

import { containsSecret } from "../../utils/redact-secrets.js";
import type { TrustLevel, StakesLevel, StakesDomain, GateState } from "./provenance.js";

export type { StakesLevel, StakesDomain, GateState };

export interface StakesResult {
  stakes: StakesLevel;
  stakes_domain: StakesDomain | null;
}

const NONE: StakesResult = { stakes: "none", stakes_domain: null };
const high = (domain: StakesDomain): StakesResult => ({ stakes: "high", stakes_domain: domain });

/**
 * Conservative-HIGH default: only a genuinely distinctive (rare + isolated)
 * decision crosses it, so a trivial operative decision ("use BEGIN/COMMIT") stays
 * out. Calibrated later against real recalls (mirrors the wAffect=0 discipline).
 */
export const VISION_DISTINCTIVENESS_THRESHOLD = 0.7;

// ── Operative patterns (narrow, high-precision) ─────────────────────────────

/** IBAN: 2 country letters + 2 check digits + 11–30 alphanumerics. */
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;

/** Already-redacted credential marker produced by redact-secrets on the recall path. */
const REDACTED_MARKER_RE = /\[REDACTED:[a-z-]+\]/i;

/** Destructive data/file commands. */
const DESTRUCTIVE_RE =
  /\brm\s+-rf?\b|\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b|\bDELETE\s+FROM\b/i;

/** Pushing to a public/production surface. */
const PROD_RE =
  /\bgit\s+push\b[\s\S]{0,40}\b(?:--force|-f)\b|\bgit\s+push\b[\s\S]{0,40}\b(?:main|master|prod|production|upstream)\b|\bdeploy(?:ing|ment)?\b[\s\S]{0,20}\bprod(?:uction)?\b/i;

/** Data leaving the machine (weakest signal — narrow on purpose). */
const EXFIL_RE =
  /\b(?:curl|wget|fetch)\b[\s\S]{0,60}\bhttps?:\/\//i;

/**
 * Operative classification by content. Order = severity: payment and credential
 * (the hardest doors) win over destructive/prod/exfil when several match.
 */
export function classifyOperativeStakes(content: string): StakesResult {
  if (typeof content !== "string" || content.length === 0) return NONE;
  if (IBAN_RE.test(content)) return high("payment");
  if (REDACTED_MARKER_RE.test(content) || containsSecret(content)) return high("credential");
  if (DESTRUCTIVE_RE.test(content)) return high("destructive");
  if (PROD_RE.test(content)) return high("prod");
  if (EXFIL_RE.test(content)) return high("exfil");
  return NONE;
}

/**
 * Vision classification by WEIGHT. high/vision ⟺ a `decision` event whose
 * distinctiveness clears τ AND that the operative classifier did NOT already
 * claim (operative is the harder gate and wins upstream).
 */
export function classifyVisionStakes(
  signals: { eventType?: string; distinctiveness?: number },
  operativeHit: boolean,
): StakesResult {
  if (operativeHit) return NONE;
  const isDecision = signals.eventType === "decision";
  const d = typeof signals.distinctiveness === "number" ? signals.distinctiveness : 0;
  if (isDecision && d >= VISION_DISTINCTIVENESS_THRESHOLD) return high("vision");
  return NONE;
}

/**
 * Composite classifier: operative wins ties (a payout-IBAN decision is a payment,
 * not a vision question). Pure; reads signals computed elsewhere, invents none.
 */
export function classifyStakes(input: {
  content: string;
  eventType?: string;
  distinctiveness?: number;
}): StakesResult {
  const operative = classifyOperativeStakes(input.content);
  if (operative.stakes === "high") return operative;
  return classifyVisionStakes(
    { eventType: input.eventType, distinctiveness: input.distinctiveness },
    false,
  );
}

/**
 * The three-AND gate predicate: only an UNCERTAIN, HIGH-stakes, not-yet-handled
 * memory should trigger the ask-loop. Trusted (already confirmed) or already
 * pending/rejected memories never re-gate.
 */
export function shouldGate(memory: {
  trust: TrustLevel;
  stakes: StakesLevel;
  gateState: GateState;
}): boolean {
  return (
    memory.trust === "unverified" &&
    memory.stakes === "high" &&
    memory.gateState === "clear"
  );
}
