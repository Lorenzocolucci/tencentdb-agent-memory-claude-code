/**
 * The ledger against a real SQLite database: what was injected, what was used,
 * and — the part that matters — what the verdict refuses to claim.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { recordInjections, judgePending, readVerdict, JUDGE_WINDOW_MS, MAX_LEDGER_ROWS_PER_TURN } from "../recall-ledger.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };

const NOW = "2026-08-23T02:00:00.000Z";
const SESSION = "proj-key";

let db: DatabaseSync;

function inject(overrides: Partial<Parameters<typeof recordInjections>[1]> = {}) {
  return recordInjections(db, {
    sessionKey: SESSION,
    sessionId: "sid-1",
    now: NOW,
    injections: [
      { ownerId: "m1", ownerKind: "fact", score: 0.9, associative: false,
        memoryText: "[fact] gateway - tokenPath: la porta 8421 e il file token" },
      { ownerId: "m2", ownerKind: "event", score: 0.4, associative: true,
        memoryText: "[event] DeepInfra Qwen3-Embedding-4B a 1024 dimensioni" },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  db = new DB(":memory:");
  expect(initFoundationsSchema(db)).toBe(true);
});

describe("recordInjections", () => {
  it("writes one unjudged row per injected memory", () => {
    expect(inject()).toBe(2);
    const rows = db.prepare("SELECT judged, used FROM recall_ledger").all() as Array<{ judged: number; used: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.judged === 0 && r.used === 0)).toBe(true);
  });

  it("bounds how much one turn can write", () => {
    const many = Array.from({ length: MAX_LEDGER_ROWS_PER_TURN + 20 }, (_, i) => ({
      ownerId: `x${i}`, ownerKind: "fact", score: 0.1, associative: false, memoryText: `memoria ${i}`,
    }));
    expect(inject({ injections: many })).toBe(MAX_LEDGER_ROWS_PER_TURN);
  });

  it("skips rows without an owner id and never throws", () => {
    expect(inject({ injections: [{ ownerId: "", ownerKind: "fact", score: 1, associative: false, memoryText: "x" }] })).toBe(0);
    expect(inject({ injections: [] })).toBe(0);
  });
});

describe("judgePending", () => {
  it("credits the memory the reply actually drew on, not the other one", () => {
    inject();
    const r = judgePending(db, {
      sessionKey: SESSION,
      userText: "riprendi",
      assistantText: "Il gateway sta sulla porta 8421 e legge il tokenPath.",
      now: NOW,
    });
    expect(r.injected).toBe(2);
    expect(r.used).toBe(1);
    expect(r.perMemory.find((m) => m.ownerId === "m1")?.used).toBe(true);
    expect(r.perMemory.find((m) => m.ownerId === "m2")?.used).toBe(false);
  });

  it("stores the tokens that carried the verdict, so it can be audited", () => {
    inject();
    judgePending(db, {
      sessionKey: SESSION,
      userText: "riprendi",
      assistantText: "Il gateway sta sulla porta 8421 e legge il tokenPath.",
      now: NOW,
    });
    const row = db.prepare("SELECT matched_json FROM recall_ledger WHERE owner_id = 'm1'").get() as { matched_json: string };
    expect(JSON.parse(row.matched_json)).toContain("8421");
  });

  it("settles each row exactly once — a second turn does not re-judge it", () => {
    inject();
    const first = judgePending(db, { sessionKey: SESSION, userText: "a", assistantText: "porta 8421 tokenPath", now: NOW });
    expect(first.injected).toBe(2);
    const second = judgePending(db, { sessionKey: SESSION, userText: "a", assistantText: "porta 8421 tokenPath", now: NOW });
    expect(second.injected).toBe(0);
  });

  it("retires injections older than the window instead of scoring them", () => {
    const old = new Date(Date.parse(NOW) - JUDGE_WINDOW_MS - 60_000).toISOString();
    inject({ now: old });
    const r = judgePending(db, { sessionKey: SESSION, userText: "a", assistantText: "b", now: NOW });
    expect(r.expired).toBe(2);
    expect(r.injected).toBe(0);
    const rows = db.prepare("SELECT judged, unjudgeable FROM recall_ledger").all() as Array<{ judged: number; unjudgeable: number }>;
    expect(rows.every((x) => x.judged === 1 && x.unjudgeable === 1)).toBe(true);
  });

  it("does not touch another project's pending rows", () => {
    inject();
    inject({ sessionKey: "altro-progetto" });
    judgePending(db, { sessionKey: SESSION, userText: "a", assistantText: "porta 8421 tokenPath", now: NOW });
    const other = db.prepare("SELECT COUNT(*) c FROM recall_ledger WHERE session_key = 'altro-progetto' AND judged = 0").get() as { c: number };
    expect(other.c).toBe(2);
  });
});

describe("readVerdict", () => {
  it("reports nothing rather than guessing when nothing is judgeable", () => {
    inject();
    const v = readVerdict(db);
    expect(v.pending).toBe(2);
    expect(v.judged).toBe(0);
    expect(v.usefulness).toBeNull();
  });

  it("computes usefulness over JUDGEABLE rows only", () => {
    recordInjections(db, {
      sessionKey: SESSION, now: NOW,
      injections: [
        { ownerId: "u1", ownerKind: "fact", score: 1, associative: false, memoryText: "porta 8421 tokenPath del gateway" },
        { ownerId: "n1", ownerKind: "fact", score: 1, associative: false, memoryText: "Qwen3-Embedding-4B dimensioni 1024" },
        { ownerId: "e1", ownerKind: "fact", score: 1, associative: false, memoryText: "parliamo del deploy" },
      ],
    });
    judgePending(db, {
      sessionKey: SESSION,
      userText: "parliamo del deploy",
      assistantText: "Il gateway usa la porta 8421 e il tokenPath.",
      now: NOW,
    });

    const v = readVerdict(db);
    expect(v.judged).toBe(3);
    expect(v.unjudgeable).toBe(1); // e1 said nothing the user had not said
    expect(v.used).toBe(1);
    expect(v.noise).toBe(1); // n1 was injected, judgeable, unused
    expect(v.usefulness).toBeCloseTo(0.5, 5); // 1 used out of 2 judgeable
  });

  it("names the memories that earn their place and the ones that never land", () => {
    for (let i = 0; i < 3; i++) {
      recordInjections(db, {
        sessionKey: SESSION, now: NOW,
        injections: [
          { ownerId: "u1", ownerKind: "fact", score: 1, associative: false, memoryText: "porta 8421 tokenPath del gateway" },
          { ownerId: "n1", ownerKind: "fact", score: 1, associative: false, memoryText: "Qwen3-Embedding-4B dimensioni 1024" },
        ],
      });
      judgePending(db, {
        sessionKey: SESSION, userText: "vai",
        assistantText: "Il gateway usa la porta 8421 e il tokenPath.",
        now: NOW,
      });
    }
    const v = readVerdict(db);
    expect(v.topUsed[0]?.ownerId).toBe("u1");
    expect(v.topUsed[0]?.uses).toBe(3);
    expect(v.topNoise[0]?.ownerId).toBe("n1");
    expect(v.topNoise[0]?.injections).toBe(3);
  });

  it("can be scoped to one project", () => {
    inject();
    inject({ sessionKey: "altro" });
    judgePending(db, { sessionKey: SESSION, userText: "a", assistantText: "porta 8421 tokenPath", now: NOW });
    expect(readVerdict(db, { sessionKey: SESSION }).judged).toBe(2);
    expect(readVerdict(db, { sessionKey: "altro" }).judged).toBe(0);
  });

  it("returns an empty verdict when the table does not exist", () => {
    const bare = new DB(":memory:");
    expect(readVerdict(bare).usefulness).toBeNull();
    expect(readVerdict(bare).judged).toBe(0);
  });
});
