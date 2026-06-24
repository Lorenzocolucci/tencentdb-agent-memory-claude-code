/**
 * Context Fingerprint (Idea 1) — persistence round-trip.
 *
 * insertFingerprint persists one situation signature; queryRecentFingerprints
 * reads them back newest-first, bounded, namespace-scoped. Runs on a throwaway
 * in-memory DB with the real foundations schema (never the live vectors.db).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { initFoundationsSchema } from "../foundations-schema.js";
import { insertFingerprint, queryRecentFingerprints } from "../fingerprint-writer.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DB } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };

describe("fingerprint-writer", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DB(":memory:");
    initFoundationsSchema(db);
  });

  it("round-trips all fields", () => {
    insertFingerprint(db, {
      sessionKey: "s1",
      now: "2026-06-24T10:00:00.000Z",
      fileKeys: ["file:a.ts", "file:b.ts"],
      errorSignatures: ["Bash:exit1"],
      taskType: "debug",
      toolNames: ["Read", "Bash"],
      matchedOwnerIds: ["ent_1", "ent_2"],
    });
    const rows = queryRecentFingerprints(db, "default", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_key: "s1",
      ts: "2026-06-24T10:00:00.000Z",
      fileKeys: ["file:a.ts", "file:b.ts"],
      errorSignatures: ["Bash:exit1"],
      taskType: "debug",
      toolNames: ["Read", "Bash"],
      matchedOwnerIds: ["ent_1", "ent_2"],
      namespace: "default",
    });
    expect(rows[0].id).toMatch(/^fp_/);
  });

  it("returns rows newest-first by ts", () => {
    insertFingerprint(db, base({ now: "2026-06-24T10:00:00.000Z", fileKeys: ["file:old"] }));
    insertFingerprint(db, base({ now: "2026-06-24T12:00:00.000Z", fileKeys: ["file:new"] }));
    const rows = queryRecentFingerprints(db, "default", 10);
    expect(rows.map((r) => r.fileKeys[0])).toEqual(["file:new", "file:old"]);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 5; i++) {
      insertFingerprint(db, base({ now: `2026-06-24T10:0${i}:00.000Z`, fileKeys: [`file:f${i}`] }));
    }
    expect(queryRecentFingerprints(db, "default", 3)).toHaveLength(3);
  });

  it("scopes by namespace", () => {
    insertFingerprint(db, base({ namespace: "default", fileKeys: ["file:d"] }));
    insertFingerprint(db, base({ namespace: "other", fileKeys: ["file:o"] }));
    const rows = queryRecentFingerprints(db, "other", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].fileKeys).toEqual(["file:o"]);
  });

  it("defaults empty arrays cleanly", () => {
    insertFingerprint(db, {
      sessionKey: "s1",
      now: "2026-06-24T10:00:00.000Z",
      fileKeys: [],
      errorSignatures: [],
      taskType: "",
      toolNames: [],
      matchedOwnerIds: [],
    });
    const rows = queryRecentFingerprints(db, "default", 10);
    expect(rows[0]).toMatchObject({
      fileKeys: [],
      errorSignatures: [],
      toolNames: [],
      matchedOwnerIds: [],
      taskType: "",
    });
  });
});

/** Build an insert with sensible defaults overridden per-test. */
function base(over: Partial<Parameters<typeof insertFingerprint>[1]>): Parameters<typeof insertFingerprint>[1] {
  return {
    sessionKey: "s1",
    now: "2026-06-24T11:00:00.000Z",
    fileKeys: ["file:a"],
    errorSignatures: [],
    taskType: "",
    toolNames: ["Read"],
    matchedOwnerIds: [],
    ...over,
  };
}
