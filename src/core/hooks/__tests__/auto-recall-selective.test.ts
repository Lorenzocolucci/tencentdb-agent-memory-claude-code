/**
 * runKbRecall + performAutoRecall in SELECTIVE mode (Phase 3, "silent unless useful").
 * Drives the real functions with fake stores so each behaviour the live audit demanded
 * is pinned: total ≤5 lines, associative tail ≤3 and converged, no reinforce-on-retrieval,
 * silent turns recorded, ledger carries the cc session id, per-session de-dup, chronic
 * noise and other-project exclusion, stable block on the first turn only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performAutoRecall, runKbRecall } from "../auto-recall.js";
import { SessionBannerTracker } from "../session-banner.js";
import { RecentInjectionLog, ChronicNoiseCache } from "../../kb/selective-recall.js";
import { parseConfig } from "../../../config.js";

const NOW = new Date().toISOString();
const cfg = parseConfig({ recall: { source: "kb" } });
const legacyCfg = parseConfig({ recall: { source: "kb", selective: { enabled: false } } });
const sit = { sessionKey: "sk", namespace: "default", sessionId: "cc-1" };
const PROMPT = "ricrea template creati sul waba";

interface Assoc { owner_id: string; owner_kind: "fact" | "event"; text: string; entity_id: string; activation: number; seedCount?: number }

function makeStore(o: {
  hit?: boolean;
  assoc?: Assoc[];
  chronic?: string[];
  foreign?: string[];
  situationEntities?: string[];
} = {}) {
  const spies = {
    reinforce: vi.fn(() => 0),
    ledger: vi.fn(() => 0),
    silent: vi.fn(),
    expand: vi.fn(),
    otherProject: vi.fn(),
  };
  const hit = o.hit ?? true;
  const store = {
    searchKbFts: () => (hit ? [{ owner_id: "e1", owner_kind: "event", score: 0.9, content: "", entity_type: "", namespace: "default", attribute: "" }] : []),
    queryEventById: (id: string) => (id === "e1" ? { id: "e1", text: "Creati template sul nuovo WABA", ts: NOW, entities: ["W"] } : null),
    queryEntityById: (id: string) => (id === "W" ? { id: "W", name: "WABA Meta", importance: 50 } : null),
    rareKbTokens: () => new Set(["waba"]),
    listEventsBySession: () => [
      { id: "s1", ts: NOW, recorded_at: "", session_key: "sk", session_id: "p", namespace: "default", project: "p", type: "decision", text: "x", language: "und", entities: o.situationEntities ?? ["S"], source_message_ids: [] },
    ],
    associativeExpand: (seeds: string[], opts: unknown) => { spies.expand(seeds, opts); return o.assoc ?? []; },
    reinforceRecalledOwners: spies.reinforce,
    recordRecallInjections: (p: unknown) => { spies.ledger(p); return 1; },
    recordSilentTurn: (p: unknown) => spies.silent(p),
    chronicNoiseOwnerKeys: () => o.chronic ?? [],
    otherProjectOwnerKeys: (owners: unknown, project: unknown) => { spies.otherProject(owners, project); return new Set(o.foreign ?? []); },
  };
  return { store: store as never, spies };
}

const opts = () => ({ injectionLog: new RecentInjectionLog(10), chronicNoise: new ChronicNoiseCache() });
const assoc = (id: string, activation: number, seedCount = 2, kind: "fact" | "event" = "event"): Assoc => ({
  owner_id: id, owner_kind: kind, text: `Subject — ${id}`, entity_id: `ent-${id}`, activation, seedCount,
});

describe("runKbRecall — selective", () => {
  it("caps the associative tail at 3 and the total at 5, drops weak and non-converged items", async () => {
    const { store } = makeStore({
      assoc: [assoc("a1", 0.9), assoc("a2", 0.6), assoc("a3", 0.5), assoc("a4", 0.45), assoc("one-seed", 0.95, 1), assoc("weak", 0.1)],
    });
    const out = await runKbRecall(PROMPT, cfg, undefined, store, undefined, "Sofia-AI", sit, opts());
    const ids = out.map((r) => r.owner_id);
    expect(ids[0]).toBe("e1");
    expect(ids.slice(1)).toEqual(["a1", "a2", "a3"]);
    expect(out.filter((r) => r.associative)).toHaveLength(3);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out[0]!.text).toBe("WABA Meta — Creati template sul nuovo WABA"); // subject on the line
  });

  it("asks the store for a project-scoped, hub-aware, seed-counting expansion", async () => {
    const { store, spies } = makeStore({ assoc: [assoc("a1", 0.9)] });
    await runKbRecall(PROMPT, cfg, undefined, store, undefined, "Sofia-AI", sit, opts());
    const [seeds, expandOpts] = spies.expand.mock.calls[0] as [string[], { selective: { project: string; hubFactThreshold: number } }];
    expect(seeds).toEqual(expect.arrayContaining(["W", "S"])); // the query hit AND the situation
    expect(expandOpts.selective.project).toBe("Sofia-AI");
    expect(expandOpts.selective.hubFactThreshold).toBe(cfg.recall.selective!.hubFactThreshold);
  });

  it("never reinforces on retrieval (the Hebbian-on-recall loop is gone)", async () => {
    const { store, spies } = makeStore({ assoc: [assoc("a1", 0.9), assoc("a2", 0.8), assoc("a3", 0.7)] });
    await runKbRecall(PROMPT, cfg, undefined, store, undefined, "Sofia-AI", sit, opts());
    expect(spies.reinforce).not.toHaveBeenCalled();
  });

  it("a turn with nothing relevant injects nothing: no associative pass, a silent-turn marker, no ledger rows", async () => {
    const { store, spies } = makeStore({ hit: false, assoc: [assoc("a1", 0.9)] });
    const out = await runKbRecall(PROMPT, cfg, undefined, store, undefined, "Sofia-AI", sit, opts());
    expect(out).toEqual([]);
    expect(spies.expand).not.toHaveBeenCalled(); // associations only ride on a relevant hit
    expect(spies.ledger).not.toHaveBeenCalled();
    expect(spies.silent).toHaveBeenCalledTimes(1);
    expect(spies.silent.mock.calls[0]![0]).toMatchObject({ sessionKey: "sk", sessionId: "cc-1" });
  });

  it("the ledger stores the cc session id (it was constant for every row before)", async () => {
    const { store, spies } = makeStore();
    await runKbRecall(PROMPT, cfg, undefined, store, undefined, "Sofia-AI", sit, opts());
    expect(spies.ledger).toHaveBeenCalledTimes(1);
    expect(spies.ledger.mock.calls[0]![0]).toMatchObject({ sessionKey: "sk", sessionId: "cc-1" });
  });

  it("does not repeat an owner within the session's last 10 turns, but another session still gets it", async () => {
    const { store } = makeStore();
    const o = opts();
    const first = await runKbRecall(PROMPT, cfg, undefined, store, undefined, "Sofia-AI", sit, o);
    expect(first.map((r) => r.owner_id)).toContain("e1");
    const second = await runKbRecall(PROMPT, cfg, undefined, store, undefined, "Sofia-AI", sit, o);
    expect(second.map((r) => r.owner_id)).not.toContain("e1");
    const other = await runKbRecall(PROMPT, cfg, undefined, store, undefined, "Sofia-AI", { ...sit, sessionId: "cc-2" }, o);
    expect(other.map((r) => r.owner_id)).toContain("e1");
  });

  it("excludes chronic noise (≥20 injections, 0 uses) and other projects' memories — also from the associative tail", async () => {
    const chronic = makeStore({ chronic: ["event:e1"], assoc: [assoc("a1", 0.9)] });
    expect((await runKbRecall(PROMPT, cfg, undefined, chronic.store, undefined, "Sofia-AI", sit, opts())).map((r) => r.owner_id)).toEqual([]);

    const foreign = makeStore({ foreign: ["event:e1", "event:a1"], assoc: [assoc("a1", 0.9), assoc("a2", 0.8)] });
    const out = await runKbRecall(PROMPT, cfg, undefined, foreign.store, undefined, "Sofia-AI", sit, opts());
    expect(out.map((r) => r.owner_id)).not.toContain("e1");
    expect(foreign.spies.otherProject).toHaveBeenCalled();
    expect(foreign.spies.otherProject.mock.calls[0]![1]).toBe("Sofia-AI");
  });

  it("legacy config (selective off) keeps the old behaviour: reinforce on retrieval, no gate", async () => {
    const { store, spies } = makeStore({ hit: false, situationEntities: ["S"], assoc: [assoc("a1", 0.9)] });
    const out = await runKbRecall("Ciao", legacyCfg, undefined, store, undefined, undefined, sit);
    expect(out.map((r) => r.owner_id)).toContain("a1");
    expect(spies.reinforce).toHaveBeenCalled();
    expect(spies.silent).not.toHaveBeenCalled();
  });
});

describe("performAutoRecall — stable block on the first turn only", () => {
  let dir: string;
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-stable-once-"));
    fs.writeFileSync(path.join(dir, "persona.md"), "Lorenzo is an entrepreneur, not a developer.");
    fs.writeFileSync(path.join(dir, "principles.md"), "Always tell the truth about what was verified.");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const turn = (c: typeof cfg, tracker: SessionBannerTracker, store: never, sessionId = "cc-1", userText = "ok procedi") =>
    performAutoRecall({
      userText, actorId: "a", sessionKey: "sk", sessionId, cfg: c, pluginDataDir: dir, projectName: "Sofia-AI",
      logger: quiet, vectorStore: store, bannerTracker: tracker,
    });

  it("turn 1 carries principles + persona; later turns carry NOTHING when no memory is relevant", async () => {
    const tracker = new SessionBannerTracker();
    const { store } = makeStore({ hit: false });
    const first = await turn(cfg, tracker, store);
    expect(first?.appendSystemContext).toContain("<user-persona>");
    expect(first?.appendSystemContext).toContain("<governing-principles>");
    expect(first?.bannerEmitted).toBe(true);
    tracker.markEmitted("cc-1");

    const second = await turn(cfg, tracker, store);
    expect(second).toBeUndefined(); // silent: no stable block, no memories
  });

  it("later turns with a relevant memory carry only <relevant-memories> (no persona, no tools guide)", async () => {
    const tracker = new SessionBannerTracker();
    tracker.markEmitted("cc-1");
    const { store } = makeStore();
    const res = await turn(cfg, tracker, store, "cc-1", PROMPT);
    expect(res?.prependContext).toContain("<relevant-memories>");
    expect(res?.appendSystemContext).toBeUndefined();
  });

  it("a first turn whose banner was not committed (timed-out recall) retries the stable block", async () => {
    const tracker = new SessionBannerTracker();
    const { store } = makeStore({ hit: false });
    await turn(cfg, tracker, store); // result lost: markEmitted never called
    const retry = await turn(cfg, tracker, store);
    expect(retry?.appendSystemContext).toContain("<user-persona>");
  });

  it("with selective off the stable block still ships on every turn (rollback path)", async () => {
    const tracker = new SessionBannerTracker();
    tracker.markEmitted("cc-1");
    const { store } = makeStore({ hit: false });
    const res = await turn(legacyCfg, tracker, store);
    expect(res?.appendSystemContext).toContain("<user-persona>");
  });
});
