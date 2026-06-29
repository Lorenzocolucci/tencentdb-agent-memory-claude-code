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

export interface ProvenanceStamp {
  origin: ProvenanceOrigin;
  trust: TrustLevel;
  confirmed_by: "lorenzo" | null;
  confirmed_at: string | null;
  source_message_ids: string[];
  schema: 1;
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
  schema: z.literal(1).default(1),
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
