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

describe("parseKbDelta — invalid enum", () => {
  it("rejects an unknown entity type", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.entities as Array<Record<string, unknown>>)[0].type = "alien";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/entities\.0\.type/);
  });

  it("rejects an unknown event type", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.events as Array<Record<string, unknown>>)[0].type = "meltdown";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/events\.0\.type/);
  });

  it("rejects an unknown relation type", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.relations as Array<Record<string, unknown>>)[0].type = "loves";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/relations\.0\.type/);
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

  it("rejects a relation src_ref/dst_ref that is not a defined entity", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.relations as Array<Record<string, unknown>>)[0].dst_ref = "e_missing";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/unknown entity ref "e_missing"/);
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

describe("parseKbDelta — non-snake_case attribute", () => {
  it("rejects an attribute with uppercase / camelCase", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.facts as Array<Record<string, unknown>>)[0].attribute = "ibanDelivery";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/snake_case/);
  });

  it("rejects an attribute that starts with a digit", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.facts as Array<Record<string, unknown>>)[0].attribute = "1st_status";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/snake_case/);
  });

  it("rejects an attribute with a hyphen or space", () => {
    const d = validDelta() as Record<string, unknown>;
    (d.facts as Array<Record<string, unknown>>)[0].attribute = "default-branch";
    const res = parseKbDelta(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/snake_case/);
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
