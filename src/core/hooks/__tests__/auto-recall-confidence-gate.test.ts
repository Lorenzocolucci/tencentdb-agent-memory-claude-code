/**
 * runKbRecall — le DUE MARCE (Incremento B1).
 *
 * Marcia 1 (veloce): passata associativa poco profonda dalla situazione.
 * Gate di confidenza: se il risultato è MAGRO → marcia 2 "a sforzo" = passata
 * associativa PIÙ PROFONDA (hops=3, vicinato più largo) — sempre O(vicinato),
 * MAI scansione globale. Se il recall è già ricco, la passata profonda NON scatta
 * (niente latenza inutile — il contrario di A sarebbe un bug).
 */
import { describe, it, expect, vi } from "vitest";
import { runKbRecall } from "../auto-recall.js";

const cfg: any = { recall: { maxResults: 5, rerank: false }, embedding: {} };

function storeWith(shallow: Array<{ owner_id: string; owner_kind: string; text: string; entity_id: string; activation: number }>) {
  const calls: Array<{ hops?: number; maxNodes?: number }> = [];
  const vectorSpy = vi.fn(() => []);
  const store = {
    searchKbFts: () => [],
    searchKbVector: vectorSpy,
    listEventsBySession: () => [
      { id: "e1", ts: "2026-07-06T10:00:00Z", recorded_at: "", session_key: "sk", session_id: "prev", namespace: "default", project: "p", type: "decision", text: "x", language: "und", entities: ["ent_sit"], source_message_ids: [] },
    ],
    associativeExpand: (_seeds: string[], opts?: { hops?: number; maxNodes?: number }) => {
      calls.push(opts ?? {});
      if (opts?.hops === 3) {
        return [{ owner_id: "fact_deep", owner_kind: "fact", text: "ricordo profondo", entity_id: "ent_deep", activation: 0.7 }];
      }
      return shallow;
    },
  } as any;
  return { store, calls, vectorSpy };
}

describe("runKbRecall — gate di confidenza → passata profonda a sforzo", () => {
  it("recall MAGRO → escala alla passata profonda (hops=3), senza scansione globale", async () => {
    // shallow = 1 solo risultato debole → thin
    const { store, calls, vectorSpy } = storeWith([
      { owner_id: "fact_weak", owner_kind: "fact", text: "debole", entity_id: "ent_sit", activation: 0.1 },
    ]);
    const results = await runKbRecall("Ciao", cfg, undefined, store, undefined, undefined, { sessionKey: "sk", namespace: "default" });
    expect(calls.some((o) => o.hops === 3)).toBe(true); // marcia 2 scattata
    expect(results.map((r) => r.owner_id)).toContain("fact_deep"); // il profondo è emerso
    expect(vectorSpy).not.toHaveBeenCalled(); // sempre O(vicinato), mai globale
  });

  it("recall RICCO → NON scala (niente passata profonda, niente latenza inutile)", async () => {
    // shallow = 3 risultati con uno forte → non thin
    const { store, calls } = storeWith([
      { owner_id: "f1", owner_kind: "fact", text: "a", entity_id: "e1", activation: 0.6 },
      { owner_id: "f2", owner_kind: "fact", text: "b", entity_id: "e2", activation: 0.3 },
      { owner_id: "f3", owner_kind: "fact", text: "c", entity_id: "e3", activation: 0.2 },
    ]);
    const results = await runKbRecall("Ciao", cfg, undefined, store, undefined, undefined, { sessionKey: "sk", namespace: "default" });
    expect(calls.some((o) => o.hops === 3)).toBe(false); // marcia 2 NON scattata
    expect(results.map((r) => r.owner_id)).not.toContain("fact_deep");
  });
});
