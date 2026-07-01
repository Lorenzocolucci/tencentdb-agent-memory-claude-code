import { describe, it, expect, vi } from "vitest";
import {
  buildPrinciplePrompt,
  parseDistilledPrinciple,
  distillPrinciple,
} from "../principle-distiller.js";
import type { LLMRunner } from "../../types.js";

const cluster = {
  project: "sofia",
  domainEntity: "ent_pricing",
  texts: ["prezzo a valore, non a ora", "di nuovo scelto valore su ora"],
};

describe("buildPrinciplePrompt", () => {
  it("carries every recurrence and the project", () => {
    const p = buildPrinciplePrompt(cluster);
    expect(p).toContain("sofia");
    expect(p).toContain("prezzo a valore");
    expect(p).toContain("di nuovo scelto valore");
  });
});

describe("parseDistilledPrinciple", () => {
  it("parses strict JSON", () => {
    const out = parseDistilledPrinciple('{"domain":"pricing","principle_text":"Prezza a valore.","confidence":0.8}');
    expect(out).toEqual({ domain: "pricing", principleText: "Prezza a valore.", confidence: 0.8 });
  });
  it("tolerates prose/fences around the JSON", () => {
    const out = parseDistilledPrinciple('sure:\n```json\n{"domain":"d","principle_text":"t","confidence":2}\n```');
    expect(out?.domain).toBe("d");
    expect(out?.confidence).toBe(1); // clamped
  });
  it("returns null on garbage or missing fields", () => {
    expect(parseDistilledPrinciple("not json")).toBeNull();
    expect(parseDistilledPrinciple('{"domain":"d"}')).toBeNull();
    expect(parseDistilledPrinciple("")).toBeNull();
  });
});

describe("distillPrinciple", () => {
  it("returns the parsed principle from the runner", async () => {
    const runner = { run: vi.fn().mockResolvedValue('{"domain":"pricing","principle_text":"Prezza a valore.","confidence":0.7}') } as unknown as LLMRunner;
    const out = await distillPrinciple(cluster, runner);
    expect(out?.principleText).toBe("Prezza a valore.");
  });
  it("never throws — returns null when the runner fails", async () => {
    const runner = { run: vi.fn().mockRejectedValue(new Error("timeout")) } as unknown as LLMRunner;
    await expect(distillPrinciple(cluster, runner)).resolves.toBeNull();
  });

  it("REJECTS a principle still in Chinese after the guard's rewrites (skip, no garbage)", async () => {
    // Model insists on CJK across every attempt → distiller returns null.
    const runner = { run: vi.fn().mockResolvedValue('{"domain":"项目","principle_text":"优先考虑灵活方案","confidence":0.9}') } as unknown as LLMRunner;
    await expect(distillPrinciple(cluster, runner)).resolves.toBeNull();
  });
});
