import { describe, it, expect } from "vitest";
import {
  defaultProvenance,
  deriveTrust,
  parseProvenance,
  serializeProvenance,
  type ProvenanceStamp,
} from "../provenance.js";

describe("provenance model", () => {
  it("defaultProvenance is conversation/unverified and carries source ids", () => {
    const p = defaultProvenance(["l0_a", "l0_b"]);
    expect(p.origin).toBe("conversation");
    expect(p.trust).toBe("unverified");
    expect(p.confirmed_by).toBeNull();
    expect(p.source_message_ids).toEqual(["l0_a", "l0_b"]);
    expect(p.schema).toBe(1);
  });

  it("deriveTrust: only lorenzo_confirmed and authoritative_source are trusted", () => {
    expect(deriveTrust("conversation")).toBe("unverified");
    expect(deriveTrust("tool_output")).toBe("unverified");
    expect(deriveTrust("lorenzo_confirmed")).toBe("trusted");
    expect(deriveTrust("authoritative_source")).toBe("trusted");
  });

  it("parseProvenance tolerates legacy '{}' → conversation/unverified", () => {
    const p = parseProvenance("{}");
    expect(p.origin).toBe("conversation");
    expect(p.trust).toBe("unverified");
  });

  it("parseProvenance tolerates garbage → conversation/unverified (never throws)", () => {
    const p = parseProvenance("not json at all");
    expect(p.origin).toBe("conversation");
    expect(p.trust).toBe("unverified");
  });

  it("serialize → parse round-trips a trusted stamp", () => {
    const stamp: ProvenanceStamp = {
      origin: "lorenzo_confirmed",
      trust: "trusted",
      confirmed_by: "lorenzo",
      confirmed_at: "2026-06-29T10:00:00.000Z",
      source_message_ids: ["l0_x"],
      schema: 1,
    };
    const back = parseProvenance(serializeProvenance(stamp));
    expect(back).toEqual(stamp);
  });
});
