/**
 * kbRecallSelective — the query path of "silent unless useful", on a fake store so
 * each rule is isolated: distinctive words only, evidence gate with "inject nothing",
 * hub entities skipped, facts ranked by the prompt, ≤2 per entity, subject on every
 * line, excluded owners dropped.
 */
import { describe, it, expect, vi } from "vitest";
import { kbRecallSelective } from "../retrieval-selective.js";
import { parseConfig } from "../../../config.js";

const SEL = parseConfig({}).recall.selective!;
const NOW = new Date().toISOString();

interface FakeFact { id: string; entity_id: string; attribute: string; value: string; confidence?: number }
interface FakeEvent { id: string; text: string; entities: string[]; ts?: string }

function fakeStore(o: {
  entities?: Array<{ id: string; name: string }>;
  facts?: FakeFact[];
  events?: FakeEvent[];
  fts?: Array<{ owner_id: string; owner_kind: string; score: number }>;
  entityHits?: string[];
  rare?: string[];
}) {
  const facts = o.facts ?? [];
  const events = o.events ?? [];
  const entities = o.entities ?? [];
  const calls = { fts: vi.fn(), entities: vi.fn() };
  const store = {
    searchKbFts: (q: string) => { calls.fts(q); return (o.fts ?? []).map((r) => ({ ...r, content: "", entity_type: "", namespace: "default", attribute: "" })); },
    queryEntitiesByTokens: (t: string[]) => { calls.entities(t); return entities.filter((e) => (o.entityHits ?? []).includes(e.id)); },
    queryHeadFacts: (id: string) => facts.filter((f) => f.entity_id === id).map((f) => ({ ...f, confidence: f.confidence ?? 0.7, superseded_by: null, valid_to: null, valid_from: NOW, support: 1 })),
    queryEventsForEntity: (id: string) => events.filter((e) => e.entities.includes(id)).map((e) => ({ ...e, ts: e.ts ?? NOW })),
    queryFactById: (id: string) => { const f = facts.find((x) => x.id === id); return f ? { ...f, confidence: f.confidence ?? 0.7, superseded_by: null, valid_to: null, valid_from: NOW, support: 1 } : null; },
    queryEventById: (id: string) => { const e = events.find((x) => x.id === id); return e ? { ...e, ts: e.ts ?? NOW } : null; },
    queryEntityById: (id: string) => { const e = entities.find((x) => x.id === id); return e ? { ...e, importance: 50 } : null; },
    rareKbTokens: (tokens: string[]) => new Set(tokens.filter((t) => (o.rare ?? []).includes(t))),
  };
  return { store: store as never, calls };
}

describe("kbRecallSelective", () => {
  it("a prompt with no distinctive word retrieves nothing and touches no source", async () => {
    const { store, calls } = fakeStore({ fts: [{ owner_id: "e1", owner_kind: "event", score: 0.9 }] });
    expect(await kbRecallSelective("ok procedi, grazie", { store, selective: SEL, skipVector: true })).toEqual([]);
    expect(calls.fts).not.toHaveBeenCalled();
    expect(calls.entities).not.toHaveBeenCalled();
  });

  it("injects NOTHING when no candidate clears the evidence gate (one shared generic word)", async () => {
    const { store } = fakeStore({
      entities: [{ id: "A", name: "Alpha" }],
      events: [{ id: "e1", text: "problemi vari con il deploy", entities: ["A"] }],
      fts: [{ owner_id: "e1", owner_kind: "event", score: 0.9 }],
    });
    const out = await kbRecallSelective("abbiamo problemi nella cucina", { store, selective: SEL, skipVector: true });
    expect(out).toEqual([]);
  });

  it("returns a memory with enough shared evidence, subject-prefixed, with a real score ≥ τ", async () => {
    const { store } = fakeStore({
      entities: [{ id: "W", name: "WABA Meta" }],
      events: [{ id: "e1", text: "Creati 88 template sul nuovo WABA", entities: ["W"] }],
      fts: [{ owner_id: "e1", owner_kind: "event", score: 0.9 }],
      rare: ["waba"],
    });
    const out = await kbRecallSelective("ricrea i template del waba nuovo", { store, selective: SEL, skipVector: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("WABA Meta — Creati 88 template sul nuovo WABA");
    expect(out[0]!.score).toBeGreaterThanOrEqual(SEL.minRelevance);
    expect(out[0]!.score).toBeLessThanOrEqual(1);
  });

  it("hub entities are not seeds: a named entity with too many facts contributes nothing", async () => {
    const facts: FakeFact[] = Array.from({ length: SEL.hubFactThreshold + 1 }, (_, i) => ({ id: `h${i}`, entity_id: "HUB", attribute: `attr${i}`, value: "waba template nuovo" }));
    const { store } = fakeStore({ entities: [{ id: "HUB", name: "Sofia" }], facts, entityHits: ["HUB"], rare: ["waba"] });
    expect(await kbRecallSelective("waba template nuovo", { store, selective: SEL, skipVector: true })).toEqual([]);
  });

  it("an anchored entity ranks its facts by the prompt (not A→Z) and keeps at most 2", async () => {
    const facts: FakeFact[] = [
      { id: "f1", entity_id: "T", attribute: "aaa_unrelated", value: "niente", confidence: 0.99 },
      { id: "f2", entity_id: "T", attribute: "status", value: "template waba nuovo approvato" },
      { id: "f3", entity_id: "T", attribute: "note", value: "template waba creati" },
      { id: "f4", entity_id: "T", attribute: "zzz", value: "template waba nuovo approvato creati" },
    ];
    const { store } = fakeStore({ entities: [{ id: "T", name: "Templates" }], facts, entityHits: ["T"], rare: ["waba"] });
    const out = await kbRecallSelective("template waba nuovo approvato creati", { store, selective: SEL, skipVector: true });
    expect(out.length).toBeLessThanOrEqual(SEL.maxFactsPerEntity);
    expect(out.map((r) => r.owner_id)).toContain("f4"); // the one most about the prompt, though last A→Z
    expect(out.map((r) => r.owner_id)).not.toContain("f1");
  });

  it("drops owners the caller excluded (other project, chronic noise, shown recently)", async () => {
    const { store } = fakeStore({
      entities: [{ id: "W", name: "WABA" }],
      events: [{ id: "e1", text: "template waba nuovo creati", entities: ["W"] }, { id: "e2", text: "template waba nuovo creati davvero", entities: [] }],
      fts: [{ owner_id: "e1", owner_kind: "event", score: 0.9 }, { owner_id: "e2", owner_kind: "event", score: 0.9 }],
      rare: ["waba"],
    });
    const out = await kbRecallSelective("template waba nuovo creati", {
      store, selective: SEL, skipVector: true,
      excludeOwners: () => new Set(["event:e1"]),
    });
    expect(out.map((r) => r.owner_id)).toEqual(["e2"]);
  });

  it("never exceeds maxLines", async () => {
    const events: FakeEvent[] = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, text: `template waba nuovo creati numero ${i}`, entities: [] }));
    const { store } = fakeStore({ events, fts: events.map((e) => ({ owner_id: e.id, owner_kind: "event", score: 0.9 })), rare: ["waba"] });
    const out = await kbRecallSelective("template waba nuovo creati", { store, selective: SEL, skipVector: true });
    expect(out.length).toBe(SEL.maxLines);
  });
});
