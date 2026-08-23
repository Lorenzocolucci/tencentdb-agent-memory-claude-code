/**
 * The usefulness verdict must be HONEST — which mostly means it must refuse to
 * credit a memory when the evidence is an echo of the user's own words.
 */

import { describe, it, expect } from "vitest";
import { judgeMemoryUsage, judgeTurn, tokenize, DEFAULT_MIN_MATCHES } from "../recall-usage.js";

describe("judgeMemoryUsage", () => {
  it("credits a memory whose OWN vocabulary shows up in the reply", () => {
    const j = judgeMemoryUsage({
      memoryText: "[fact] gateway — tokenPath: la porta 8421 usa il file token in plugins/data",
      userText: "riavvia tutto",
      assistantText: "Ho riavviato: il gateway ascolta sulla porta 8421 e legge il tokenPath.",
    });
    expect(j.used).toBe(true);
    expect(j.matchedTokens).toContain("8421");
    expect(j.matchedTokens).toContain("tokenpath");
  });

  it("REFUSES to credit an echo of the user's own words", () => {
    // The user already said everything the memory says. A reply repeating it
    // proves nothing — this is the confound that would make every memory look
    // useful and the whole metric worthless.
    const j = judgeMemoryUsage({
      memoryText: "[event] Argus gira su Render con tre servizi",
      userText: "Argus gira su Render con tre servizi, giusto?",
      assistantText: "Sì, Argus gira su Render con tre servizi.",
    });
    expect(j.used).toBe(false);
    expect(j.matchedTokens).toEqual([]);
    expect(j.distinctiveTokens).toEqual([]);
  });

  it("does count an attribute NAME the user never used — it is real vocabulary", () => {
    // Honest consequence of the rule: "deploy" comes from the memory, not the
    // prompt, so it is evidence. Pinned so nobody silently filters it later.
    const j = judgeMemoryUsage({
      memoryText: "[fact] Argus — deploy: gira su Render con tre servizi",
      userText: "Argus gira su Render con tre servizi, giusto?",
      assistantText: "Sì. Il deploy usa Render.",
    });
    expect(j.distinctiveTokens).toEqual(["deploy"]);
    expect(j.matchedTokens).toEqual(["deploy"]);
    expect(j.used).toBe(false); // one token is still not enough
  });

  it("marks a memory that adds no vocabulary as UNJUDGEABLE, not as noise", () => {
    const j = judgeMemoryUsage({
      memoryText: "deploy Render servizi",
      userText: "parliamo di deploy Render servizi",
      assistantText: "certo",
    });
    expect(j.distinctiveTokens).toEqual([]);
    expect(j.used).toBe(false);
  });

  it("requires more than one distinctive token — one is coincidence", () => {
    const j = judgeMemoryUsage({
      memoryText: "[fact] progetto — percorso: C:/Argus/engine/lib/argus-memory.mjs supabase",
      userText: "dimmi qualcosa",
      assistantText: "Uso supabase da qualche parte.",
    });
    expect(j.matchedTokens).toEqual(["supabase"]);
    expect(j.used).toBe(false); // 1 < DEFAULT_MIN_MATCHES
    expect(DEFAULT_MIN_MATCHES).toBeGreaterThan(1);
  });

  it("is case- and path-tolerant", () => {
    const j = judgeMemoryUsage({
      memoryText: "il file src/core/kb/bug-working-set.ts contiene MAX_PAIRWISE_BUG_EVENTS",
      userText: "spiega",
      assistantText: "Guarda SRC/CORE/KB/BUG-WORKING-SET.TS e la costante max_pairwise_bug_events.",
    });
    expect(j.used).toBe(true);
  });

  it("never throws on empty input", () => {
    expect(judgeMemoryUsage({ memoryText: "", userText: "", assistantText: "" }).used).toBe(false);
    expect(judgeMemoryUsage({ memoryText: "  ", userText: "x", assistantText: "y" }).used).toBe(false);
  });

  it("drops stop-words and very short tokens so they cannot carry evidence", () => {
    const toks = tokenize("che non per con il di a supabase");
    expect(toks).not.toContain("il");
    expect(toks).not.toContain("di");
    const j = judgeMemoryUsage({
      memoryText: "che non per con come questo quello sono",
      userText: "ciao",
      assistantText: "che non per con come questo quello sono",
    });
    expect(j.used).toBe(false);
  });
});

describe("judgeTurn", () => {
  it("counts injected / used / unjudgeable separately", () => {
    const verdict = judgeTurn(
      [
        { ownerId: "m1", memoryText: "la porta 8421 e il tokenPath del gateway" },
        { ownerId: "m2", memoryText: "DeepInfra Qwen3-Embedding-4B a 1024 dimensioni" },
        { ownerId: "m3", memoryText: "parliamo del deploy" },
      ],
      "parliamo del deploy",
      "Il gateway sta sulla porta 8421 col tokenPath giusto.",
    );
    expect(verdict.injected).toBe(3);
    expect(verdict.used).toBe(1);
    expect(verdict.unjudgeable).toBe(1); // m3 adds nothing the user did not say
    expect(verdict.perMemory.find((m) => m.ownerId === "m1")?.used).toBe(true);
    expect(verdict.perMemory.find((m) => m.ownerId === "m2")?.used).toBe(false);
  });

  it("keeps the matched tokens so a verdict can be audited, not believed", () => {
    const v = judgeTurn(
      [{ ownerId: "m1", memoryText: "vectors.db pesa 2,76 GB e sta in tdai-memory-tdai-local" }],
      "quanto pesa",
      "Il file vectors.db sta in tdai-memory-tdai-local.",
    );
    expect(v.perMemory[0].matchedTokens.length).toBeGreaterThanOrEqual(2);
    expect(v.perMemory[0].matchedTokens).toContain("vectors.db");
  });

  it("handles an empty injection set", () => {
    const v = judgeTurn([], "x", "y");
    expect(v).toEqual({ injected: 0, used: 0, unjudgeable: 0, perMemory: [] });
  });
});
