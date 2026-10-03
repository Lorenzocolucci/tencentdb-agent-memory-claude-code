/**
 * Store-backed Phase 3 pieces on a real (temp) SQLite KB: project scoping of owners,
 * the chronic-noise query, the silent-turn marker and the selective associative expansion.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../../store/sqlite.js";
import { otherProjectKeys, ownerProjects, chronicNoiseKeys, selectiveAssociativeExpand, rankFactsForQuery } from "../selective-store.js";
import { recordSilentTurn, readVerdict } from "../recall-ledger.js";
import { readInjectionStats } from "../recall-stats.js";

const NOW = "2026-10-01T10:00:00.000Z";
let dir: string;
let store: VectorStore;
let db: DatabaseSync;

const ent = (id: string, name: string, type = "concept", project = "") =>
  db.prepare("INSERT INTO entities (id, type, name, canonical_key, namespace, project, aliases_json, importance, created_time, updated_time) VALUES (?, ?, ?, ?, 'default', ?, '[]', 50, ?, ?)")
    .run(id, type, name, `${type}:${id}`, project, NOW, NOW);
const fact = (id: string, entityId: string, attribute: string, value: string, sourceEventId: string | null = null, confidence = 0.7) =>
  db.prepare("INSERT INTO facts (id, entity_id, attribute, value, valid_from, learned_at, source_event_id, confidence, created_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, entityId, attribute, value, NOW, NOW, sourceEventId, confidence, NOW);
const evt = (id: string, sessionKey: string, project: string, text: string, entities: string[], ts = NOW) =>
  db.prepare("INSERT INTO events (id, ts, recorded_at, session_key, project, type, text, entities_json) VALUES (?, ?, ?, ?, ?, 'event', ?, ?)")
    .run(id, ts, NOW, sessionKey, project, text, JSON.stringify(entities));
const rel = (id: string, a: string, b: string, support = 1) =>
  db.prepare("INSERT INTO relations (id, src_entity_id, type, dst_entity_id, namespace, valid_from, created_time, support) VALUES (?, ?, 'related', ?, 'default', ?, ?, ?)")
    .run(id, a, b, NOW, NOW, support);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-selective-"));
  store = new VectorStore(path.join(dir, "vectors.db"), 4);
  store.init({ provider: "openai", model: "text-embedding-3-small" });
  db = (store as unknown as { db: DatabaseSync }).db;
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ownerProjects / otherProjectKeys (project scoping)", () => {
  beforeEach(() => {
    db.prepare("INSERT INTO session_projects (session_key, project, updated_at) VALUES ('sk-tutor', 'Tutor-Agent', ?)").run(NOW);
    ent("e1", "Thing");
    ent("lorenzo", "Lorenzo", "person");
    evt("ev-sofia", "sk-x", "Sofia-AI", "sofia work", ["e1"]);
    evt("ev-tutor-reg", "sk-tutor", "", "tutor work via registry", ["e1"]); // empty tag, registered session
    evt("ev-chat", "chatimport_1", "", "a chat import", ["e1"]); // unknown → user-level
    fact("f-tutor", "e1", "a", "b", "ev-tutor-reg");
    fact("f-lorenzo", "lorenzo", "style", "short", "ev-tutor-reg"); // person → user-level
    fact("f-nosrc", "e1", "c", "d", null);
  });

  it("an event belongs to its tag, else to its session's registered project, else nowhere", () => {
    const p = ownerProjects(db, [
      { owner_id: "ev-sofia", owner_kind: "event" },
      { owner_id: "ev-tutor-reg", owner_kind: "event" },
      { owner_id: "ev-chat", owner_kind: "event" },
    ]);
    expect(p.get("event:ev-sofia")?.project).toBe("Sofia-AI");
    expect(p.get("event:ev-tutor-reg")?.project).toBe("Tutor-Agent");
    expect(p.get("event:ev-chat")?.project).toBe("");
  });

  it("a fact belongs to the project of the event it came from; a person's facts are user-level", () => {
    const p = ownerProjects(db, [
      { owner_id: "f-tutor", owner_kind: "fact" },
      { owner_id: "f-lorenzo", owner_kind: "fact" },
    ]);
    expect(p.get("fact:f-tutor")?.project).toBe("Tutor-Agent");
    expect(p.get("fact:f-lorenzo")?.userLevel).toBe(true);
  });

  it("returns exactly the other project's owners; unknown and user-level owners are never excluded", () => {
    const owners = [
      { owner_id: "ev-sofia", owner_kind: "event" },
      { owner_id: "ev-tutor-reg", owner_kind: "event" },
      { owner_id: "ev-chat", owner_kind: "event" },
      { owner_id: "f-tutor", owner_kind: "fact" },
      { owner_id: "f-lorenzo", owner_kind: "fact" },
      { owner_id: "f-nosrc", owner_kind: "fact" },
    ];
    expect([...otherProjectKeys(db, owners, "Sofia-AI")].sort()).toEqual(["event:ev-tutor-reg", "fact:f-tutor"]);
    expect([...otherProjectKeys(db, owners, "Tutor-Agent")]).toEqual(["event:ev-sofia"]);
    expect(otherProjectKeys(db, owners, undefined).size).toBe(0);
    expect(store.otherProjectOwnerKeys(owners, "Sofia-AI").has("fact:f-tutor")).toBe(true);
  });
});

describe("chronicNoiseKeys + silent turns + injection stats", () => {
  const row = (id: string, ownerId: string, used: number, judged = 1, unjudgeable = 0, kind = "fact", assoc = 0, ts = NOW, sk = "sk-s") =>
    db.prepare("INSERT INTO recall_ledger (id, ts, session_key, owner_id, owner_kind, associative, judged, used, unjudgeable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, ts, sk, ownerId, kind, assoc, judged, used, unjudgeable);

  it("flags owners judged ≥N times and never used; ignores used, unjudgeable and silent markers", () => {
    for (let i = 0; i < 20; i++) row(`n${i}`, "noisy", 0);
    for (let i = 0; i < 20; i++) row(`u${i}`, "useful", i === 3 ? 1 : 0);
    for (let i = 0; i < 20; i++) row(`e${i}`, "echo", 0, 1, 1); // unjudgeable: not proven noise
    for (let i = 0; i < 19; i++) row(`f${i}`, "almost", 0);
    for (let i = 0; i < 25; i++) recordSilentTurn(db, { sessionKey: "sk-s", now: NOW });
    expect(chronicNoiseKeys(db, 20)).toEqual(["fact:noisy"]);
    expect(store.chronicNoiseOwnerKeys(20)).toEqual(["fact:noisy"]);
  });

  it("silent-turn markers never count as memories in the verdict, and are counted as silent turns", () => {
    row("a", "m1", 1, 1, 0, "event", 0, "2026-10-01T10:00:00.000Z");
    row("b", "m2", 0, 1, 0, "fact", 1, "2026-10-01T10:00:00.000Z");
    recordSilentTurn(db, { sessionKey: "sk-s", sessionId: "cc-1", now: "2026-10-01T10:05:00.000Z" });
    recordSilentTurn(db, { sessionKey: "sk-s", now: "2026-10-01T10:06:00.000Z" });
    const v = readVerdict(db);
    expect(v.judged).toBe(2);
    expect(v.used).toBe(1);
    const s = readInjectionStats(db);
    expect(s.turnsInjected).toBe(1);
    expect(s.turnsSilent).toBe(2);
    expect(s.lines).toBe(2);
    expect(s.linesPerTurn).toBeCloseTo(2 / 3, 5);
    expect(s.silentTurnsPct).toBeCloseTo(66.67, 1);
    expect(s.tiers.find((t) => t.kind === "event" && !t.associative)).toMatchObject({ injected: 1, used: 1, usedRate: 1 });
    expect(s.tiers.find((t) => t.kind === "fact" && t.associative)).toMatchObject({ injected: 1, used: 0, usedRate: 0 });
  });

  it("counts injected lines whose project conflicts with their session's project", () => {
    db.prepare("INSERT INTO session_projects (session_key, project, updated_at) VALUES ('sk-sofia', 'Sofia-AI', ?)").run(NOW);
    ent("e1", "Thing");
    evt("ev-t", "sk-t", "Tutor-Agent", "tutor", ["e1"]);
    evt("ev-s", "sk-s2", "Sofia-AI", "sofia", ["e1"]);
    row("x1", "ev-t", 0, 1, 0, "event", 0, NOW, "sk-sofia");
    row("x2", "ev-s", 0, 1, 0, "event", 0, NOW, "sk-sofia");
    expect(readInjectionStats(db).crossProjectLines).toBe(1);
  });
});

describe("selectiveAssociativeExpand", () => {
  const opts = { hubFactThreshold: 5, project: "Sofia-AI", queryTokens: ["waba"] as string[] };

  beforeEach(() => {
    ent("A", "Alpha");           // query-matched seed
    ent("S", "Situation");       // situation seed
    ent("X", "Crossroads");      // reached from both seeds
    ent("Y", "Lonely");          // reached from A only
    ent("HUB", "Whole Project"); // hub: more than 5 head facts
    ent("OTHER", "Foreign", "concept", "Tutor-Agent"); // another project's entity
    for (let i = 0; i < 6; i++) fact(`hf${i}`, "HUB", `attr${i}`, `v${i}`);
    rel("r1", "A", "X", 3); rel("r2", "S", "X", 3); rel("r3", "A", "Y", 2);
    rel("r4", "A", "HUB", 9); rel("r5", "S", "HUB", 9); rel("r6", "A", "OTHER", 5); rel("r7", "S", "OTHER", 5);
    evt("evX", "sk-s", "Sofia-AI", "Creati template sul nuovo WABA", ["X"]);
    fact("fy-a", "Y", "alpha_note", "irrelevant");
    fact("fy-z", "Y", "zeta_waba", "il WABA nuovo è approvato");
  });

  it("converges on the crossroads: event-first, with the subject, seedCount = distinct seeds", () => {
    const out = selectiveAssociativeExpand(db, ["A", "S"], opts);
    const x = out.find((o) => o.entity_id === "X")!;
    expect(x.seedCount).toBe(2);
    expect(x.owner_kind).toBe("event");
    expect(x.text).toBe("Crossroads — Creati template sul nuovo WABA");
    expect(out.find((o) => o.entity_id === "Y")!.seedCount).toBe(1);
  });

  it("hub entities are context, not seeds or stepping stones; other projects' entities are excluded", () => {
    const out = selectiveAssociativeExpand(db, ["A", "S", "HUB"], opts);
    const ids = out.map((o) => o.entity_id);
    expect(ids).not.toContain("HUB");
    expect(ids).not.toContain("OTHER");
    // a hub given as the ONLY seed expands nothing
    expect(selectiveAssociativeExpand(db, ["HUB"], opts)).toEqual([]);
  });

  it("without an event, the fact is chosen by the prompt, not alphabetically", () => {
    const y = selectiveAssociativeExpand(db, ["A", "S"], opts).find((o) => o.entity_id === "Y")!;
    expect(y.owner_id).toBe("fy-z");
    expect(y.text).toBe("Lonely — zeta_waba: il WABA nuovo è approvato");
  });

  it("an event of ANOTHER project is not used as the representative", () => {
    db.prepare("DELETE FROM events WHERE id = 'evX'").run();
    evt("evForeign", "sk-t", "Tutor-Agent", "tutor stuff", ["X"]);
    fact("fx", "X", "status", "ok");
    const x = selectiveAssociativeExpand(db, ["A", "S"], opts).find((o) => o.entity_id === "X")!;
    expect(x.owner_kind).toBe("fact");
  });

  it("the store method delegates to it only in selective mode (legacy output has no seedCount)", () => {
    const sel = store.associativeExpand(["A", "S"], { selective: opts });
    expect(sel.find((o) => o.entity_id === "X")?.seedCount).toBe(2);
    const legacy = store.associativeExpand(["A", "S"]);
    expect(legacy.every((o) => o.seedCount === undefined)).toBe(true);
  });
});

describe("rankFactsForQuery", () => {
  it("orders by the prompt's evidence, then confidence — never A→Z", () => {
    const f = (id: string, attribute: string, value: string, confidence: number) =>
      ({ id, attribute, value, confidence, valid_from: NOW } as never);
    const ranked = rankFactsForQuery(
      [f("1", "aaa", "nothing", 0.9), f("2", "zzz", "about waba templates", 0.5), f("3", "mmm", "waba", 0.8)],
      { name: "Thing" },
      ["waba", "templates"],
    );
    expect(ranked.map((x) => x.id)).toEqual(["2", "3", "1"]);
  });
});
