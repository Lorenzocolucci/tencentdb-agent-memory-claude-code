/**
 * The worktree-isolation error hit many sessions in a week: the FIRST occurrence in a
 * new session is already worth a word when other sessions fell in the same trap.
 * Through the real matcher, which learns the error's sessions from stored failures.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { RepeatGuard, CROSS_SESSION_MIN } from "../repeat-guard.js";
import { PretoolService } from "../pretool-service.js";
import { createPretoolSource } from "../pretool-queries.js";
import { initFoundationsSchema } from "../foundations-schema.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const isolated = (wt: string) => `This agent is isolated in the worktree C:\\T\\.claude\\worktrees\\${wt}, but the command leaves it.`;

function service(failures: Array<{ session: string; daysAgo: number }>): PretoolService {
  const db = new DB(":memory:");
  initFoundationsSchema(db);
  db.prepare(`CREATE TABLE events (id TEXT PRIMARY KEY, ts TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
    session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', namespace TEXT NOT NULL DEFAULT 'default',
    project TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, text TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'und',
    entities_json TEXT NOT NULL DEFAULT '[]', source_message_ids_json TEXT NOT NULL DEFAULT '[]')`).run();
  db.prepare(`CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, canonical_key TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default', project TEXT NOT NULL DEFAULT '')`).run();
  failures.forEach((f, i) =>
    db.prepare("INSERT INTO events (id, ts, session_key, project, type, text) VALUES (?, ?, ?, 'Tutor-Agent', 'bug', ?)")
      .run(`evt_${i}`, new Date(NOW - f.daysAgo * 86_400_000).toISOString(), f.session, `Bash failed on \`cd /c/T && git status\`: ${isolated(`agent-${i}`)}`));
  return new PretoolService({ logger: { info() {}, warn() {} }, source: createPretoolSource(db), now: () => NOW });
}
const req = (sessionKey: string) =>
  ({ sessionKey, project: "Tutor-Agent", toolName: "Bash", toolInput: { command: "git -C /c/T log" }, errorText: isolated("agent-new"), phase: "failure" as const });

describe("a known trap speaks on its first occurrence", () => {
  it(`warns when ≥${CROSS_SESSION_MIN} other sessions hit the same error recently`, async () => {
    const svc = service([{ session: "a", daysAgo: 1 }, { session: "b", daysAgo: 2 }, { session: "c", daysAgo: 3 }]);
    await svc.warm();
    const item = svc.check(req("new"));
    expect(item?.kind).toBe("repeat");
    expect(item?.text).toContain("already hit 3 other sessions");
  });
  it("stays silent when too few sessions, or only old ones, had it", async () => {
    const few = service([{ session: "a", daysAgo: 1 }, { session: "b", daysAgo: 2 }]);
    await few.warm();
    expect(few.check(req("new"))).toBeNull();
    const old = service([{ session: "a", daysAgo: 20 }, { session: "b", daysAgo: 21 }, { session: "c", daysAgo: 22 }]);
    await old.warm();
    expect(old.check(req("new"))).toBeNull();
  });
  it("the current session does not count as 'another' session", () => {
    const g = new RepeatGuard(() => new Set(["me", "x", "y"]));
    expect(g.note({ sessionKey: "me", toolName: "Bash", toolInput: { command: "cd /c/T" }, errorText: isolated("a") })).toBeNull();
  });
});
