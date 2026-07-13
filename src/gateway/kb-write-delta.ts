/**
 * `/kb/write` simplified-form → raw KbDelta conversion.
 *
 * The deterministic write route accepts an ergonomic flat-fact form so an
 * external agent does not have to construct entity refs by hand. This pure,
 * dependency-free transform groups the flat facts into entities by
 * (entity_type, entity_name), assigns each unique pair a synthetic local ref
 * ("e0", "e1", …), and points every fact at its entity's ref. The result is a
 * RAW object still validated + vocabulary-coerced downstream by
 * `parseKbDelta`/`normalizeRawKbDelta` (out-of-vocabulary entity types →
 * "concept"; non-snake_case attributes → snake_case; caps + required fields
 * enforced), so this builder stays a structural transform with no schema
 * knowledge of its own.
 */

import type { KbWriteFact } from "./types.js";

export function buildRawDeltaFromFacts(facts: KbWriteFact[], language?: string): unknown {
  const refByEntityKey = new Map<string, string>();
  const entities: Array<{ ref: string; type: string; name: string }> = [];
  const outFacts: Array<{
    entity_ref: string;
    attribute: string;
    value: string;
    confidence?: number;
  }> = [];

  for (const f of facts) {
    const type = typeof f.entity_type === "string" ? f.entity_type : "concept";
    const name = typeof f.entity_name === "string" ? f.entity_name.trim() : "";
    const key = `${type} ${name}`;
    let ref = refByEntityKey.get(key);
    if (ref === undefined) {
      ref = `e${entities.length}`;
      refByEntityKey.set(key, ref);
      entities.push({ ref, type, name });
    }
    outFacts.push({
      entity_ref: ref,
      attribute: typeof f.attribute === "string" ? f.attribute : "",
      value: typeof f.value === "string" ? f.value : "",
      ...(typeof f.confidence === "number" ? { confidence: f.confidence } : {}),
    });
  }

  return { language: language ?? "und", entities, facts: outFacts, events: [], relations: [] };
}
