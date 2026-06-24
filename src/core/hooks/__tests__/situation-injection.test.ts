/**
 * Track A 3+4 — file→memory match (the "inject" half), silent-unless-relevant.
 *
 * Given a file the agent just touched, surface what the graph already knows
 * about it: current facts + events referencing it. The golden rule: if the file
 * is unknown OR has nothing tied to it, return null (SILENCE — no noise). Run on
 * a REAL throwaway VectorStore so the KB queries are exercised for real.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { _resetUlidStateForTest } from "../../kb/kb-queries.js";
import { buildFileInjection } from "../situation-injection.js";

const DIMS = 4;
const NOW = "2026-06-24T10:00:00.000Z";
const FILE = "C:\\Sofia-AI\\src\\services\\circuit-breaker.ts";

describe("buildFileInjection", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-situation-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a file the graph has never seen (SILENCE)", () => {
    expect(buildFileInjection(store, "C:\\unknown\\nope.ts")).toBeNull();
  });

  it("returns null for a known file with no facts or events (SILENCE)", () => {
    store.resolveOrCreateEntity!({ type: "file", name: FILE, now: NOW });
    expect(buildFileInjection(store, FILE)).toBeNull();
  });

  it("surfaces facts and events tied to the file when they exist", () => {
    const ent = store.resolveOrCreateEntity!({ type: "file", name: FILE, now: NOW });
    store.upsertFact!({
      entityId: ent.id,
      attribute: "contains_circuit_breaker_code",
      value: "true",
      now: NOW,
    });
    store.insertEvent!({
      sessionKey: "sX",
      ts: NOW,
      type: "fix",
      text: "Configured errorFilter so 404 doesn't trip the breaker.",
      entities: [ent.id],
    });

    const out = buildFileInjection(store, FILE);
    expect(out).not.toBeNull();
    expect(out).toContain("file-memory");
    expect(out).toContain("contains_circuit_breaker_code");
    expect(out).toContain("errorFilter");
  });

  it("matches a file the KB stored by basename when touched via full path", () => {
    // The live KB sometimes stores file entities by basename only.
    const ent = store.resolveOrCreateEntity!({ type: "file", name: "whatsapp-sofia.ts", now: NOW });
    store.upsertFact!({ entityId: ent.id, attribute: "channel", value: "WhatsApp", now: NOW });

    const out = buildFileInjection(store, "C:\\Sofia-AI\\src\\services\\whatsapp-sofia.ts");
    expect(out).not.toBeNull();
    expect(out).toContain("channel");
  });

  it("matches regardless of path slash style (posix-normalized key)", () => {
    const ent = store.resolveOrCreateEntity!({ type: "file", name: FILE, now: NOW });
    store.upsertFact!({ entityId: ent.id, attribute: "owner", value: "Sofia", now: NOW });
    // Same file, forward slashes + different case → same canonical entity.
    const out = buildFileInjection(store, "c:/sofia-ai/src/services/circuit-breaker.ts");
    expect(out).not.toBeNull();
    expect(out).toContain("owner");
  });
});
