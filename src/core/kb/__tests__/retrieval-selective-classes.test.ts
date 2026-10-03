/**
 * kbRecallSelective with the project-aware evidence bars (2026-10-03 recall tuning):
 *   - the recent-project-work source brings the current project's fresh events in even
 *     when no global source ranks them, and one shared word is enough for them;
 *   - an old event of the project, or another project's, gets no such discount;
 *   - a memory with no project label needs strong evidence or an anchor;
 *   - the clock is injectable (replays run at the prompt's time).
 */
import { describe, it, expect } from "vitest";
import { kbRecallSelective } from "../retrieval-selective.js";
import { parseConfig } from "../../../config.js";

const NOW_MS = Date.parse("2026-09-20T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SEL = {
  ...parseConfig({}).recall.selective!,
  recentEventDays: 14,
  recentEventMinPoints: 1,
  unknownProjectMinPoints: 6,
};

interface Ev { id: string; text: string; ts: string; project: string; entities?: string[] }
interface Fa { id: string; entity_id: string; attribute: string; value: string; project: string }

function fakeStore(o: { events?: Ev[]; facts?: Fa[]; fts?: Array<{ owner_id: string; owner_kind: string; score: number }>; rare?: string[]; df?: Record<string, number> }) {
  const events = o.events ?? [];
  const facts = o.facts ?? [];
  const recentCalls: Array<{ project: string; beforeIso: string; sinceIso: string }> = [];
  const ftsQueries: string[] = [];
  const store = {
    searchKbFts: (q: string) => {
      ftsQueries.push(q);
      return (o.fts ?? []).map((r) => ({ ...r, content: "", entity_type: "", namespace: "default", attribute: "" }));
    },
    queryEntitiesByTokens: () => [],
    queryHeadFacts: () => [],
    queryEventById: (id: string) => {
      const e = events.find((x) => x.id === id);
      return e ? { ...e, entities: e.entities ?? [] } : null;
    },
    queryFactById: (id: string) => {
      const f = facts.find((x) => x.id === id);
      return f ? { ...f, confidence: 0.7, superseded_by: null, valid_to: null, valid_from: iso(NOW_MS - DAY), support: 1 } : null;
    },
    queryEntityById: () => null,
    rareKbTokens: (t: string[], maxDocs: number) =>
      new Set(t.filter((x) => (o.df ? (o.df[x] ?? 0) <= maxDocs : (o.rare ?? []).includes(x)))),
    ...(o.df ? { veryCommonKbTokens: (t: string[], minDocs: number) => new Set(t.filter((x) => (o.df![x] ?? 0) > minDocs)) } : {}),
    recentProjectEvents: (project: string, opts: { beforeIso: string; sinceIso: string; limit: number }) => {
      recentCalls.push({ project, beforeIso: opts.beforeIso, sinceIso: opts.sinceIso });
      return events
        .filter((e) => e.project.toLowerCase() === project.toLowerCase() && e.ts <= opts.beforeIso && e.ts >= opts.sinceIso)
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, opts.limit)
        .map((e) => ({ ...e, entities: e.entities ?? [] }));
    },
    getOwnerProjects: (owners: Array<{ owner_id: string; owner_kind: string }>) => {
      const m = new Map<string, { project: string; userLevel: boolean }>();
      for (const ow of owners) {
        const p = ow.owner_kind === "event" ? events.find((e) => e.id === ow.owner_id)?.project : facts.find((f) => f.id === ow.owner_id)?.project;
        if (p !== undefined) m.set(`${ow.owner_kind}:${ow.owner_id}`, { project: p, userLevel: false });
      }
      return m;
    },
  };
  return { store: store as never, recentCalls, ftsQueries };
}

const opts = (store: never, extra: Record<string, unknown> = {}) => ({ store, selective: SEL, skipVector: true, project: "Argus", nowMs: NOW_MS, ...extra });

describe("kbRecallSelective — recent project work", () => {
  it("brings in a recent event of the current project that no global source ranked, on one shared word", async () => {
    const { store, recentCalls } = fakeStore({
      events: [{ id: "r1", text: "Render deploy del worker sistemato con il nuovo start command", ts: iso(NOW_MS - 2 * DAY), project: "Argus" }],
    });
    const out = await kbRecallSelective("perche il worker non parte", opts(store));
    expect(out.map((r) => r.owner_id)).toEqual(["r1"]);
    expect(recentCalls[0]).toMatchObject({ project: "Argus", beforeIso: iso(NOW_MS), sinceIso: iso(NOW_MS - 14 * DAY) });
  });

  it("stays silent when the recent event shares nothing with the prompt", async () => {
    const { store } = fakeStore({
      events: [{ id: "r1", text: "Render deploy sistemato", ts: iso(NOW_MS - 2 * DAY), project: "Argus" }],
    });
    expect(await kbRecallSelective("aggiorna il logo della homepage", opts(store))).toEqual([]);
  });

  it("gives no discount to an event outside the window or of another project", async () => {
    const { store } = fakeStore({
      events: [
        { id: "old", text: "worker sistemato", ts: iso(NOW_MS - 40 * DAY), project: "Argus" },
        { id: "sofia", text: "worker sistemato", ts: iso(NOW_MS - 1 * DAY), project: "Sofia-AI" },
      ],
      fts: [{ owner_id: "old", owner_kind: "event", score: 0.9 }, { owner_id: "sofia", owner_kind: "event", score: 0.9 }],
    });
    expect(await kbRecallSelective("perche il worker non parte", opts(store))).toEqual([]);
  });

  it("is off without a project or with recentEventDays = 0", async () => {
    const events: Ev[] = [{ id: "r1", text: "worker sistemato", ts: iso(NOW_MS - DAY), project: "Argus" }];
    const a = fakeStore({ events });
    expect(await kbRecallSelective("perche il worker non parte", opts(a.store, { project: undefined }))).toEqual([]);
    expect(a.recentCalls).toHaveLength(0);
    const b = fakeStore({ events });
    expect(await kbRecallSelective("perche il worker non parte", opts(b.store, { selective: { ...SEL, recentEventDays: 0 } }))).toEqual([]);
  });

  it("uses the injected clock, not the wall clock", async () => {
    const { store } = fakeStore({
      events: [{ id: "r1", text: "worker sistemato", ts: iso(NOW_MS - DAY), project: "Argus" }],
    });
    // A year later the same event is far outside the window.
    expect(await kbRecallSelective("perche il worker non parte", opts(store, { nowMs: NOW_MS + 365 * DAY }))).toEqual([]);
  });
});

describe("kbRecallSelective — unknown-project memories", () => {
  it("needs strong evidence for a memory with no project label", async () => {
    const facts: Fa[] = [{ id: "u1", entity_id: "X", attribute: "deploy", value: "render worker start command", project: "" }];
    const weak = fakeStore({ facts, fts: [{ owner_id: "u1", owner_kind: "fact", score: 0.9 }] });
    // 4 common words = 4 points: enough for a labeled memory, not for an unlabeled one (6).
    expect(await kbRecallSelective("render worker start command", opts(weak.store))).toEqual([]);
    const strong = fakeStore({ facts, fts: [{ owner_id: "u1", owner_kind: "fact", score: 0.9 }], rare: ["render", "worker"] });
    expect((await kbRecallSelective("render worker start command", opts(strong.store))).map((r) => r.owner_id)).toEqual(["u1"]);
  });

  it("keeps the old bar for the same memory when it carries the current project", async () => {
    const facts: Fa[] = [{ id: "s1", entity_id: "X", attribute: "deploy", value: "render worker start command", project: "Argus" }];
    const { store } = fakeStore({ facts, fts: [{ owner_id: "s1", owner_kind: "fact", score: 0.9 }] });
    expect((await kbRecallSelective("render worker start command", opts(store))).map((r) => r.owner_id)).toEqual(["s1"]);
  });
});

describe("kbRecallSelective — very common words", () => {
  it("a word in thousands of documents is half a point, so it no longer clears the bar alone", async () => {
    const facts: Fa[] = [{ id: "s1", entity_id: "X", attribute: "note", value: "deploy test agent build", project: "Argus" }];
    const df = { deploy: 5000, test: 5000, agent: 5000, build: 5000 };
    const base = { facts, fts: [{ owner_id: "s1", owner_kind: "fact", score: 0.9 }], df };
    const off = fakeStore(base);
    const offSel = { ...SEL, veryCommonTokenMinDocs: 0 };
    expect((await kbRecallSelective("deploy test agent build", opts(off.store, { selective: offSel }))).map((r) => r.owner_id)).toEqual(["s1"]); // 4 × 1 point
    const on = fakeStore(base);
    const sel = { ...SEL, veryCommonTokenMinDocs: 1000 };
    expect(await kbRecallSelective("deploy test agent build", opts(on.store, { selective: sel }))).toEqual([]); // 4 × 0.5 points
  });
});

describe("kbRecallSelective — Italian/English stems", () => {
  it("asks FTS for the prefix and counts the variant as evidence", async () => {
    const facts: Fa[] = [{ id: "s1", entity_id: "X", attribute: "capture", value: "inbox con idempotenza sul pacco", project: "Argus" }];
    const base = { facts, fts: [{ owner_id: "s1", owner_kind: "fact", score: 0.95 }], rare: ["capture", "inbox", "idempotency"] };
    const exact = fakeStore(base);
    // exact words: capture + inbox = 4 points (rare) — idempotency does not meet idempotenza
    const sel = { ...SEL, minEvidencePoints: 6 };
    expect(await kbRecallSelective("capture inbox idempotency", opts(exact.store, { selective: sel }))).toEqual([]);
    const stemmed = fakeStore(base);
    const out = await kbRecallSelective("capture inbox idempotency", opts(stemmed.store, { selective: { ...sel, stemLength: 7 } }));
    expect(out.map((r) => r.owner_id)).toEqual(["s1"]);
    expect(stemmed.ftsQueries[0]).toContain('"idempot"*');
  });
});
