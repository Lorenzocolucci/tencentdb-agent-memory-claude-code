/**
 * Live 05/10/2026: the "DOVE ERAVAMO" session recaps (282 events, some in 4 identical
 * copies) were ranked as ordinary memories — an 8-line recap took the slot of the real
 * answer and duplicated the <session-recap> block that already carries it.
 */
import { describe, it, expect } from "vitest";
import { kbRecallSelective } from "../retrieval-selective.js";
import { parseConfig } from "../../../config.js";

const NOW_MS = Date.parse("2026-10-05T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SEL = { ...parseConfig({}).recall.selective!, recentEventDays: 14, recentEventMinPoints: 1 };

interface Ev { id: string; text: string; type: string }

function fakeStore(events: Ev[]) {
  const row = (e: Ev) => ({ ...e, ts: iso(NOW_MS - 3_600_000), project: "Argus", entities: [] as string[] });
  return {
    searchKbFts: () => events.map((e) => ({ owner_id: e.id, owner_kind: "event", score: 0.9, content: "", entity_type: "", namespace: "default", attribute: "" })),
    queryEntitiesByTokens: () => [],
    queryHeadFacts: () => [],
    queryEventById: (id: string) => { const e = events.find((x) => x.id === id); return e ? row(e) : null; },
    queryFactById: () => null,
    queryEntityById: () => null,
    rareKbTokens: () => new Set<string>(),
    recentProjectEvents: () => events.map(row),
    getOwnerProjects: (owners: Array<{ owner_id: string; owner_kind: string }>) =>
      new Map(owners.map((o) => [`${o.owner_kind}:${o.owner_id}`, { project: "Argus", userLevel: false }])),
  } as never;
}

describe("session recaps are not recalled as ordinary memories", () => {
  it("a recap matching the prompt is dropped; the real event with the same words stays", async () => {
    const store = fakeStore([
      { id: "recap", type: "session_recap", text: "DOVE ERAVAMO — Argus\nPROSSIMO PASSO: worker deploy render sistemato" },
      { id: "real", type: "fix", text: "worker deploy render sistemato con il nuovo start command" },
    ]);
    const out = await kbRecallSelective("worker deploy render sistemato", { store, selective: SEL, skipVector: true, project: "Argus", nowMs: NOW_MS });
    expect(out.map((r) => r.owner_id)).toEqual(["real"]);
  });
});
