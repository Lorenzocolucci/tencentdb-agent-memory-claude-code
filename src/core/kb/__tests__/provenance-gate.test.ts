import { describe, it, expect } from "vitest";
import {
  defaultProvenance,
  parseProvenance,
  serializeProvenance,
  gateStateOf,
  stakesOf,
  withPendingGate,
  withRejectedGate,
} from "../provenance.js";

describe("provenance — Phase 2 gate fields (backward-compatible extension)", () => {
  it("a v1 default stamp has no gate fields; accessors default to clear/none", () => {
    const p = defaultProvenance(["l0_a"]);
    expect(p.schema).toBe(1);
    expect(gateStateOf(p)).toBe("clear");
    expect(stakesOf(p)).toBe("none");
  });

  it("withPendingGate marks pending_confirmation, stamps stakes, bumps schema to 2", () => {
    const p = withPendingGate(defaultProvenance(["l0_a"]), {
      stakes: "high",
      stakes_domain: "payment",
    });
    expect(p.gate_state).toBe("pending_confirmation");
    expect(p.stakes).toBe("high");
    expect(p.stakes_domain).toBe("payment");
    expect(p.schema).toBe(2);
    // does NOT pretend to be trusted — gate state ≠ trust
    expect(p.trust).toBe("unverified");
  });

  it("withRejectedGate marks rejected, records rejected_at, keeps the row's trust honest", () => {
    const pending = withPendingGate(defaultProvenance(["l0_a"]), {
      stakes: "high",
      stakes_domain: "vision",
    });
    const r = withRejectedGate(pending, "2026-06-30T10:00:00.000Z");
    expect(r.gate_state).toBe("rejected");
    expect(r.rejected_at).toBe("2026-06-30T10:00:00.000Z");
    expect(r.schema).toBe(2);
  });

  it("a v2 stamp round-trips through serialize/parse", () => {
    const p = withRejectedGate(
      withPendingGate(defaultProvenance(["l0_x"]), { stakes: "high", stakes_domain: "credential" }),
      "2026-06-30T11:00:00.000Z",
    );
    const back = parseProvenance(serializeProvenance(p));
    expect(gateStateOf(back)).toBe("rejected");
    expect(stakesOf(back)).toBe("high");
    expect(back.stakes_domain).toBe("credential");
    expect(back.rejected_at).toBe("2026-06-30T11:00:00.000Z");
  });

  it("parse of a legacy v1 row (no gate fields) still yields clear/none accessors", () => {
    const legacy = '{"origin":"conversation","trust":"unverified","confirmed_by":null,"confirmed_at":null,"source_message_ids":[],"schema":1}';
    const back = parseProvenance(legacy);
    expect(gateStateOf(back)).toBe("clear");
    expect(stakesOf(back)).toBe("none");
  });
});
