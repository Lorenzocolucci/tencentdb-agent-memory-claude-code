/**
 * runKbRecall — rinforzo Hebbian (Incremento B2a): "ogni richiamo rinforza".
 *
 * I ricordi emersi PER ASSOCIAZIONE (spreading activation) sono i "un ricordo tira
 * l'altro": vengono rinforzati (lifecycle → permanence/promozione) così resistono al
 * decay e si consolidano. Bounded (top-3, per non rinforzare tutto ogni turno) e
 * best-effort (un fallimento del rinforzo NON rompe mai il recall).
 */
import { describe, it, expect } from "vitest";
import { runKbRecall } from "../auto-recall.js";

const cfg: any = { recall: { maxResults: 5, rerank: false }, embedding: {} };
const sitEvent = {
  id: "e1", ts: "2026-07-06T10:00:00Z", recorded_at: "", session_key: "sk", session_id: "prev",
  namespace: "default", project: "p", type: "decision", text: "x", language: "und",
  entities: ["ent_sit"], source_message_ids: [],
};

describe("runKbRecall — rinforzo Hebbian", () => {
  it("rinforza SOLO i top-3 ricordi associativi emersi (bounded)", async () => {
    const reinforced: Array<{ owner_id: string; owner_kind: string }> = [];
    const store = {
      searchKbFts: () => [],
      searchKbVector: () => [],
      listEventsBySession: () => [sitEvent],
      associativeExpand: () => [
        { owner_id: "f1", owner_kind: "fact", text: "a", entity_id: "e1", activation: 0.9 },
        { owner_id: "f2", owner_kind: "fact", text: "b", entity_id: "e2", activation: 0.7 },
        { owner_id: "f3", owner_kind: "fact", text: "c", entity_id: "e3", activation: 0.5 },
        { owner_id: "f4", owner_kind: "fact", text: "d", entity_id: "e4", activation: 0.3 },
        { owner_id: "f5", owner_kind: "fact", text: "e", entity_id: "e5", activation: 0.1 },
      ],
      reinforceRecalledOwners: (owners: Array<{ owner_id: string; owner_kind: string }>) => {
        reinforced.push(...owners);
        return owners.length;
      },
    } as any;
    const results = await runKbRecall("Ciao", cfg, undefined, store, undefined, undefined, { sessionKey: "sk", namespace: "default" });
    expect(reinforced.map((o) => o.owner_id)).toEqual(["f1", "f2", "f3"]); // i 3 più forti
    expect(results.length).toBeGreaterThanOrEqual(5); // il recall restituisce tutto
  });

  it("nessun ricordo associativo → nessun rinforzo (non rinforza i query-match)", async () => {
    const calls: unknown[] = [];
    const store = {
      searchKbFts: () => [],
      listEventsBySession: () => [], // niente semi-situazione → niente associativi
      associativeExpand: () => [],
      reinforceRecalledOwners: (owners: unknown[]) => { calls.push(...owners); return owners.length; },
    } as any;
    await runKbRecall("Ciao", cfg, undefined, store, undefined, undefined, { sessionKey: "sk", namespace: "default" });
    expect(calls.length).toBe(0);
  });

  it("una reinforce che lancia NON rompe il recall (best-effort)", async () => {
    const store = {
      searchKbFts: () => [],
      listEventsBySession: () => [sitEvent],
      associativeExpand: () => [{ owner_id: "f1", owner_kind: "fact", text: "a", entity_id: "e1", activation: 0.9 }],
      reinforceRecalledOwners: () => { throw new Error("boom"); },
    } as any;
    const results = await runKbRecall("Ciao", cfg, undefined, store, undefined, undefined, { sessionKey: "sk", namespace: "default" });
    expect(results.map((r) => r.owner_id)).toContain("f1"); // il recall è sopravvissuto
  });
});
