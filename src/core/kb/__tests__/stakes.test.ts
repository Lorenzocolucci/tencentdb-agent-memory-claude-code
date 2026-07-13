import { describe, it, expect } from "vitest";
import {
  classifyOperativeStakes,
  classifyVisionStakes,
  classifyStakes,
  shouldGate,
  VISION_DISTINCTIVENESS_THRESHOLD,
} from "../stakes.js";

describe("stakes — operative branch (content classification)", () => {
  it("payment: an IBAN is high/payment", () => {
    const r = classifyOperativeStakes("the IBAN of Sofia is IT60X0542811101000000123456");
    expect(r.stakes).toBe("high");
    expect(r.stakes_domain).toBe("payment");
  });

  it("credential: a raw secret is high/credential", () => {
    const r = classifyOperativeStakes("the api key is sk-proj-ABCDEFGHIJKLMNOP1234");
    expect(r.stakes).toBe("high");
    expect(r.stakes_domain).toBe("credential");
  });

  it("credential: an already-redacted marker is high/credential (recall path)", () => {
    const r = classifyOperativeStakes("the token is [REDACTED:api-key]");
    expect(r.stakes).toBe("high");
    expect(r.stakes_domain).toBe("credential");
  });

  it("destructive: rm -rf is high/destructive", () => {
    const r = classifyOperativeStakes("then run rm -rf /var/data to reset");
    expect(r.stakes).toBe("high");
    expect(r.stakes_domain).toBe("destructive");
  });

  it("destructive: DROP TABLE is high/destructive", () => {
    const r = classifyOperativeStakes("we fixed it with DROP TABLE users;");
    expect(r.stakes).toBe("high");
    expect(r.stakes_domain).toBe("destructive");
  });

  it("prod: a force-push to main is high/prod", () => {
    const r = classifyOperativeStakes("git push --force origin main");
    expect(r.stakes).toBe("high");
    expect(r.stakes_domain).toBe("prod");
  });

  it("benign prose is none", () => {
    const r = classifyOperativeStakes("Lorenzo prefers Italian in chat and English in code");
    expect(r.stakes).toBe("none");
    expect(r.stakes_domain).toBeNull();
  });

  it("a style preference is none (control — must not flood)", () => {
    const r = classifyOperativeStakes("use two-space indentation and small files");
    expect(r.stakes).toBe("none");
    expect(r.stakes_domain).toBeNull();
  });
});

describe("stakes — vision branch (weight, not pattern)", () => {
  const hi = VISION_DISTINCTIVENESS_THRESHOLD + 0.05;
  const lo = VISION_DISTINCTIVENESS_THRESHOLD - 0.05;

  it("a weighty decision (decision + distinctiveness >= τ) is high/vision", () => {
    const r = classifyVisionStakes({ eventType: "decision", distinctiveness: hi }, false);
    expect(r.stakes).toBe("high");
    expect(r.stakes_domain).toBe("vision");
  });

  it("the same decision below τ is none (τ keeps trivia out)", () => {
    const r = classifyVisionStakes({ eventType: "decision", distinctiveness: lo }, false);
    expect(r.stakes).toBe("none");
    expect(r.stakes_domain).toBeNull();
  });

  it("a high-distinctiveness NON-decision is none (kind matters)", () => {
    const r = classifyVisionStakes({ eventType: "observation", distinctiveness: hi }, false);
    expect(r.stakes).toBe("none");
    expect(r.stakes_domain).toBeNull();
  });

  it("a weighty decision that ALSO hit the operative classifier yields none (operative wins upstream)", () => {
    const r = classifyVisionStakes({ eventType: "decision", distinctiveness: hi }, true);
    expect(r.stakes).toBe("none");
    expect(r.stakes_domain).toBeNull();
  });
});

describe("stakes — classifyStakes composite (operative wins ties)", () => {
  it("a decision text that contains an IBAN classifies as payment, not vision", () => {
    const r = classifyStakes({
      content: "we decided the payout IBAN is IT60X0542811101000000123456",
      eventType: "decision",
      distinctiveness: 0.99,
    });
    expect(r.stakes).toBe("high");
    expect(r.stakes_domain).toBe("payment");
  });

  it("a weighty pure-vision decision (no operative hit) classifies as vision", () => {
    const r = classifyStakes({
      content: "we decided to abandon Track B and focus the north star on Proactive Injection",
      eventType: "decision",
      distinctiveness: 0.99,
    });
    expect(r.stakes).toBe("high");
    expect(r.stakes_domain).toBe("vision");
  });

  it("benign content with no signals is none", () => {
    const r = classifyStakes({ content: "the build is green", eventType: "observation", distinctiveness: 0.1 });
    expect(r.stakes).toBe("none");
    expect(r.stakes_domain).toBeNull();
  });
});

describe("stakes — shouldGate honors the three-AND rule", () => {
  const gated = { trust: "unverified" as const, stakes: "high" as const, gateState: "clear" as const };

  it("gates when unverified AND high AND clear", () => {
    expect(shouldGate(gated)).toBe(true);
  });

  it("does NOT gate a trusted memory (confirmed already)", () => {
    expect(shouldGate({ ...gated, trust: "trusted" })).toBe(false);
  });

  it("does NOT gate a low-stakes memory", () => {
    expect(shouldGate({ ...gated, stakes: "none" })).toBe(false);
  });

  it("does NOT re-gate a memory already pending or rejected", () => {
    expect(shouldGate({ ...gated, gateState: "pending_confirmation" })).toBe(false);
    expect(shouldGate({ ...gated, gateState: "rejected" })).toBe(false);
  });
});
