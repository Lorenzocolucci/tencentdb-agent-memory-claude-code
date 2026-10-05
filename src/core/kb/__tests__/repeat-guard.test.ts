/**
 * Live 05/10/2026: "This agent is isolated in the worktree …" 7 times in a row in one
 * session, different worktree path each time, and memory said nothing.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { RepeatGuard, errorKey } from "../repeat-guard.js";
import { errorPhrase } from "../tool-lessons.js";
import { PretoolService } from "../pretool-service.js";
import { createPretoolSource } from "../pretool-queries.js";
import { initFoundationsSchema } from "../foundations-schema.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };

const isolated = (wt: string) =>
  `This agent is isolated in the worktree C:\\Tutor-Agent\\.claude\\worktrees\\${wt}, but the command targets C:\\Tutor-Agent. Work inside the worktree.`;
const bash = (command: string, errorText: string, sessionKey = "s1") => ({ sessionKey, toolName: "Bash", toolInput: { command }, errorText });

describe("the same mistake is recognized through varying paths", () => {
  it("paths are masked in the error phrase", () => {
    expect(errorPhrase(isolated("agent-ab99"))).toBe(errorPhrase(isolated("agent-a2d8")));
    expect(errorPhrase("ls: cannot access '/tmp/a/b': No such file")).toContain("<path>");
  });
  it("speaks on the 2nd and 4th occurrence, not on the 1st or 3rd", () => {
    const g = new RepeatGuard();
    expect(g.note(bash("cd /c/Tutor-Agent && git status", isolated("agent-1")))).toBeNull();
    const second = g.note(bash("git -C /c/Tutor-Agent fetch", isolated("agent-1")));
    expect(second).toContain("2nd time in this session that Bash fails");
    expect(second).toContain("Previous attempt: `cd /c/Tutor-Agent && git status`");
    expect(g.note(bash("cd /c/Tutor-Agent", isolated("agent-1")))).toBeNull();
    expect(g.note(bash("cd /c/Tutor-Agent", isolated("agent-1")))).toContain("4th time");
  });
  it("other sessions, weak codes from different commands and user denials are not repeats", () => {
    const g = new RepeatGuard();
    g.note(bash("cd /x", isolated("a"), "s1"));
    expect(g.note(bash("cd /x", isolated("a"), "s2"))).toBeNull();
    g.note(bash("npm test", "Exit code 1"));
    expect(g.note(bash("python run.py", "Exit code 1"))).toBeNull();
    expect(errorKey(bash("rm -rf x", "The user doesn't want to proceed with this tool use."))).toBeNull();
  });
  it("the same weak code from the same command IS a repeat", () => {
    const g = new RepeatGuard();
    g.note(bash("npm run build", "Exit code 1"));
    expect(g.note(bash("npm run build -- --watch", "Exit code 1"))).toContain("2nd time");
  });
});

describe("PretoolService says it after the failure, with no lesson needed", () => {
  it("returns a repeat warning on the 2nd identical failure in the failure phase only", async () => {
    const db = new DB(":memory:");
    initFoundationsSchema(db);
    db.prepare(`CREATE TABLE events (id TEXT PRIMARY KEY, ts TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', namespace TEXT NOT NULL DEFAULT 'default',
      project TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, text TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'und',
      entities_json TEXT NOT NULL DEFAULT '[]', source_message_ids_json TEXT NOT NULL DEFAULT '[]')`).run();
    db.prepare(`CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, canonical_key TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'default', project TEXT NOT NULL DEFAULT '')`).run();
    const svc = new PretoolService({ logger: { info() {}, warn() {} }, source: createPretoolSource(db) });
    await svc.warm();
    const req = (command: string) => ({ sessionKey: "s1", project: "Tutor-Agent", toolName: "Bash", toolInput: { command }, errorText: isolated("agent-9"), phase: "failure" as const });
    expect(svc.check(req("cd /c/Tutor-Agent"))).toBeNull();
    const item = svc.check(req("git -C /c/Tutor-Agent log"));
    expect(item?.kind).toBe("repeat");
    expect(item?.severity).toBe("warn");
    expect(svc.check({ ...req("cd /c/Tutor-Agent"), phase: "pre" })).toBeNull();
  });
});
