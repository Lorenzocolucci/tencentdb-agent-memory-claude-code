/**
 * situation-cue — dalla SITUAZIONE ai semi dello spreading activation.
 *
 * Il recall associativo-first parte dalla situazione (dove eravamo + fingerprint
 * + file recenti), NON dal testo della query. Questi test verificano la
 * traduzione situazione→semi: union degli eventi recenti + owner dei fingerprint,
 * deduplicati; cap; e la garanzia che NON lancia mai (la memoria non rompe la
 * conversazione). Forma-dati REALE (KbEvent.entities, StoredFingerprint.matchedOwnerIds).
 */
import { describe, it, expect } from "vitest";
import { buildSituationSeeds } from "../situation-cue.js";
import type { IMemoryStore, KbEvent } from "../../store/types.js";

const evt = (o: Partial<KbEvent>): KbEvent => ({
  id: "e", ts: "2026-07-06T10:00:00Z", recorded_at: "", session_key: "sk",
  session_id: "s", namespace: "default", project: "p", type: "decision",
  text: "", language: "und", entities: [], source_message_ids: [], ...o,
});

function fakeStore(over: Partial<IMemoryStore> = {}): IMemoryStore {
  return {
    listEventsBySession: () => [
      evt({ id: "e1", ts: "2026-07-06T10:00:00Z", entities: ["ent_a", "ent_b"] }),
      evt({ id: "e2", ts: "2026-07-06T10:01:00Z", entities: ["ent_b"] }), // ent_b twice → dedup
    ],
    queryContextFingerprints: () => [
      { matchedOwnerIds: ["ent_c"] } as any,
    ],
    queryEntityById: (id: string) => ({ id, name: id, type: "concept" } as any),
    ...over,
  } as unknown as IMemoryStore;
}

describe("buildSituationSeeds", () => {
  it("unions entities of recent events + fingerprint owners, deduped", () => {
    const seeds = buildSituationSeeds(fakeStore(), { sessionKey: "sk", namespace: "default" });
    const ids = seeds.map((s) => s.id);
    expect(ids).toContain("ent_a"); // from recent events
    expect(ids).toContain("ent_b");
    expect(ids).toContain("ent_c"); // from fingerprint
    // dedup: ent_b appears once
    expect(ids.filter((x) => x === "ent_b")).toHaveLength(1);
    // every seed carries a positive weight and a source tag
    expect(seeds.every((s) => s.weight > 0 && s.source)).toBe(true);
  });

  it("returns [] and never throws when every source fails", () => {
    const store = {
      listEventsBySession: () => { throw new Error("boom"); },
      queryContextFingerprints: () => { throw new Error("boom"); },
    } as unknown as IMemoryStore;
    expect(() => buildSituationSeeds(store, { sessionKey: "sk", namespace: "default" })).not.toThrow();
    expect(buildSituationSeeds(store, { sessionKey: "sk", namespace: "default" })).toEqual([]);
  });

  it("caps total seeds to at most 24, strongest first", () => {
    const many: KbEvent[] = Array.from({ length: 100 }, (_, i) =>
      evt({ id: `e${i}`, ts: `2026-07-06T10:${String(i).padStart(2, "0")}:00Z`, entities: [`ent_${i}`] }),
    );
    const store = { listEventsBySession: () => many } as unknown as IMemoryStore;
    const seeds = buildSituationSeeds(store, { sessionKey: "sk", namespace: "default" });
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds.length).toBeLessThanOrEqual(24);
  });

  it("empty store (no optional methods) → [] without throwing", () => {
    const store = {} as unknown as IMemoryStore;
    expect(buildSituationSeeds(store, { sessionKey: "sk", namespace: "default" })).toEqual([]);
  });
});
