import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { isRealProjectKey, pickClusterProject } from "../project-key.js";
import { selectFailureClusters } from "../bug-clusters.js";
import { fakeEmbeddingReader } from "../bug-embeddings.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (p: string) => DatabaseSync };

describe("isRealProjectKey", () => {
  it.each(["Sofia-AI", "Argus", "sofia-dashboard", "tencentdb-agent-memory", "Tutor-Agent", "IMMIGRATO-PAKISTANI"])(
    "accepts %s",
    (p) => expect(isRealProjectKey(p)).toBe(true),
  );

  it.each([
    "", "  ", "src", "AI", "ai", "1784133718303", "0bb395", "2f89ff", "a1fec976bfecb14ab",
    "tdd-canary-1783984256573", "sofia-ai-1784154748839", "wizardly-bassi-226986", "web", "backend", "..",
  ])("rejects junk %j", (p) => expect(isRealProjectKey(p)).toBe(false));

  it("rejects non-strings", () => {
    expect(isRealProjectKey(undefined)).toBe(false);
    expect(isRealProjectKey(null)).toBe(false);
  });
});

describe("pickClusterProject", () => {
  it("takes the majority REAL key, ignoring junk even when junk comes first", () => {
    expect(pickClusterProject(["src", "Argus", "AI", "Argus", "Sofia-AI"])).toBe("Argus");
  });
  it("returns '' when nothing is real", () => {
    expect(pickClusterProject(["src", "AI", "", "123456"])).toBe("");
  });
  it("is deterministic on ties (alphabetical)", () => {
    expect(pickClusterProject(["Zeta-App", "Alpha-App"])).toBe("Alpha-App");
  });
});

describe("lessons.project derivation (4.5): cluster.project is the events' real project key", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DB(":memory:");
    db.prepare(
      `CREATE TABLE events (
         id TEXT PRIMARY KEY, ts TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
         session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
         namespace TEXT NOT NULL DEFAULT 'default', project TEXT NOT NULL DEFAULT '',
         type TEXT NOT NULL, text TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'und',
         entities_json TEXT NOT NULL DEFAULT '[]', source_message_ids_json TEXT NOT NULL DEFAULT '[]'
       )`,
    ).run();
    db.prepare(
      `CREATE TABLE relations (
         id TEXT PRIMARY KEY, src_entity_id TEXT NOT NULL, type TEXT NOT NULL,
         dst_entity_id TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT 'default',
         valid_from TEXT, valid_to TEXT, support INTEGER NOT NULL DEFAULT 1,
         source_event_id TEXT, created_time TEXT NOT NULL DEFAULT ''
       )`,
    ).run();
  });

  function bug(id: string, session: string, project: string): void {
    db.prepare(
      `INSERT INTO events (id, ts, recorded_at, session_key, project, type, text)
       VALUES (?, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', ?, ?, 'bug', ?)`,
    ).run(id, session, project, `bug ${id}`);
  }
  const vec = (): Float32Array => new Float32Array(16).fill(Math.sqrt(1 / 16));

  it("a junk first-event project ('src') no longer leaks into the cluster", () => {
    bug("a", "S1", "src"); // sorts first — the old code copied THIS value
    bug("b", "S2", "Argus");
    bug("c", "S3", "Argus");
    const reader = fakeEmbeddingReader(new Map([["a", vec()], ["b", vec()], ["c", vec()]]));
    const clusters = selectFailureClusters(db, { embeddingReader: reader });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].project).toBe("Argus");
  });

  it("all-junk projects give an empty project (never a fake one)", () => {
    bug("a", "S1", "AI");
    bug("b", "S2", "1784133718303");
    const reader = fakeEmbeddingReader(new Map([["a", vec()], ["b", vec()]]));
    expect(selectFailureClusters(db, { embeddingReader: reader })[0].project).toBe("");
  });
});
