import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { applyKbDelta } from "../../kb/kb-writer.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("candidateAdjacency — co-occurrence ∪ explicit relations (the dense layer)", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-30T21:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-adj-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("two entities co-occurring in an event become neighbors (even with NO explicit relation)", async () => {
    const res = await applyKbDelta(
      {
        language: "it",
        entities: [
          { ref: "a", type: "concept", name: "Alpha" },
          { ref: "b", type: "concept", name: "Beta" },
          { ref: "c", type: "concept", name: "Gamma" },
        ],
        // one event mentions BOTH Alpha and Beta → they co-occur; Gamma is alone.
        events: [
          { ref: "ev1", type: "observation", ts: now, text: "Alpha e Beta insieme",
            entity_refs: ["a", "b"], source_message_ids: ["l0_1"] },
          { ref: "ev2", type: "observation", ts: now, text: "Gamma da sola",
            entity_refs: ["c"], source_message_ids: ["l0_2"] },
        ],
        facts: [], relations: [],
      } as never,
      { store: store as never, namespace: "default", sessionKey: "s1", now, logger: silent },
    );
    const id = (n: string) => res.entities.find((e: { name: string }) => e.name === n)!.id;
    const A = id("Alpha"), B = id("Beta"), C = id("Gamma");

    const adj = store.candidateAdjacency([A, B, C]);
    const aN = (adj.get(A) ?? []).map((x) => x.id);
    expect(aN).toContain(B); // co-occurrence edge, no explicit relation needed
    expect(aN).not.toContain(C); // Gamma never co-occurred with Alpha
  });

  it("an explicit relation also yields an edge (union of both sources)", async () => {
    const res = await applyKbDelta(
      {
        language: "it",
        entities: [
          { ref: "x", type: "project", name: "Xeno" },
          { ref: "y", type: "concept", name: "Yotta" },
        ],
        events: [], facts: [],
        relations: [{ src_ref: "x", type: "uses", dst_ref: "y" }],
      } as never,
      { store: store as never, namespace: "default", sessionKey: "s1", now, logger: silent },
    );
    const id = (n: string) => res.entities.find((e: { name: string }) => e.name === n)!.id;
    const X = id("Xeno"), Y = id("Yotta");
    const adj = store.candidateAdjacency([X, Y]);
    expect((adj.get(X) ?? []).map((n) => n.id)).toContain(Y);
  });
});
