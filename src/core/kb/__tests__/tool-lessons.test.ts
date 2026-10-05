/**
 * Live 05/10/2026: 62 lessons never shown (exposure_count 0), and this very session
 * hit "Bash `sleep 600` → Exit code 143" while a 32-evidence lesson about it existed.
 * Tool-behaviour lessons learn their trigger from their evidence and speak right
 * after the matching failure, in any project — through the real matcher and SQLite.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { createPretoolSource } from "../pretool-queries.js";
import { PretoolMatcher } from "../pretool-match.js";
import { containsPhrase, errorPhrase, isWeakPhrase, learnToolLesson, parseFriction } from "../tool-lessons.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };

describe("pure pieces", () => {
  it("parses the friction format, live and backfilled", () => {
    expect(parseFriction("[backfill] Bash failed on `sleep 120; echo ok`: Exit code 143")).toEqual({ tool: "Bash", input: "sleep 120; echo ok", error: "Exit code 143" });
    expect(parseFriction("Edit failed on `C:\\a.ts`: <tool_use_error>File has not been read yet.</tool_use_error>")?.tool).toBe("Edit");
    expect(parseFriction("Il deploy è fallito ieri")).toBeNull();
  });
  it("normalizes errors and keeps short codes distinct", () => {
    expect(errorPhrase("<tool_use_error>File has not been read yet. Read it first.</tool_use_error>")).toBe("file has not been read yet.");
    expect(containsPhrase("exit code 128", "exit code 1")).toBe(false);
    expect(containsPhrase("exit code 143", "exit code 143")).toBe(true);
  });
  it("application exit codes and hook-block prefixes are weak; system codes are not", () => {
    expect(isWeakPhrase("exit code 1")).toBe(true);
    expect(isWeakPhrase("exit code 143")).toBe(false);
    expect(isWeakPhrase('pretooluse:bash hook error: [node "c:\\users')).toBe(true);
    expect(isWeakPhrase("no workspace selected.")).toBe(false);
  });
  it("a lesson with no tool-shaped evidence learns nothing", () => {
    expect(learnToolLesson({ id: "l", domain: "d", text: "t", evidenceCount: 3 }, ["Il mismatch è confermato", "altro"])).toBeNull();
  });
});

let db: DatabaseSync;
let seq = 0;
function setup(): void {
  db = new DB(":memory:");
  initFoundationsSchema(db);
  db.prepare(`CREATE TABLE events (id TEXT PRIMARY KEY, ts TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
    session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', namespace TEXT NOT NULL DEFAULT 'default',
    project TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, text TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'und',
    entities_json TEXT NOT NULL DEFAULT '[]', source_message_ids_json TEXT NOT NULL DEFAULT '[]')`).run();
  db.prepare(`CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, canonical_key TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default', project TEXT NOT NULL DEFAULT '')`).run();
}
function bug(project: string, text: string): string {
  const id = `evt_${String(++seq).padStart(4, "0")}`;
  db.prepare("INSERT INTO events (id, ts, session_key, project, type, text) VALUES (?, 'x', 's', ?, 'bug', ?)").run(id, project, text);
  return id;
}
function lesson(project: string, domain: string, text: string, evidence: string[]): string {
  const id = `les_${++seq}`;
  db.prepare(`INSERT INTO lessons (id, project, domain, trigger_pattern, lesson_text, evidence_event_ids_json, evidence_count,
      confidence, stance_confirmed_count, stance_willingness, created_time, updated_time)
    VALUES (?, ?, ?, '{"files":[],"error_signatures":[],"task_type":""}', ?, ?, ?, 0.8, 0, 0.7, 'x', 'x')`)
    .run(id, project, domain, text, JSON.stringify(evidence), evidence.length);
  return id;
}

describe("PretoolMatcher speaks a tool lesson after the matching failure", () => {
  beforeEach(async () => {
    setup();
    lesson("Argus", "Script Execution", "Long sleeps get killed by the Bash tool timeout; run them in background.", [
      bug("Argus", "[backfill] Bash failed on `sleep 120; echo waited`: Exit code 143"),
      bug("Argus", "[backfill] Bash failed on `sleep 600; tail -5 out.log`: Exit code 143"),
    ]);
    lesson("", "workspace", "Select a Render workspace before calling Render tools.", [
      bug("Argus", "mcp__render__list_services failed on `{}`: no workspace selected. To resolve: call list_workspaces"),
      bug("Argus", "mcp__render__list_services failed on `{}`: no workspace selected. To resolve: call list_workspaces"),
      bug("Argus", "mcp__render__list_services failed on `{}`: no workspace selected. To resolve: call list_workspaces"),
    ]);
  });
  const matcher = async () => { const m = new PretoolMatcher(createPretoolSource(db)); await m.warm(); return m; };

  it("in ANOTHER project, right after the same failure, once per session", async () => {
    const m = await matcher();
    const req = { sessionKey: "s1", project: "tencentdb-agent-memory", toolName: "Bash", toolInput: { command: "sleep 600; grep -c x log" }, errorText: "Exit code 143", phase: "failure" as const };
    const item = m.match(req);
    expect(item?.kind).toBe("lesson");
    expect(item?.text).toContain("Long sleeps get killed");
    expect(item?.text).toContain("Past example: Bash `sleep 120; echo waited` → Exit code 143");
    expect(m.match(req)).toBeNull();
  });
  it("not for a different exit code, and not before a plain command", async () => {
    const m = await matcher();
    expect(m.match({ sessionKey: "s2", project: "Sofia-AI", toolName: "Bash", toolInput: { command: "npm test" }, errorText: "Exit code 1", phase: "failure" })).toBeNull();
    expect(m.match({ sessionKey: "s2", project: "Sofia-AI", toolName: "Bash", toolInput: { command: "sleep 600" }, phase: "pre" })).toBeNull();
  });
  it("an external tool that keeps failing warns BEFORE its first use, even from an untagged lesson", async () => {
    const m = await matcher();
    const item = m.match({ sessionKey: "s3", project: "Sofia-AI", toolName: "mcp__render__list_services", toolInput: {}, phase: "pre" });
    expect(item?.text).toContain("Select a Render workspace");
  });
});
