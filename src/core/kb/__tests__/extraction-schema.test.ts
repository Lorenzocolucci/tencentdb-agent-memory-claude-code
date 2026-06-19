/**
 * Phase 2 — KbDelta schema validation tests.
 *
 * parseKbDelta NEVER throws — it returns {ok:true,delta} | {ok:false,error}.
 * These cases lock the contract: valid, empty-but-valid, invalid enum, dangling
 * entity_ref, dangling source_event_ref, duplicate ref, non-snake_case attribute.
 */

import { describe, it, expect } from "vitest";
import { parseKbDelta, KbDeltaSchema } from "../extraction-schema.js";

/** A minimal, fully-valid KbDelta (decision → event + fact + relation). */
function validDelta(): unknown {
  return {
    language: "en",
    entities: [
      { ref: "e1", type: "project", name: "Sofia", aliases: ["sofia ai"], language: "en" },
      { ref: "e2", type: "person", name: "Lorenzo", aliases: [], language: "en" },
    ],
    facts: [
      {
        entity_ref: "e1",
        attribute: "iban_delivery",
        value: "post-call WhatsApp template",
        valid_from: "2026-06-05T10:00:00Z",
        confidence: 0.9,
        source_event_ref: "ev1",
      },
    ],
    events: [
      {
        ref: "ev1",
        type: "decision",
        ts: "2026-06-05T10:00:00Z",
        text: "Decided to defer IBAN collection to after the call.",
        entity_refs: ["e1", "e2"],
        source_message_ids: ["msg_a1"],
      },
    ],
    relations: [{ src_ref: "e2", type: "decided-in", dst_ref: "e1" }],
  };
}

describe("parseKbDelta — valid", () => {
  it("accepts a fully-valid delta and returns the typed object", () => {
    const res = parseKbDelta(validDelta());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.language).toBe("en");
    expect(res.delta.entities).toHaveLength(2);
    expect(res.delta.facts).toHaveLength(1);
    expect(res.delta.events).toHaveLength(1);
    expect(res.delta.relations).toHaveLength(1);
    expect(res.delta.facts[0].attribute).toBe("iban_delivery");
  });

  it("applies defaults (confidence=0.7, aliases=[], language=und)", () => {
    const res = parseKbDelta({
      entities: [{ ref: "e1", type: "bug", name: "booking-loop" }],
      facts: [{ entity_ref: "e1", attribute: "status", value: "open" }],
      events: [],
      relations: [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.language).toBe("und"); // top-level default
    expect(res.delta.entities[0].aliases).toEqual([]);
    expect(res.delta.entities[0].language).toBe("und");
    expect(res.delta.facts[0].confidence).toBe(0.7);
  });
});

describe("parseKbDelta — empty delta", () => {
  it("accepts a fully-empty (no-op) delta", () => {
    const res = parseKbDelta({
      language: "it",
      entities: [],
      facts: [],
      events: [],
      relations: [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.entities).toHaveLength(0);
    expect(res.delta.facts).toHaveLength(0);
    expect(res.delta.events).toHaveLength(0);
    expect(res.delta.relations).toHaveLength(0);
  });

  it("accepts {} and fills every array via defaults", () => {
    const res = parseKbDelta({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.entities).toEqual([]);
    expect(res.delta.facts).toEqual([]);
    expect(res.delta.events).toEqual([]);
    expect(res.delta.relations).toEqual([]);
  });
});

// RESILIENCE CONTRACT (changed in the extraction-quality fix): an out-of-
// vocabulary enum must NEVER nuke the whole window (that reject-behavior WAS
// the recurring MANGO total-loss bug — Kimi emits type:"secret_code", the old
// schema rejected the entire delta, the cursor held, nothing was ever stored).
// normalizeRawKbDelta now COERCES the high-churn vocab fields before strict
// structural validation. Structural errors (dangling/duplicate refs) still reject.
describe("parseKbDelta — vocabulary coercion (never total-loss)", () => {
  it("coerces an unknown entity type to 'concept' (the secret_code bug)", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.entities as Array<Record<string, unknown>>)[0].type = "secret_code";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.entities[0].type).toBe("concept");
  });

  it("coerces another unknown entity type ('alien') to 'concept'", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.entities as Array<Record<string, unknown>>)[0].type = "alien";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.entities[0].type).toBe("concept");
  });

  it("coerces an unknown event type to 'observation'", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.events as Array<Record<string, unknown>>)[0].type = "meltdown";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.events[0].type).toBe("observation");
  });

  it("coerces a relation with an unknown type to 'related-to' (never drop a link)", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.relations as Array<Record<string, unknown>>)[0].type = "loves";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.relations).toHaveLength(1); // kept, not dropped
    expect(res.delta.relations[0].type).toBe("related-to");
    expect(res.delta.entities).toHaveLength(2);
    expect(res.delta.facts).toHaveLength(1);
  });
});

describe("parseKbDelta — dangling entity_ref", () => {
  it("rejects a fact whose entity_ref is not a defined entity", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.facts as Array<Record<string, unknown>>)[0].entity_ref = "e_nope";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/unknown entity ref "e_nope"/);
  });

  it("rejects an event entity_refs entry that is not a defined entity", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.events as Array<Record<string, unknown>>)[0].entity_refs = ["e1", "e_ghost"];
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/unknown entity ref "e_ghost"/);
  });

  it("DROPS a relation whose src_ref/dst_ref is not a defined entity (window survives, not a total reject)", () => {
    // Resilience: Kimi sometimes targets an event ref / undefined ref in a
    // relation. That dangling edge is dropped so the window keeps its
    // entities/facts/events — relations are auxiliary; a fact/event dangling ref
    // still rejects (those are load-bearing).
    const d = validDelta() as Record<string, unknown>;
    (d.relations as Array<Record<string, unknown>>)[0].dst_ref = "e_missing";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.relations).toHaveLength(0); // the single dangling edge was dropped
    expect(res.delta.entities).toHaveLength(2);
    expect(res.delta.facts).toHaveLength(1);
    expect(res.delta.events).toHaveLength(1);
  });
});

describe("parseKbDelta — dangling source_event_ref", () => {
  it("rejects a fact whose source_event_ref is not a defined event", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.facts as Array<Record<string, unknown>>)[0].source_event_ref = "ev_nope";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/unknown event ref "ev_nope"/);
  });
});

describe("parseKbDelta — duplicate ref", () => {
  it("rejects two entities with the same ref label", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.entities as Array<Record<string, unknown>>)[1].ref = "e1"; // collide with e1
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/duplicate entity ref "e1"/);
  });

  it("rejects two events with the same ref label", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.events as Array<Record<string, unknown>>).push({
      ref: "ev1", // collide
      type: "fix",
      ts: "2026-06-05T11:00:00Z",
      text: "Applied the fix.",
      entity_refs: ["e1"],
      source_message_ids: ["msg_a2"],
    });
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/duplicate event ref "ev1"/);
  });
});

// Attribute keys are language-neutral English snake_case. Rather than reject a
// fact (data loss) when the model emits camelCase / spaces / punctuation,
// normalizeRawKbDelta coerces the key to valid snake_case.
describe("parseKbDelta — attribute coercion to snake_case", () => {
  it("coerces camelCase → snake_case (ibanDelivery → iban_delivery)", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.facts as Array<Record<string, unknown>>)[0].attribute = "ibanDelivery";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.facts[0].attribute).toBe("iban_delivery");
  });

  it("prefixes an attribute that starts with a digit (1st_status → v_1st_status)", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.facts as Array<Record<string, unknown>>)[0].attribute = "1st_status";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.facts[0].attribute).toBe("v_1st_status");
  });

  it("coerces hyphen/space → underscore (default-branch → default_branch)", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.facts as Array<Record<string, unknown>>)[0].attribute = "default-branch";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.facts[0].attribute).toBe("default_branch");
  });

  it("coerces a mixed-script attribute by stripping non-latin ('verifica موفق' → 'verifica')", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.facts as Array<Record<string, unknown>>)[0].attribute = "verifica موفق";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delta.facts[0].attribute).toBe("verifica");
  });
});

describe("parseKbDelta — never throws on garbage", () => {
  it("returns ok:false for non-object input (string)", () => {
    const res = parseKbDelta("not an object" as unknown);
    expect(res.ok).toBe(false);
  });

  it("returns ok:false for null", () => {
    const res = parseKbDelta(null);
    expect(res.ok).toBe(false);
  });

  it("KbDeltaSchema is the same shape used by parseKbDelta", () => {
    // Sanity: schema parses the valid delta directly too.
    expect(KbDeltaSchema.safeParse(validDelta()).success).toBe(true);
  });
});
