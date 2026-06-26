/**
 * reindexAll({ resume }) — skip-already-embedded behavior.
 *
 * Ground truth (NON-circular): the test sets DB vector state directly (one record
 * keeps its vector, one has it deleted to simulate an interrupted reindex). The
 * assertion is which texts the embed fn is called with — driven by that DB state,
 * not by reindex's own output.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";

const DIMS = 4;

function normalize(values: number[]): Float32Array {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return new Float32Array(values.map((v) => v / mag));
}

function l0(id: string, messageText: string, ts: number) {
  return {
    id,
    sessionKey: "s",
    sessionId: "i",
    role: "user" as const,
    messageText,
    recordedAt: new Date(ts * 1000).toISOString(),
    timestamp: ts,
  };
}

describe("VectorStore.reindexAll resume mode (temp DB)", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-resume-test-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);

    // Two L0 records, both vectored…
    store.upsertL0(l0("l0-keep", "already embedded text", 1), [normalize([1, 0, 0, 0])]);
    store.upsertL0(l0("l0-missing", "needs embedding text", 2), [normalize([0, 1, 0, 0])]);
    // …then simulate an interrupted reindex: drop ONLY l0-missing's vector.
    (store as unknown as { db: { prepare: (q: string) => { run: (a: string) => void } } }).db
      .prepare("DELETE FROM l0_vec WHERE record_id = ?")
      .run("l0-missing");
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("resume:true embeds ONLY the record whose vector is missing", async () => {
    const embedded: string[] = [];
    await store.reindexAll(async (t) => { embedded.push(t); return normalize([0.5, 0.5, 0, 0]); }, undefined, { resume: true });

    expect(embedded).toContain("needs embedding text");      // the missing one is embedded
    expect(embedded).not.toContain("already embedded text"); // the embedded one is SKIPPED
  });

  it("resume off (default) re-embeds ALL records", async () => {
    const embedded: string[] = [];
    await store.reindexAll(async (t) => { embedded.push(t); return normalize([0.5, 0.5, 0, 0]); });

    expect(embedded).toContain("needs embedding text");
    expect(embedded).toContain("already embedded text");
  });

  it("resume reports progress for skipped records too (count stays accurate)", async () => {
    let lastL0Total = 0;
    let lastL0Done = 0;
    await store.reindexAll(
      async () => normalize([0.5, 0.5, 0, 0]),
      (done, total, layer) => { if (layer === "L0") { lastL0Done = done; lastL0Total = total; } },
      { resume: true },
    );
    // Both records are accounted for in progress, even though one was skipped.
    expect(lastL0Total).toBe(2);
    expect(lastL0Done).toBe(2);
  });
});
