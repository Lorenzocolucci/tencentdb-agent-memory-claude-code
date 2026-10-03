/**
 * Prompts are Italian or English, memories are both: "idempotency" in the prompt must
 * meet "idempotenza" in the memory, "deployment" must meet "deployed". With a stem length N,
 * a prompt word longer than N also matches any memory word sharing its first N letters.
 * N = 0 keeps exact whole-word matching. The FTS query asks for the same prefix.
 */
import { describe, expect, it } from "vitest";
import { evidencePoints, selectiveFtsQuery } from "../selective-recall.js";

describe("stem matching in evidence points", () => {
  const none = new Set<string>();

  it("matches a cross-language variant sharing the first N letters", () => {
    expect(evidencePoints(["idempotency"], "Deciso idempotenza su sid", none)).toBe(0);
    expect(evidencePoints(["idempotency"], "Deciso idempotenza su sid", none, undefined, 7)).toBe(1);
    expect(evidencePoints(["deployment"], "worker deployed on render", none, undefined, 6)).toBe(1);
  });

  it("does not stem words not longer than N, nor match shorter memory words", () => {
    expect(evidencePoints(["render"], "rendering pipeline", none, undefined, 6)).toBe(0); // "render" is not longer than 6
    expect(evidencePoints(["configuration"], "config file", none, undefined, 7)).toBe(0); // "config" < 7 letters
  });

  it("counts a prompt word once even when several memory words share its stem", () => {
    expect(evidencePoints(["idempotency"], "idempotenza idempotente idempotent", none, undefined, 7)).toBe(1);
  });
});

describe("selectiveFtsQuery", () => {
  it("is the plain OR of quoted words without stemming", () => {
    expect(selectiveFtsQuery(["waba", "idempotency"], 0)).toBe('"waba" OR "idempotency"');
  });

  it("adds a prefix term for words longer than the stem", () => {
    expect(selectiveFtsQuery(["waba", "idempotency"], 7)).toBe('"waba" OR "idempotency" OR "idempot"*');
  });

  it("strips quotes and returns null for nothing", () => {
    expect(selectiveFtsQuery(['wa"ba'], 0)).toBe('"waba"');
    expect(selectiveFtsQuery([], 6)).toBeNull();
  });
});
