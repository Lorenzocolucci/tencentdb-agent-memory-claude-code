/**
 * Converter tests — run against a REAL oracle question (no synthetic fixtures),
 * so a green test means the converter handles the actual LongMemEval data shape.
 *
 * WHY real data: delegated "green but no-op" features have shipped twice before
 * by testing against an invented shape. The oracle file is the ground truth.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHaystackDate,
  groupTurnsIntoRounds,
  lmeQuestionToSeed,
  type LmeQuestion,
} from "../src/convert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORACLE_PATH = path.join(__dirname, "..", "data", "longmemeval_oracle.json");

function loadOracle(): LmeQuestion[] {
  if (!fs.existsSync(ORACLE_PATH)) {
    throw new Error(
      `Oracle dataset not found at ${ORACLE_PATH}. Download it first ` +
      `(benchmark/longmemeval/data/longmemeval_oracle.json).`,
    );
  }
  return JSON.parse(fs.readFileSync(ORACLE_PATH, "utf-8")) as LmeQuestion[];
}

describe("parseHaystackDate", () => {
  it("parses the LongMemEval date format to UTC epoch ms", () => {
    const ms = parseHaystackDate("2023/04/10 (Mon) 17:50");
    expect(new Date(ms).toISOString()).toBe("2023-04-10T17:50:00.000Z");
  });

  it("ignores the decorative weekday token", () => {
    expect(parseHaystackDate("2023/04/10 (Mon) 17:50")).toBe(
      parseHaystackDate("2023/04/10 (Xyz) 17:50"),
    );
  });

  it("throws loudly on a malformed date instead of returning NaN", () => {
    expect(() => parseHaystackDate("not a date")).toThrow(/Unparseable/);
  });
});

describe("groupTurnsIntoRounds", () => {
  it("splits a user→assistant→user→assistant flow into two rounds", () => {
    const rounds = groupTurnsIntoRounds([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);
    expect(rounds.length).toBe(2);
    expect(rounds[0]!.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(rounds[1]!.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("keeps a leading assistant turn in its own round and never drops turns", () => {
    const turns = [
      { role: "assistant" as const, content: "intro" },
      { role: "user" as const, content: "q" },
      { role: "assistant" as const, content: "a" },
    ];
    const rounds = groupTurnsIntoRounds(turns);
    const flat = rounds.flat();
    expect(flat.length).toBe(turns.length); // no turn lost
    expect(flat.map((t) => t.content)).toEqual(["intro", "q", "a"]);
  });
});

describe("lmeQuestionToSeed (real oracle data)", () => {
  const oracle = loadOracle();
  const q = oracle[0]!;
  const seed = lmeQuestionToSeed(q);

  it("produces one seed session per haystack session", () => {
    expect(seed.sessions.length).toBe(q.haystack_sessions.length);
  });

  it("preserves the real per-session date as the first turn's timestamp", () => {
    const expected = parseHaystackDate(q.haystack_dates[0]!);
    const firstTurnTs = seed.sessions[0]!.conversations[0]![0]!.timestamp;
    expect(firstTurnTs).toBe(expected);
  });

  it("keeps timestamps strictly increasing within a session", () => {
    for (const session of seed.sessions) {
      const all = session.conversations.flat().map((m) => m.timestamp);
      for (let i = 1; i < all.length; i++) {
        expect(all[i]!).toBeGreaterThan(all[i - 1]!);
      }
    }
  });

  it("preserves every turn's content and role (no loss, no mutation)", () => {
    const originalTurns = q.haystack_sessions.flat();
    const seededTurns = seed.sessions.flatMap((s) => s.conversations.flat());
    expect(seededTurns.length).toBe(originalTurns.length);
    expect(seededTurns.map((t) => t.content)).toEqual(originalTurns.map((t) => t.content));
    expect(seededTurns.map((t) => t.role)).toEqual(originalTurns.map((t) => t.role));
  });

  it("maps the evidence session id into a recoverable sessionKey", () => {
    const evidenceId = q.answer_session_ids[0]!;
    const match = seed.sessions.find((s) => s.sessionId === evidenceId);
    expect(match).toBeDefined();
    expect(match!.sessionKey).toContain(evidenceId);
  });

  it("every round is a non-empty array (seed validation requirement)", () => {
    for (const session of seed.sessions) {
      expect(session.conversations.length).toBeGreaterThan(0);
      for (const round of session.conversations) {
        expect(round.length).toBeGreaterThan(0);
      }
    }
  });
});
