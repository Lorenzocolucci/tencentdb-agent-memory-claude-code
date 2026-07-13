import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { applyKbDelta } from "../kb-writer.js";
import { getLifecycle } from "../lifecycle-writer.js";
import { parseProvenance } from "../provenance.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("provenance is stamped at KB write time", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-prov-stamp-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("a freshly written event is stamped conversation/unverified", async () => {
    const result = await applyKbDelta(
      {
        language: "it",
        entities: [{ ref: "e1", type: "person", name: "Lorenzo" }],
        events: [{ ref: "ev1", type: "decision", ts: "2026-06-29T10:00:00.000Z",
                   text: "Decisione presa insieme.", entity_refs: ["e1"],
                   source_message_ids: ["l0_m1"] }],
        facts: [],
        relations: [],
      } as never,
      { store: store as never, namespace: "default", sessionKey: "s1",
        now: "2026-06-29T10:00:00.000Z", logger: silent },
    );

    const ev = result.events[0]!;
    const life = getLifecycle((store as never as { db: never }).db, ev.id, "event");
    expect(life, "lifecycle row must exist for the new event").not.toBeNull();
    const prov = parseProvenance(life!.provenance_json);
    expect(prov.origin).toBe("conversation");
    expect(prov.trust).toBe("unverified");
    expect(prov.source_message_ids).toEqual(["l0_m1"]);
  });
});
