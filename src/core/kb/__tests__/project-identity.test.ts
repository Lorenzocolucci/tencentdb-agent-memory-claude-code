/**
 * Live 04/10/2026: asked "come funziona il capture inbox di Sinapsys" in
 * tencentdb-agent-memory, recall found nothing — the memories existed but were
 * captured in Sofia-AI / RISTRUTTURAZIONE sessions, and scope by place hid them.
 * A memory from another project that names THIS project's identity stays in scope.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../../store/sqlite.js";
import { otherProjectKeys } from "../selective-store.js";
import { clearProjectIdentityCache, projectIdentityIds } from "../project-identity.js";

const NOW = "2026-10-05T10:00:00.000Z";
let dir: string;
let store: VectorStore;
let db: DatabaseSync;

const ent = (id: string, name: string, type = "project") =>
  db.prepare("INSERT INTO entities (id, type, name, canonical_key, namespace, project, aliases_json, importance, created_time, updated_time) VALUES (?, ?, ?, ?, 'default', '', '[]', 50, ?, ?)")
    .run(id, type, name, `${type}:${name.toLowerCase()}`, NOW, NOW);
let n = 0;
const evt = (project: string, entities: string[], id = `ev${n++}`) => {
  db.prepare("INSERT INTO events (id, ts, recorded_at, session_key, project, type, text, entities_json) VALUES (?, ?, ?, 'sk', ?, 'event', 'x', ?)")
    .run(id, NOW, NOW, project, JSON.stringify(entities));
  return id;
};
const fact = (id: string, entityId: string, sourceEventId: string) =>
  db.prepare("INSERT INTO facts (id, entity_id, attribute, value, valid_from, learned_at, source_event_id, confidence, created_time) VALUES (?, ?, 'a', 'b', ?, ?, ?, 0.7, ?)")
    .run(id, entityId, NOW, NOW, sourceEventId, NOW);

beforeEach(() => {
  clearProjectIdentityCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-identity-"));
  store = new VectorStore(path.join(dir, "vectors.db"), 4);
  store.init({ provider: "openai", model: "text-embedding-3-small" });
  db = (store as unknown as { db: DatabaseSync }).db;
  ent("e-sin", "Sinapsys");
  ent("e-sofia", "Sofia");
  ent("e-lib", "Postgres", "project"); // mentioned everywhere: not anybody's identity
  ent("e-concept", "gateway", "concept"); // not a project-type entity
  for (let i = 0; i < 10; i++) evt("mem", ["e-sin", "e-lib", "e-concept"]);
  for (let i = 0; i < 20; i++) evt("Sofia-AI", ["e-sofia", "e-lib"]);
  for (let i = 0; i < 2; i++) evt("Sofia-AI", ["e-sin"]); // Sinapsys work done from a Sofia session
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("projectIdentityIds", () => {
  it("learns the names a project uses for itself, not shared libraries or concepts", () => {
    expect([...projectIdentityIds(db, "mem")]).toEqual(["e-sin"]);
    expect([...projectIdentityIds(db, "Sofia-AI")]).toEqual(["e-sofia"]);
  });
  it("an unknown or empty project has no identity", () => {
    expect(projectIdentityIds(db, "nope").size).toBe(0);
    expect(projectIdentityIds(db, "").size).toBe(0);
  });
});

describe("otherProjectKeys keeps memories ABOUT the current project", () => {
  it("a Sofia-AI event that names Sinapsys stays in scope for the Sinapsys repo; plain Sofia work does not", () => {
    const about = evt("Sofia-AI", ["e-sin"], "ev-about");
    const plain = evt("Sofia-AI", ["e-sofia"], "ev-plain");
    const out = otherProjectKeys(db, [
      { owner_id: about, owner_kind: "event" },
      { owner_id: plain, owner_kind: "event" },
    ], "mem");
    expect([...out]).toEqual(["event:ev-plain"]);
  });
  it("a fact on the identity entity, extracted in another project, stays in scope", () => {
    const src = evt("Sofia-AI", ["e-sofia"], "ev-src");
    fact("f-sin", "e-sin", src);
    fact("f-sofia", "e-sofia", src);
    const out = otherProjectKeys(db, [
      { owner_id: "f-sin", owner_kind: "fact" },
      { owner_id: "f-sofia", owner_kind: "fact" },
    ], "mem");
    expect([...out]).toEqual(["fact:f-sofia"]);
  });
  it("the scope stays hard for memories that are not about the project", () => {
    const lib = evt("Sofia-AI", ["e-lib"], "ev-lib");
    expect([...otherProjectKeys(db, [{ owner_id: lib, owner_kind: "event" }], "mem")]).toEqual(["event:ev-lib"]);
  });
});
