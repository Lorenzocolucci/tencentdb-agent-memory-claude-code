/**
 * recentProjectEvents on a real (temp) SQLite KB: the current project's latest events
 * inside a window, by tag or (untagged) by the session's registered project, newest
 * first, bounded — and the VectorStore delegator fails open.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../../store/sqlite.js";
import { recentProjectEvents } from "../selective-store.js";

const NOW = "2026-10-01T10:00:00.000Z";
let dir: string;
let store: VectorStore;
let db: DatabaseSync;

const evt = (id: string, sessionKey: string, project: string, ts: string, namespace = "default") =>
  db.prepare("INSERT INTO events (id, ts, recorded_at, session_key, namespace, project, type, text, entities_json) VALUES (?, ?, ?, ?, ?, ?, 'event', ?, '[]')")
    .run(id, ts, NOW, sessionKey, namespace, project, `text of ${id}`);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-recent-"));
  store = new VectorStore(path.join(dir, "vectors.db"), 4);
  store.init({ provider: "openai", model: "text-embedding-3-small" });
  db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare("INSERT INTO session_projects (session_key, project, updated_at) VALUES ('sk-argus', 'Argus', ?)").run(NOW);
  evt("tagged-new", "sk-x", "Argus", "2026-09-30T10:00:00.000Z");
  evt("registry", "sk-argus", "", "2026-09-29T10:00:00.000Z"); // untagged, session registered under Argus
  evt("tagged-case", "sk-y", "argus", "2026-09-28T10:00:00.000Z"); // label case differs
  evt("other", "sk-argus", "Sofia-AI", "2026-09-30T11:00:00.000Z"); // own tag wins over the registry
  evt("too-old", "sk-x", "Argus", "2026-08-01T10:00:00.000Z");
  evt("future", "sk-x", "Argus", "2026-10-05T10:00:00.000Z");
  evt("other-ns", "sk-x", "Argus", "2026-09-30T09:00:00.000Z", "elsewhere");
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const window = { beforeIso: NOW, sinceIso: "2026-09-17T10:00:00.000Z", limit: 10 };

describe("recentProjectEvents", () => {
  it("returns the project's events in the window, by tag or registry, newest first", () => {
    expect(recentProjectEvents(db, "Argus", window).map((e) => e.id)).toEqual(["tagged-new", "registry", "tagged-case"]);
  });

  it("respects the limit and an empty project", () => {
    expect(recentProjectEvents(db, "Argus", { ...window, limit: 1 }).map((e) => e.id)).toEqual(["tagged-new"]);
    expect(recentProjectEvents(db, "  ", window)).toEqual([]);
  });

  it("the store delegator answers the same and fails open when the KB is unavailable", () => {
    expect(store.recentProjectEvents("Argus", window).map((e) => e.id)).toEqual(["tagged-new", "registry", "tagged-case"]);
    db.prepare("DROP TABLE events").run();
    expect(store.recentProjectEvents("Argus", window)).toEqual([]);
  });
});

describe("veryCommonKbTokens", () => {
  it("returns the words more than N KB documents mention; unknown words are not very common", () => {
    const doc = (id: string, content: string) =>
      db.prepare("INSERT INTO kb_fts (content, content_original, owner_id, owner_kind, entity_type, namespace, attribute, updated_time) VALUES (?, ?, ?, 'fact', '', 'default', '', ?)")
        .run(content, content, id, NOW);
    doc("a", "deploy del worker");
    doc("b", "deploy fallito");
    doc("c", "deploy ok waba");
    expect([...store.veryCommonKbTokens(["deploy", "waba", "zzzz"], 2)]).toEqual(["deploy"]);
    expect(store.veryCommonKbTokens(["deploy"], 3).size).toBe(0);
  });
});
