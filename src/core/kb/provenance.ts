/**
 * provenance.ts — the trust model for Grounded Trust (Phase 1).
 *
 * Every memory unit (fact/event) carries a provenance stamp in
 * memory_lifecycle.provenance_json. Trust is DERIVED from origin and defaults to
 * "unverified" (conservative: unknown origin = untrusted). Trust gates ACTION in
 * later phases, never injection. Parsing is tolerant: a legacy "{}" or any
 * malformed value degrades to conversation/unverified and NEVER throws into a turn.
 */
import { z } from "zod";

export type ProvenanceOrigin =
  | "conversation"
  | "tool_output"
  | "lorenzo_confirmed"
  | "authoritative_source";

export type TrustLevel = "unverified" | "trusted";

// ── Phase 2 (stakes gate) persisted vocab — defined here so stakes.ts imports
//    from provenance.ts in ONE direction (no circular import). ──
export type StakesLevel = "none" | "high";
export type StakesDomain =
  | "payment"
  | "credential"
  | "destructive"
  | "prod"
  | "exfil"
  | "vision";
export type GateState = "clear" | "pending_confirmation" | "rejected";

export interface ProvenanceStamp {
  origin: ProvenanceOrigin;
  trust: TrustLevel;
  confirmed_by: "lorenzo" | null;
  confirmed_at: string | null;
  source_message_ids: string[];
  // Phase 2 gate fields — OPTIONAL: absent in v1 rows, present once the gate marks
  // a memory. Accessors gateStateOf/stakesOf default them, so v1 rows read cleanly.
  stakes?: StakesLevel;
  stakes_domain?: StakesDomain | null;
  gate_state?: GateState;
  rejected_at?: string | null;
  schema: 1 | 2;
}

/** Origins that earn trust. Everything else is unverified (conservative default). */
const TRUSTED_ORIGINS: ReadonlySet<ProvenanceOrigin> = new Set<ProvenanceOrigin>([
  "lorenzo_confirmed",
  "authoritative_source",
]);

export function deriveTrust(origin: ProvenanceOrigin): TrustLevel {
  return TRUSTED_ORIGINS.has(origin) ? "trusted" : "unverified";
}

const STAMP_SCHEMA = z.object({
  origin: z.enum(["conversation", "tool_output", "lorenzo_confirmed", "authoritative_source"]),
  trust: z.enum(["unverified", "trusted"]),
  confirmed_by: z.union([z.literal("lorenzo"), z.null()]).default(null),
  confirmed_at: z.union([z.string(), z.null()]).default(null),
  source_message_ids: z.array(z.string()).default([]),
  // Phase 2 gate fields — optional, omitted from v1 rows.
  stakes: z.enum(["none", "high"]).optional(),
  stakes_domain: z
    .union([
      z.enum(["payment", "credential", "destructive", "prod", "exfil", "vision"]),
      z.null(),
    ])
    .optional(),
  gate_state: z.enum(["clear", "pending_confirmation", "rejected"]).optional(),
  rejected_at: z.union([z.string(), z.null()]).optional(),
  schema: z.union([z.literal(1), z.literal(2)]).default(1),
});

/** A fresh stamp for conversation-extracted memory: conversation / unverified. */
export function defaultProvenance(sourceMessageIds: string[] = []): ProvenanceStamp {
  return {
    origin: "conversation",
    trust: deriveTrust("conversation"),
    confirmed_by: null,
    confirmed_at: null,
    source_message_ids: [...sourceMessageIds],
    schema: 1,
  };
}

export function serializeProvenance(stamp: ProvenanceStamp): string {
  return JSON.stringify(stamp);
}

// ── Phase 2 gate accessors (default v1 rows to clear/none) ──
export function gateStateOf(stamp: ProvenanceStamp): GateState {
  return stamp.gate_state ?? "clear";
}
export function stakesOf(stamp: ProvenanceStamp): StakesLevel {
  return stamp.stakes ?? "none";
}

/**
 * Mark a stamp as pending the ask-loop. Records the stakes that triggered it and
 * bumps the schema to 2. Does NOT touch trust — gate state ≠ trust (the soul stays
 * intact: an unverified memory is still injected; only its ACTION is now gated).
 * Immutable: returns a new stamp.
 */
export function withPendingGate(
  stamp: ProvenanceStamp,
  stakes: { stakes: StakesLevel; stakes_domain: StakesDomain | null },
): ProvenanceStamp {
  return {
    ...stamp,
    stakes: stakes.stakes,
    stakes_domain: stakes.stakes_domain,
    gate_state: "pending_confirmation",
    schema: 2,
  };
}

/**
 * Tombstone a stamp: Lorenzo said NO. The memory is marked `rejected` (kept, not
 * hard-deleted — the burned child learns to discriminate, it does not forget the
 * fire), with the rejection timestamp. Immutable: returns a new stamp.
 */
export function withRejectedGate(stamp: ProvenanceStamp, now: string): ProvenanceStamp {
  return {
    ...stamp,
    gate_state: "rejected",
    rejected_at: now,
    schema: 2,
  };
}

/**
 * Parse a provenance_json string. Tolerant by design: legacy "{}", missing
 * fields, or non-JSON all degrade to conversation/unverified. Never throws.
 */
export function parseProvenance(json: string | null | undefined): ProvenanceStamp {
  if (!json) return defaultProvenance();
  try {
    const raw = JSON.parse(json) as unknown;
    const parsed = STAMP_SCHEMA.safeParse(raw);
    if (!parsed.success) return defaultProvenance();
    // Re-derive trust from origin so a tampered/legacy trust value can't lie.
    return { ...parsed.data, trust: deriveTrust(parsed.data.origin) };
  } catch {
    return defaultProvenance();
  }
}
