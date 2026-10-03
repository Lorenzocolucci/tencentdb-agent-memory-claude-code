/**
 * Phase 4 — PreToolUse matcher: lessons + recurring bugs, project-scoped,
 * precomputed, one item max, deny only for attested lesson + one-way action.
 * Real SQLite (in-memory) through the real query layer.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { createPretoolSource } from "../pretool-queries.js";
import { PretoolMatcher, commandHead, commandHeadOfRaw, type PretoolRequest } from "../pretool-match.js";
import { PretoolService } from "../pretool-service.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };

const CWD = "C:\\Users\\lo\\Argus";
let db: DatabaseSync;
let seq = 0;

function schema(d: DatabaseSync): void {
  initFoundationsSchema(d);
  d.prepare(`CREATE TABLE events (
    id TEXT PRIMARY KEY, ts TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
    session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
    namespace TEXT NOT NULL DEFAULT 'default', project TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL, text TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'und',
    entities_json TEXT NOT NULL DEFAULT '[]', source_message_ids_json TEXT NOT NULL DEFAULT '[]')`).run();
  d.prepare(`CREATE TABLE entities (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, canonical_key TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default', project TEXT NOT NULL DEFAULT '')`).run();
}

function entity(canonicalKey: string, project = ""): string {
  const id = `ent_${++seq}`;
  db.prepare("INSERT INTO entities (id, type, name, canonical_key, project) VALUES (?, 'file', ?, ?, ?)")
    .run(id, canonicalKey, canonicalKey, project);
  return id;
}

interface LessonOpts {
  project?: string; files?: string[]; sigs?: string[]; evidence?: number;
  confirmed?: number; willingness?: number; text?: string; superseded?: boolean;
}
function lesson(o: LessonOpts): string {
  const id = `les_${++seq}`;
  db.prepare(
    `INSERT INTO lessons (id, project, domain, trigger_pattern, lesson_text, evidence_count, confidence,
       stance_confirmed_count, stance_willingness, superseded_by, created_time, updated_time)
     VALUES (?, ?, 'build', ?, ?, ?, 0.8, ?, ?, ?, 'x', 'x')`,
  ).run(
    id, o.project ?? "Argus",
    JSON.stringify({ files: o.files ?? [], error_signatures: o.sigs ?? [], task_type: "" }),
    o.text ?? "Never edit the generated file by hand",
    o.evidence ?? 3, o.confirmed ?? 0, o.willingness ?? 0.7, o.superseded ? "les_next" : null,
  );
  return id;
}

function bug(project: string, command: string, extraEntities: string[] = []): string {
  const id = `evt_${String(++seq).padStart(6, "0")}`;
  const sig = `signature:Bash|${command.toLowerCase().replace(/\d+/g, "#")}|exit code #`;
  db.prepare(
    `INSERT INTO events (id, ts, session_key, project, type, text, entities_json)
     VALUES (?, 'x', 'sk', ?, 'bug', ?, ?)`,
  ).run(id, project, `Bash failed on \`${command}\`: exit code 1`, JSON.stringify([...extraEntities, sig]));
  return id;
}

const req = (o: Partial<PretoolRequest> & Pick<PretoolRequest, "toolName" | "toolInput">): PretoolRequest => ({
  sessionKey: `s${++seq}`, project: "Argus", cwd: CWD, phase: "pre", ...o,
});
const edit = (file: string, o: Partial<PretoolRequest> = {}): PretoolRequest =>
  req({ toolName: "Edit", toolInput: { file_path: file }, ...o });
const bash = (command: string, o: Partial<PretoolRequest> = {}): PretoolRequest =>
  req({ toolName: "Bash", toolInput: { command }, ...o });

async function matcher(): Promise<PretoolMatcher> {
  const m = new PretoolMatcher(createPretoolSource(db));
  await m.warm();
  return m;
}

beforeEach(() => {
  db = new DB(":memory:");
  schema(db);
});

describe("lesson match on the exact file (4.2 / 4.6)", () => {
  it("warns on Edit of the project-scoped file, returning the lesson id", async () => {
    const e = entity("file:argus::src/gen/schema.ts", "Argus");
    const id = lesson({ files: [e], evidence: 3 });
    const item = (await matcher()).match(edit("C:\\Users\\lo\\Argus\\src\\gen\\schema.ts"));
    expect(item).toMatchObject({ severity: "warn", kind: "lesson", lessonId: id });
    expect(item?.text).toContain(id);
  });

  it("matches an absolute-path entity only for that exact path", async () => {
    const e = entity("file:c:/users/lo/argus/src/a.ts");
    lesson({ files: [e] });
    const m = await matcher();
    expect(m.match(edit("C:/Users/lo/Argus/src/a.ts"))).not.toBeNull();
    expect(m.match(edit("C:/Users/lo/Argus/src/b.ts"))).toBeNull();
  });

  it("ignores a bare, unattributed basename entity (identity is project + path)", async () => {
    const e = entity("file:readme.md", ""); // legacy global shape
    lesson({ files: [e] });
    expect((await matcher()).match(edit("C:/Users/lo/Argus/README.md"))).toBeNull();
  });

  it("an unattested lesson (2 evidence, never confirmed) stays silent on a file edit", async () => {
    const e = entity("file:argus::src/a.ts", "Argus");
    lesson({ files: [e], evidence: 2 });
    expect((await matcher()).match(edit("C:/Users/lo/Argus/src/a.ts"))).toBeNull();
  });

  it("ignores superseded lessons and lessons with an empty trigger", async () => {
    const e = entity("file:argus::src/a.ts", "Argus");
    lesson({ files: [e], superseded: true });
    lesson({ files: [] });
    expect((await matcher()).match(edit("C:/Users/lo/Argus/src/a.ts"))).toBeNull();
  });

  it("an edit outside the project's cwd does not match a project-relative file", async () => {
    const e = entity("file:argus::src/a.ts", "Argus");
    lesson({ files: [e] });
    expect((await matcher()).match(edit("C:/Other/repo/src/a.ts"))).toBeNull();
  });
});

describe("hard project scoping", () => {
  it("never returns another project's lesson, even for the same file", async () => {
    const e = entity("file:argus::src/a.ts", "Argus");
    lesson({ files: [e], project: "Argus" });
    const item = (await matcher()).match(edit("C:/Users/lo/Argus/src/a.ts", { project: "Sofia-AI" }));
    expect(item).toBeNull();
  });

  it("ignores lessons whose project is junk ('src', 'AI', digits, '')", async () => {
    const e = entity("file:c:/users/lo/argus/src/a.ts");
    for (const project of ["src", "AI", "1784133718303", "", "tdd-canary-1783984256573"]) {
      lesson({ files: [e], project });
    }
    expect((await matcher()).match(edit("C:/Users/lo/Argus/src/a.ts"))).toBeNull();
  });

  it("a request with a junk project gets nothing", async () => {
    const e = entity("file:c:/users/lo/argus/src/a.ts");
    lesson({ files: [e] });
    expect((await matcher()).match(edit("C:/Users/lo/Argus/src/a.ts", { project: "src" }))).toBeNull();
  });

  it("project comparison ignores case/Unicode form", async () => {
    const e = entity("file:argus::src/a.ts", "Argus");
    lesson({ files: [e], project: "ARGUS" });
    expect((await matcher()).match(edit("C:/Users/lo/Argus/src/a.ts", { project: "argus" }))).not.toBeNull();
  });
});

describe("stance-interrupt (4.4): deny only for attested lesson AND one-way action", () => {
  const cmd = "rm -rf src/gen/schema.ts";
  function setup(o: LessonOpts): string {
    const e = entity("file:argus::src/gen/schema.ts", "Argus");
    return lesson({ files: [e], ...o });
  }

  it("attested (3 evidence) + one-way + trusted → deny with lesson id and confirm/reject hooks", async () => {
    const id = setup({ evidence: 3 });
    const item = (await matcher()).match(bash(cmd, { oneWay: "rm -r" }));
    expect(item).toMatchObject({ severity: "deny", lessonId: id });
    expect(item?.text).toContain(`tdai_stance_confirmed(lesson_id:"${id}")`);
  });

  it("attested by confirmation (2 evidence, 1 confirmed) → deny", async () => {
    setup({ evidence: 2, confirmed: 1 });
    expect((await matcher()).match(bash(cmd, { oneWay: "rm -r" }))?.severity).toBe("deny");
  });

  it("one-way but NOT attested → warning only", async () => {
    setup({ evidence: 2 });
    expect((await matcher()).match(bash(cmd, { oneWay: "rm -r" }))?.severity).toBe("warn");
  });

  it("attested but NOT one-way → warning only", async () => {
    setup({ evidence: 5 });
    expect((await matcher()).match(bash("cat src/gen/schema.ts"))?.severity).toBe("warn");
  });

  it("a demoted stance (cried wolf) never denies; a suppressed one is silent", async () => {
    setup({ evidence: 5, willingness: 0.3 });
    const m1 = await matcher();
    expect(m1.match(bash(cmd, { oneWay: "rm -r" }))?.severity).toBe("warn");
    db.prepare("UPDATE lessons SET stance_willingness = 0.1").run();
    const m2 = await matcher();
    expect(m2.match(bash(cmd, { oneWay: "rm -r" }))).toBeNull();
  });

  it("denies once per session and lesson (the retry after confirmation goes through)", async () => {
    setup({ evidence: 3 });
    const m = await matcher();
    const r = bash(cmd, { oneWay: "rm -r", sessionKey: "same" });
    expect(m.match(r)?.severity).toBe("deny");
    expect(m.match(r)).toBeNull();
  });

  it("an earlier warning does not hide a later one-way deny", async () => {
    setup({ evidence: 3 });
    const m = await matcher();
    expect(m.match(bash("cat src/gen/schema.ts", { sessionKey: "S" }))?.severity).toBe("warn");
    expect(m.match(bash(cmd, { oneWay: "rm -r", sessionKey: "S" }))?.severity).toBe("deny");
  });
});

describe("recurring bug events (≥2, same project, same command head / file)", () => {
  it("warns on a command that already failed twice in this project", async () => {
    bug("Argus", "npm run build:cc-plugin --silent");
    const last = bug("Argus", "npm run build:cc-plugin --verbose");
    const item = (await matcher()).match(bash("npm run build:cc-plugin"));
    expect(item).toMatchObject({ severity: "warn", kind: "recurring-bug", eventId: last });
    expect(item?.text).toContain("2×");
  });

  it("one failure is an anecdote: silent", async () => {
    bug("Argus", "npm run build:cc-plugin");
    expect((await matcher()).match(bash("npm run build:cc-plugin"))).toBeNull();
  });

  it("failures in ANOTHER project (or a junk project) do not count", async () => {
    bug("Sofia-AI", "npm run build:cc-plugin");
    bug("Sofia-AI", "npm run build:cc-plugin");
    bug("src", "npm run build:cc-plugin");
    bug("src", "npm run build:cc-plugin");
    const m = await matcher();
    expect(m.match(bash("npm run build:cc-plugin"))).toBeNull();
    expect(m.match(bash("npm run build:cc-plugin", { project: "Sofia-AI" }))).not.toBeNull();
  });

  it("never warns on generic read-only commands", async () => {
    bug("Argus", "ls -d /x");
    bug("Argus", "ls -d /y");
    bug("Argus", "git status -s");
    bug("Argus", "git status -sb");
    const m = await matcher();
    expect(m.match(bash("ls -d /z"))).toBeNull();
    expect(m.match(bash("git status"))).toBeNull();
  });

  it("matches a file that failed twice via its project-scoped file entity", async () => {
    const e = entity("file:argus::src/flaky.ts", "Argus");
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO events (id, ts, session_key, project, type, text, entities_json)
         VALUES (?, 'x', 'sk', 'Argus', 'bug', 'Edit failed on flaky.ts', ?)`,
      ).run(`evt_f${i}`, JSON.stringify([e]));
    }
    expect((await matcher()).match(edit("C:/Users/lo/Argus/src/flaky.ts"))?.kind).toBe("recurring-bug");
  });

  it("a lesson wins over a recurring-bug item", async () => {
    const e = entity("file:argus::npm-scripts.json", "Argus");
    const id = lesson({ files: [e] });
    bug("Argus", "npm run build:cc-plugin npm-scripts.json");
    bug("Argus", "npm run build:cc-plugin npm-scripts.json");
    expect((await matcher()).match(bash("npm run build:cc-plugin npm-scripts.json"))?.lessonId).toBe(id);
  });
});

describe("failure phase (4.3)", () => {
  it("returns the lesson whose error signature appears in the failure text", async () => {
    const id = lesson({ sigs: ["ECONNREFUSED"], text: "Start the gateway first" });
    const item = (await matcher()).match(
      bash("curl localhost:8421", { phase: "failure", errorText: "curl: connect ECONNREFUSED 127.0.0.1" }),
    );
    expect(item).toMatchObject({ kind: "lesson", lessonId: id, severity: "warn" });
  });

  it("HTTP_500 signature matches a bare 500 in the error, not 5000", async () => {
    lesson({ sigs: ["HTTP_500"] });
    const m = await matcher();
    expect(m.match(bash("curl x", { phase: "failure", errorText: "status 500 Internal" }))).not.toBeNull();
    expect(m.match(bash("curl y", { phase: "failure", errorText: "status 5000" }))).toBeNull();
  });

  it("never denies in the failure phase", async () => {
    const e = entity("file:argus::src/gen/schema.ts", "Argus");
    lesson({ files: [e], evidence: 9 });
    const item = (await matcher()).match(
      bash("rm -rf src/gen/schema.ts", { phase: "failure", oneWay: "rm -r", errorText: "denied" }),
    );
    expect(item?.severity).toBe("warn");
  });

  it("error-signature lessons do not fire in the pre phase", async () => {
    lesson({ sigs: ["ECONNREFUSED"] });
    expect((await matcher()).match(bash("curl localhost:8421"))).toBeNull();
  });
});

describe("dedupe, fail-open and freshness", () => {
  it("speaks once per session, again in a new session", async () => {
    const e = entity("file:argus::src/a.ts", "Argus");
    lesson({ files: [e] });
    const m = await matcher();
    const r = edit("C:/Users/lo/Argus/src/a.ts", { sessionKey: "A" });
    expect(m.match(r)).not.toBeNull();
    expect(m.match(r)).toBeNull();
    expect(m.match({ ...r, sessionKey: "B" })).not.toBeNull();
  });

  it("before the first index is built, match() answers null without touching the DB", () => {
    const source = createPretoolSource(db);
    const spy = vi.spyOn(source, "listHeadLessons");
    const m = new PretoolMatcher(source);
    expect(m.match(edit("C:/Users/lo/Argus/src/a.ts"))).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // the build yields before its first query
  });

  it("a request never queries the DB once the index is built", async () => {
    const e = entity("file:argus::src/a.ts", "Argus");
    lesson({ files: [e] });
    const source = createPretoolSource(db);
    const m = new PretoolMatcher(source);
    await m.warm();
    const spies = [vi.spyOn(source, "listHeadLessons"), vi.spyOn(source, "listFileEntities"), vi.spyOn(source, "listBugEvents")];
    for (let i = 0; i < 50; i++) m.match(edit("C:/Users/lo/Argus/src/a.ts"));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("refreshes at most every 5 minutes", async () => {
    let t = 1_000;
    const source = createPretoolSource(db);
    const spy = vi.spyOn(source, "listHeadLessons");
    const m = new PretoolMatcher(source, { now: () => t });
    await m.warm();
    t += 4 * 60_000;
    await m.warm();
    expect(spy).toHaveBeenCalledTimes(1);
    t += 2 * 60_000;
    await m.warm();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a failing refresh keeps the old index and does not retry in a hot loop", async () => {
    const e = entity("file:argus::src/a.ts", "Argus");
    lesson({ files: [e] });
    let t = 0;
    const source = createPretoolSource(db);
    const m = new PretoolMatcher(source, { now: () => t, logger: { warn: () => {} } });
    await m.warm();
    t += 6 * 60_000;
    const spy = vi.spyOn(source, "listHeadLessons").mockImplementation(() => { throw new Error("db locked"); });
    await m.warm();
    expect(m.match(edit("C:/Users/lo/Argus/src/a.ts"))).not.toBeNull(); // old index still serves
    await m.warm();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("pages through many bug events (more than one page)", async () => {
    for (let i = 0; i < 1_200; i++) bug("Argus", i % 2 === 0 ? "npm run lint:fix" : "other tool run");
    expect((await matcher()).match(bash("npm run lint:fix"))?.text).toContain("600×");
  });
});

describe("commandHead", () => {
  it("uses the signature-normalized first segment, ≤3 tokens", () => {
    expect(commandHeadOfRaw("FOO=1 npm run build:cc-plugin && echo done")).toBe("npm run build:cc-plugin");
    expect(commandHead("git push origin main --force")).toBe("git push origin");
  });
  it("is null for single-token and read-only commands", () => {
    expect(commandHead("make")).toBeNull();
    expect(commandHead("ls -la")).toBeNull();
    expect(commandHead("git diff head")).toBeNull();
  });
});

describe("PretoolService: logging and batched counters (4.4)", () => {
  function service() {
    const info: string[] = [];
    const counters = { recordLessonExposure: vi.fn(), recordStanceFire: vi.fn() };
    const svc = new PretoolService({
      logger: { info: (m) => info.push(m), warn: () => {} },
      source: createPretoolSource(db),
      counters,
    });
    return { svc, info, counters };
  }

  it("logs every hit with the lesson id and defers the counter write off the request path", async () => {
    const e = entity("file:argus::src/gen/schema.ts", "Argus");
    const id = lesson({ files: [e], evidence: 3 });
    const { svc, info, counters } = service();
    await svc.warm();
    const item = svc.check(bash("rm -rf src/gen/schema.ts", { oneWay: "rm -r", sessionKey: "S9" }));
    expect(item?.severity).toBe("deny");
    expect(info.some((l) => l.includes("deny") && l.includes(`lesson=${id}`))).toBe(true);
    expect(counters.recordLessonExposure).not.toHaveBeenCalled(); // not inline
    svc.flush();
    expect(counters.recordLessonExposure).toHaveBeenCalledWith(id, "S9", expect.any(String));
    expect(counters.recordStanceFire).toHaveBeenCalledWith(id, expect.any(String));
  });

  it("a warning counts the exposure but not a stance fire; recurring-bug hits have no counter", async () => {
    const e = entity("file:argus::src/a.ts", "Argus");
    const id = lesson({ files: [e] });
    bug("Argus", "npm run flaky:task");
    bug("Argus", "npm run flaky:task");
    const { svc, counters } = service();
    await svc.warm();
    svc.check(edit("C:/Users/lo/Argus/src/a.ts", { sessionKey: "S1" }));
    svc.check(bash("npm run flaky:task", { sessionKey: "S1" }));
    svc.flush();
    expect(counters.recordLessonExposure).toHaveBeenCalledTimes(1);
    expect(counters.recordLessonExposure).toHaveBeenCalledWith(id, "S1", expect.any(String));
    expect(counters.recordStanceFire).not.toHaveBeenCalled();
  });

  it("a throwing counter never throws out of check()/flush()", async () => {
    const e = entity("file:argus::src/a.ts", "Argus");
    lesson({ files: [e] });
    const warn = vi.fn();
    const svc = new PretoolService({
      logger: { info: () => {}, warn },
      source: createPretoolSource(db),
      counters: { recordLessonExposure: () => { throw new Error("disk full"); } },
    });
    await svc.warm();
    expect(() => svc.check(edit("C:/Users/lo/Argus/src/a.ts"))).not.toThrow();
    expect(() => svc.flush()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
