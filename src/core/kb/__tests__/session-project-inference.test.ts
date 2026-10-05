/**
 * Live 05/10/2026: a Sofia rule from an untagged claude.ai chat ("se il caller è un
 * known_client…") was injected into a Sinapsys session — 38% of events have no project
 * and "no project" meant "shown everywhere". The session's project is now inferred
 * from what its memories talk about, through the real store.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../../store/sqlite.js";
import { otherProjectKeys, ownerProjects } from "../selective-store.js";
import { clearSessionProjectCache, inferredSessionProject } from "../session-project-inference.js";
import { clearProjectIdentityCache } from "../project-identity.js";

const NOW = "2026-10-01T10:00:00.000Z";
let dir: string;
let store: VectorStore;
let db: DatabaseSync;
let n = 0;

const ent = (id: string, type = "concept") =>
  db.prepare("INSERT INTO entities (id, type, name, canonical_key, namespace, project, aliases_json, importance, created_time, updated_time) VALUES (?, ?, ?, ?, 'default', '', '[]', 50, ?, ?)")
    .run(id, type, id, `${type}:${id.toLowerCase()}`, NOW, NOW);
const evt = (sessionKey: string, project: string, entities: string[], id = `ev${++n}`) => {
  db.prepare("INSERT INTO events (id, ts, recorded_at, session_key, project, type, text, entities_json) VALUES (?, ?, ?, ?, ?, 'event', 't', ?)")
    .run(id, NOW, NOW, sessionKey, project, JSON.stringify(entities));
  return id;
};

beforeEach(() => {
  clearSessionProjectCache();
  clearProjectIdentityCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-sessproj-"));
  store = new VectorStore(path.join(dir, "vectors.db"), 4);
  store.init({ provider: "openai", model: "text-embedding-3-small" });
  db = (store as unknown as { db: DatabaseSync }).db;
  for (const e of ["caller", "known_client", "studio", "recall_gate", "worker", "lorenzo", "lesson_plan"]) ent(e);
  // Tagged history teaches the vocabulary: Sofia talks of callers, Sinapsys of recall.
  for (let i = 0; i < 4; i++) evt("sk-sofia", "Sofia-AI", ["caller", "known_client", "studio", "lorenzo"]);
  for (let i = 0; i < 4; i++) evt("sk-sin", "tencentdb-agent-memory", ["recall_gate", "worker", "lorenzo"]);
  // A third, bigger project: base rates like the live memory (no project is half of it).
  for (let i = 0; i < 10; i++) evt("sk-tutor", "Tutor-Agent", ["lesson_plan"]);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("an untagged chat belongs to the project it talks about", () => {
  it("a Sofia chat's rule is out of scope in Sinapsys and in scope in Sofia", () => {
    const rule = evt("chatimport_a", "", ["known_client"]);
    evt("chatimport_a", "", ["caller", "studio"]);
    evt("chatimport_a", "", ["caller", "lorenzo"]);
    expect(inferredSessionProject(db, "chatimport_a")).toBe("Sofia-AI");
    const owners = [{ owner_id: rule, owner_kind: "event" }];
    expect(ownerProjects(db, owners).get(`event:${rule}`)?.project).toBe("Sofia-AI");
    expect([...otherProjectKeys(db, owners, "tencentdb-agent-memory")]).toEqual([`event:${rule}`]);
    expect(otherProjectKeys(db, owners, "Sofia-AI").size).toBe(0);
  });

  it("weak or mixed evidence stays user-level (shown everywhere, as before)", () => {
    const thin = evt("chatimport_thin", "", ["caller"]); // one vote < MIN_VOTES
    evt("chatimport_mixed", "", ["caller", "studio"]);
    const mixed = evt("chatimport_mixed", "", ["recall_gate", "worker"]); // 2 vs 2
    const shared = evt("chatimport_shared", "", ["lorenzo", "lorenzo"]); // entity of both projects
    expect(inferredSessionProject(db, "chatimport_thin")).toBe("");
    expect(inferredSessionProject(db, "chatimport_mixed")).toBe("");
    expect(inferredSessionProject(db, "chatimport_shared")).toBe("");
    const owners = [thin, mixed, shared].map((id) => ({ owner_id: id, owner_kind: "event" }));
    expect(otherProjectKeys(db, owners, "tencentdb-agent-memory").size).toBe(0);
  });

  it("a session's own tag or registry always wins over inference", () => {
    db.prepare("INSERT INTO session_projects (session_key, project, updated_at) VALUES ('chatimport_reg', 'Tutor-Agent', ?)").run(NOW);
    const ev = evt("chatimport_reg", "", ["caller", "studio", "known_client"]);
    expect(ownerProjects(db, [{ owner_id: ev, owner_kind: "event" }]).get(`event:${ev}`)?.project).toBe("Tutor-Agent");
  });
});
