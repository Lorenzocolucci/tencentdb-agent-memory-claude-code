/**
 * runKbRecall — la SITUAZIONE semina il recall (il ribaltamento associativo-first).
 *
 * PROVA NON CIRCOLARE del cuore dell'Incremento A: con un saluto che NON nomina
 * nulla ("Ciao Socio, dove eravamo?"), il ricordo giusto emerge lo stesso perché
 * la SITUAZIONE (le entità degli eventi recenti) semina lo spreading activation.
 * E lo fa con ZERO scansione vettoriale globale (System 1). Sul codice pre-wiring
 * i semi nascono dai match della query → vuoti → il ricordo NON emerge (RED).
 */
import { describe, it, expect, vi } from "vitest";
import { runKbRecall } from "../auto-recall.js";

const cfg: any = { recall: { maxResults: 5, rerank: false }, embedding: {} };

describe("runKbRecall — la situazione è l'indirizzo", () => {
  it("fa emergere un ricordo che il saluto non nomina, seminato dalla situazione, con vec=0", async () => {
    const vectorSpy = vi.fn(() => []);
    const seedsSeen: string[][] = [];
    const store = {
      searchKbFts: () => [],                 // cue-da-testo vuoto (il saluto non matcha)
      // niente queryEntitiesByTokens → entity-match vuoto
      searchKbVector: vectorSpy,             // NON deve essere chiamato sul path System 1
      listEventsBySession: (_sk: string) => [
        {
          id: "e1", ts: "2026-07-06T10:00:00Z", recorded_at: "", session_key: "sk",
          session_id: "prev", namespace: "default", project: "p", type: "decision",
          text: "lavoro recente", language: "und", entities: ["ent_sit"], source_message_ids: [],
        },
      ],
      associativeExpand: (seeds: string[]) => {
        seedsSeen.push(seeds);
        return seeds.includes("ent_sit")
          ? [{ owner_id: "fact_assoc", owner_kind: "fact", text: "il ricordo che il saluto non nomina", entity_id: "ent_sit", activation: 0.9 }]
          : [];
      },
    } as any;

    const results = await runKbRecall(
      "Ciao Socio, dove eravamo?", cfg, undefined, store, undefined, undefined,
      { sessionKey: "sk", namespace: "default" },
    );

    const ids = results.map((r) => r.owner_id);
    expect(ids).toContain("fact_assoc"); // venuto dalla SITUAZIONE, non dal testo
    expect(results.find((r) => r.owner_id === "fact_assoc")?.associative).toBe(true);
    expect(seedsSeen.some((s) => s.includes("ent_sit"))).toBe(true); // la situazione ha seminato
    expect(vectorSpy).not.toHaveBeenCalled(); // nessuna scansione O(N) su System 1
  });

  it("senza semi-situazione (nessun evento pregresso): niente scansione vettoriale, non lancia", async () => {
    const vectorSpy = vi.fn(() => []);
    const store = {
      searchKbFts: () => [],
      searchKbVector: vectorSpy,
      listEventsBySession: () => [],
      associativeExpand: () => [],
    } as any;
    const results = await runKbRecall(
      "qualcosa", cfg, undefined, store, undefined, undefined,
      { sessionKey: "sk", namespace: "default" },
    );
    expect(Array.isArray(results)).toBe(true);
    expect(vectorSpy).not.toHaveBeenCalled();
  });
});
