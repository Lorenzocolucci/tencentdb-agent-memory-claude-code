import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { applyKbDelta } from "../../kb/kb-writer.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("associativeExpand — a memory surfaces because it is CONNECTED, not matched", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-30T20:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-assoc-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("seed entity Sofia → related entity BancaX surfaces BancaX's fact", async () => {
    // Sofia --uses--> BancaX ; BancaX has a fact (its IBAN). A query that recalls
    // Sofia should let BancaX's fact COME by association, though never named.
    const res = await applyKbDelta(
      {
        language: "it",
        entities: [
          { ref: "sofia", type: "project", name: "Sofia" },
          { ref: "banca", type: "concept", name: "BancaX" },
        ],
        facts: [
          { entity_ref: "banca", attribute: "iban", value: "IT60X0542811101000000123456", confidence: 0.7 },
        ],
        events: [],
        relations: [{ src_ref: "sofia", type: "uses", dst_ref: "banca" }],
      } as never,
      { store: store as never, namespace: "default", sessionKey: "s1", now, logger: silent },
    );

    const sofiaId = res.entities.find((e: { name: string }) => e.name === "Sofia")!.id;
    const bancaId = res.entities.find((e: { name: string }) => e.name === "BancaX")!.id;

    const assoc = store.associativeExpand([sofiaId], { hops: 2 });

    const hit = assoc.find((a) => a.entity_id === bancaId);
    expect(hit, "BancaX's memory must surface by association from Sofia").toBeTruthy();
    expect(hit!.text).toContain("IT60X0542811101000000123456");
    expect(hit!.activation).toBeGreaterThan(0);
    // the seed itself is never returned as an association
    expect(assoc.find((a) => a.entity_id === sofiaId)).toBeUndefined();
  });

  it("surfaces the SALIENT fact, not a noise metric (line_count/action_phase)", async () => {
    // BancaX has a noise metric with HIGH confidence and a real fact with lower
    // confidence. The association must surface the real fact, not the counter.
    const res = await applyKbDelta(
      {
        language: "it",
        entities: [
          { ref: "sofia", type: "project", name: "Sofia" },
          { ref: "banca", type: "concept", name: "BancaX" },
        ],
        facts: [
          { entity_ref: "banca", attribute: "line_count", value: "1068", confidence: 0.95 },
          { entity_ref: "banca", attribute: "iban", value: "IT60X0542811101000000123456", confidence: 0.7 },
        ],
        events: [],
        relations: [{ src_ref: "sofia", type: "uses", dst_ref: "banca" }],
      } as never,
      { store: store as never, namespace: "default", sessionKey: "s1", now, logger: silent },
    );
    const sofiaId = res.entities.find((e: { name: string }) => e.name === "Sofia")!.id;
    const hit = store.associativeExpand([sofiaId], { hops: 2 }).find((a) => a.text.includes("IT60") || a.text.includes("line_count"));
    expect(hit, "an association must surface").toBeTruthy();
    expect(hit!.text).toContain("IT60X0542811101000000123456");
    expect(hit!.text).not.toContain("line_count");
  });

  it("an isolated seed entity yields no associations", async () => {
    const res = await applyKbDelta(
      {
        language: "it",
        entities: [{ ref: "lonely", type: "concept", name: "Lonely" }],
        facts: [{ entity_ref: "lonely", attribute: "note", value: "no edges here", confidence: 0.7 }],
        events: [], relations: [],
      } as never,
      { store: store as never, namespace: "default", sessionKey: "s1", now, logger: silent },
    );
    const id = res.entities.find((e: { name: string }) => e.name === "Lonely")!.id;
    expect(store.associativeExpand([id], { hops: 2 })).toHaveLength(0);
  });
});
