import { describe, it, expect } from "vitest";
import {
  willingnessAfterConfirm,
  willingnessAfterReject,
  willingnessTier,
  WILLINGNESS_DEFAULT,
  WILLINGNESS_CAP,
  WILLINGNESS_FLOOR,
  SUPPRESS_BELOW,
  DEMOTE_BELOW,
} from "../stance-track-record.js";

describe("willingness dynamics", () => {
  it("confirm raises with diminishing returns, never above the cap", () => {
    const a = willingnessAfterConfirm(WILLINGNESS_DEFAULT);
    expect(a).toBeGreaterThan(WILLINGNESS_DEFAULT);
    expect(a).toBeLessThanOrEqual(WILLINGNESS_CAP);
    // diminishing: gain from a high value is smaller than from a low value
    const gainHigh = willingnessAfterConfirm(0.9) - 0.9;
    const gainLow = willingnessAfterConfirm(0.3) - 0.3;
    expect(gainLow).toBeGreaterThan(gainHigh);
  });

  it("reject lowers, floored — never fully erased", () => {
    let w = WILLINGNESS_DEFAULT;
    for (let i = 0; i < 50; i++) w = willingnessAfterReject(w);
    expect(w).toBeGreaterThanOrEqual(WILLINGNESS_FLOOR);
    expect(w).toBeLessThan(SUPPRESS_BELOW);
  });

  it("a few false alarms SUPPRESS a fresh stance (cry-wolf silences itself)", () => {
    let w = WILLINGNESS_DEFAULT;
    w = willingnessAfterReject(w); // 1
    w = willingnessAfterReject(w); // 2
    w = willingnessAfterReject(w); // 3
    expect(willingnessTier(w)).toBe("suppressed");
  });

  it("SYMMETRIC: a suppressed stance can climb back with confirmations", () => {
    let w = 0.7;
    w = willingnessAfterReject(w);
    w = willingnessAfterReject(w);
    w = willingnessAfterReject(w);
    expect(willingnessTier(w)).toBe("suppressed");
    // Later vindicated repeatedly → rises out of suppression.
    for (let i = 0; i < 4; i++) w = willingnessAfterConfirm(w);
    expect(willingnessTier(w)).not.toBe("suppressed");
  });

  it("tiers: suppressed < SUPPRESS_BELOW ≤ demoted < DEMOTE_BELOW ≤ trusted", () => {
    expect(willingnessTier(SUPPRESS_BELOW - 0.01)).toBe("suppressed");
    expect(willingnessTier(SUPPRESS_BELOW)).toBe("demoted");
    expect(willingnessTier(DEMOTE_BELOW - 0.01)).toBe("demoted");
    expect(willingnessTier(DEMOTE_BELOW)).toBe("trusted");
    expect(willingnessTier(WILLINGNESS_DEFAULT)).toBe("trusted");
  });

  it("total: NaN/garbage clamps to floor, never throws", () => {
    expect(willingnessAfterConfirm(NaN)).toBeGreaterThanOrEqual(WILLINGNESS_FLOOR);
    expect(willingnessAfterReject(Infinity)).toBeLessThanOrEqual(WILLINGNESS_CAP);
    expect(willingnessTier(NaN)).toBe("suppressed");
  });
});
