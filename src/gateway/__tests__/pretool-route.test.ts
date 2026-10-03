/**
 * Phase 4 through a REAL TdaiGateway (ephemeral temp data dir, never the live DB):
 *   POST /pretool                         warn / deny / none, project-scoped
 *   POST /observe (failed tool call)      appends the matching lesson (4.3)
 *   POST /observe skip_file_memory        no <file-memory> post-hoc (4.6)
 *   p95 of the end-to-end HTTP round trip over a synthetic DB < 300 ms
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TdaiGateway } from "../server.js";
import { parseConfig } from "../../config.js";
import type { TdaiCore } from "../../core/tdai-core.js";
import { insertEvent, resolveOrCreateEntity } from "../../core/kb/kb-queries.js";
import { insertLesson } from "../../core/kb/lessons-writer.js";

const PORT = 18432;
const TOKEN = "pretool-test-token";
const NOW = "2026-10-03T10:00:00.000Z";
const CWD = "C:\\Users\\lo\\Argus";

async function post(pathname: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path: pathname, method: "POST",
        headers: {
          "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(text); } catch { json = { raw: text }; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("POST /pretool + failure recall + file-memory move", () => {
  let gateway: TdaiGateway;
  let db: DatabaseSync;
  let dir: string;
  let lessonId: string;

  function seedProject(project: string, files: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < files; i++) {
      ids.push(resolveOrCreateEntity(db, { type: "file", name: `src/mod${i}.ts`, project, now: NOW }).id);
    }
    return ids;
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gw-pretool-"));
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
      data: { baseDir: dir },
      llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "unused" },
      memory: parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } }),
    });
    await gateway.start();
    const core = (gateway as unknown as { core: TdaiCore }).core;
    await (core as unknown as { storeReady?: Promise<void> }).storeReady;
    db = (core.getVectorStore() as unknown as { db: DatabaseSync }).db;

    // Argus: one attested lesson on src/gen/schema.ts (+ a decoy for another project on the same path).
    const argusFile = resolveOrCreateEntity(db, { type: "file", name: "src/gen/schema.ts", project: "Argus", now: NOW }).id;
    const otherFile = resolveOrCreateEntity(db, { type: "file", name: "src/gen/schema.ts", project: "Sofia-AI", now: NOW }).id;
    lessonId = insertLesson(db, {
      project: "Argus", domain: "build",
      triggerPattern: JSON.stringify({ files: [argusFile], error_signatures: ["ECONNREFUSED"], task_type: "" }),
      lessonText: "schema.ts is generated: change the generator, never the file",
      evidenceEventIds: ["e1", "e2", "e3"], confidence: 0.8, now: NOW,
    }).id;
    insertLesson(db, {
      project: "Sofia-AI", domain: "build",
      triggerPattern: JSON.stringify({ files: [otherFile], error_signatures: [], task_type: "" }),
      lessonText: "SOFIA-ONLY lesson", evidenceEventIds: ["e1", "e2", "e3"], confidence: 0.8, now: NOW,
    });
    // Synthetic volume for the latency test: 60 projects x 40 files, 6000 bug events, 600 lessons.
    for (let p = 0; p < 60; p++) {
      const project = `Synthetic-${String.fromCharCode(97 + (p % 26))}${String.fromCharCode(97 + Math.floor(p / 26))}app`;
      const fileIds = seedProject(project, 40);
      for (let i = 0; i < 100; i++) {
        insertEvent(db, {
          ts: NOW, sessionKey: `sk${p}`, project, type: "bug", text: `Bash failed on \`npm run task${i % 7} --flag\`: exit code 1`,
          entities: [fileIds[i % 40], `signature:Bash|npm run task${i % 7} --flag|exit code #`],
        });
      }
      for (let i = 0; i < 10; i++) {
        insertLesson(db, {
          project, domain: "build",
          triggerPattern: JSON.stringify({ files: [fileIds[i]], error_signatures: [], task_type: "" }),
          lessonText: `lesson ${p}-${i}`, evidenceEventIds: ["a", "b", "c"], now: NOW,
        });
      }
    }
    // Do not wait for the 3 s warm-up timer: build the index now.
    await (gateway as unknown as { getPretool(): { warm(): Promise<void> } }).getPretool().warm();
  }, 120_000);

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = { session_key: "sess-1", project: "Argus", cwd: CWD };

  it("400 without the required fields", async () => {
    expect((await post("/pretool", { session_key: "s" })).status).toBe(400);
  });

  it("warns on Edit of the file a lesson is about, naming the lesson id", async () => {
    const res = await post("/pretool", {
      ...base, tool_name: "Edit", tool_input: { file_path: "C:\\Users\\lo\\Argus\\src\\gen\\schema.ts" },
    });
    expect(res.status).toBe(200);
    expect(res.json.decision).toBe("warn");
    expect(res.json.lesson_id).toBe(lessonId);
    expect(String(res.json.message)).toContain("generator");
  });

  it("never serves the other project's lesson for the same path", async () => {
    const res = await post("/pretool", {
      ...base, session_key: "sess-2", project: "Sofia-AI", cwd: "C:\\Users\\lo\\Sofia-AI",
      tool_name: "Edit", tool_input: { file_path: "C:\\Users\\lo\\Sofia-AI\\src\\gen\\schema.ts" },
    });
    expect(String(res.json.message)).not.toContain("generator");
    expect(String(res.json.message)).toContain("SOFIA-ONLY");
    const arg = await post("/pretool", {
      ...base, session_key: "sess-3", tool_name: "Edit",
      tool_input: { file_path: "C:\\Users\\lo\\Argus\\src\\gen\\schema.ts" },
    });
    expect(String(arg.json.message)).not.toContain("SOFIA-ONLY");
  });

  it("denies an attested lesson's file when the plugin marks the action one-way, and counts it", async () => {
    const res = await post("/pretool", {
      ...base, session_key: "sess-deny", tool_name: "Bash",
      tool_input: { command: "rm -rf src/gen/schema.ts" }, one_way: "rm -r",
    });
    expect(res.json.decision).toBe("deny");
    expect(res.json.lesson_id).toBe(lessonId);
    // counters are flushed off the request path (<= 1 s timer); force it, then read.
    (gateway as unknown as { getPretool(): { flush(): void } }).getPretool().flush();
    const row = db.prepare("SELECT exposure_count e, stance_fire_count f FROM lessons WHERE id = ?").get(lessonId) as { e: number; f: number };
    expect(row.e).toBeGreaterThanOrEqual(2);
    expect(row.f).toBe(1);
  });

  it("answers decision none for an unrelated tool call", async () => {
    const res = await post("/pretool", { ...base, tool_name: "Edit", tool_input: { file_path: "C:\\Users\\lo\\Argus\\README.md" } });
    expect(res.json).toEqual({ decision: "none", message: "" });
  });

  it("4.3: a failed /observe returns the lesson whose error signature matches", async () => {
    const res = await post("/observe", {
      session_key: "sess-fail", project: "Argus", cwd: CWD, tool_name: "Bash",
      tool_input: { command: "curl localhost:8421/health" },
      tool_output_is_error: true, tool_output_text: "curl: (7) connect ECONNREFUSED 127.0.0.1:8421",
    });
    expect(res.status).toBe(200);
    expect(String(res.json.context)).toContain(lessonId);
  });

  it("4.3: a successful /observe never adds a past-fix block", async () => {
    const res = await post("/observe", {
      session_key: "sess-ok", project: "Argus", cwd: CWD, tool_name: "Bash",
      tool_input: { command: "curl localhost:8421/health" }, tool_output_is_error: false,
    });
    expect(res.json.context).toBe("");
  });

  it("4.6: skip_file_memory suppresses the post-hoc <file-memory> block; without it the legacy path still fires", async () => {
    const file = "C:/Users/lo/Argus/src/mod3.ts";
    const ent = resolveOrCreateEntity(db, { type: "file", name: "mod3.ts", project: "Argus", now: NOW });
    const store = (gateway as unknown as { core: TdaiCore }).core.getVectorStore()!;
    store.setSessionProject!("sess-fm1", "Argus");
    store.setSessionProject!("sess-fm2", "Argus");
    db.prepare(
      `INSERT INTO facts (id, entity_id, attribute, value, valid_from, learned_at, namespace, created_time)
       VALUES ('f1', ?, 'owner', 'argus team', ?, ?, 'default', ?)`,
    ).run(ent.id, NOW, NOW, NOW);

    const skipped = await post("/observe", {
      session_key: "sess-fm1", project: "Argus", cwd: CWD, tool_name: "Edit",
      tool_input: { file_path: file }, skip_file_memory: true,
    });
    expect(String(skipped.json.context)).not.toContain("file-memory");

    const legacy = await post("/observe", {
      session_key: "sess-fm2", project: "Argus", cwd: CWD, tool_name: "Edit",
      tool_input: { file_path: file },
    });
    expect(String(legacy.json.context)).toContain("file-memory");
  });

  it("p95 of the end-to-end /pretool round trip over a synthetic DB is under 300 ms", async () => {
    const times: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t0 = performance.now();
      const res = await post("/pretool", {
        session_key: `lat-${i}`, project: "Argus", cwd: CWD, tool_name: i % 2 ? "Edit" : "Bash",
        tool_input: i % 2 ? { file_path: `C:\\Users\\lo\\Argus\\src\\gen\\schema.ts` } : { command: `npm run task${i % 7} --flag` },
      });
      times.push(performance.now() - t0);
      expect(res.status).toBe(200);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    process.stderr.write(`[pretool latency] n=${times.length} p50=${times[150].toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${times[times.length - 1].toFixed(1)}ms
`);
    expect(p95).toBeLessThan(300);
  }, 60_000);
});
