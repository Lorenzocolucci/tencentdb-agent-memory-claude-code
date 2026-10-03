/**
 * A long nav-index read must not pin a read snapshot on the connection that WRITES.
 *
 * Measured 2026-10-03 (worker + gateway on one DB): while the nav index loaded through
 * `iterate()` on the writer's own connection, the other process committed, and the writer's next
 * `upsertL0` / `upsertKbVector` failed at once with "database is locked" (SQLITE_BUSY_SNAPSHOT) -
 * captures were dropped. `getAllKbVectorsAsync` therefore reads on a short-lived read-only connection.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";

const DIMS = 8;

function unit(seed: number): Float32Array {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const v = Array.from({ length: DIMS }, () => rand() * 2 - 1);
  const mag = Math.hypot(...v) || 1;
  return new Float32Array(v.map((x) => x / mag));
}

describe("nav-index read connection", () => {
  let dir: string;
  let dbPath: string;
  const opened: VectorStore[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-nav-readconn-"));
    dbPath = path.join(dir, "vectors.db");
  });
  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function open(): VectorStore {
    const s = new VectorStore(dbPath, DIMS);
    s.init({ provider: "openai", model: "m" });
    expect(s.isDegraded()).toBe(false);
    opened.push(s);
    return s;
  }

  /** Enough owners that getAllKbVectorsAsync yields to the event loop at least once. */
  function seed(n: number): VectorStore {
    const a = open();
    for (let i = 0; i < n; i++) a.upsertKbVector(`o_${i}`, "fact", [unit(i + 1)], "t");
    return a;
  }

  it("premise: a cursor held across yields on the writer's own connection makes its next write fail", async () => {
    const a = seed(1200);
    const other = open();
    (a as unknown as { openNavReadConnection: () => null }).openNavReadConnection = () => null; // old behaviour
    const loading = a.getAllKbVectorsAsync();
    await new Promise((r) => setImmediate(r)); // cursor is open, the first slice has been read
    expect(other.upsertKbVector("by_other_process", "fact", [unit(5000)], "t")).toBe(true);
    const wrote = a.upsertKbVector("by_writer", "fact", [unit(6000)], "t");
    await loading;
    expect(wrote).toBe(false); // SQLITE_BUSY_SNAPSHOT: this is what dropped worker captures
  });

  it("with the dedicated read connection the writer's next write succeeds and every row is still read", async () => {
    const a = seed(1200);
    const other = open();
    const loading = a.getAllKbVectorsAsync();
    await new Promise((r) => setImmediate(r));
    expect(other.upsertKbVector("by_other_process", "fact", [unit(5000)], "t")).toBe(true);
    expect(a.upsertKbVector("by_writer", "fact", [unit(6000)], "t")).toBe(true);
    const rows = await loading;
    expect(rows.length).toBeGreaterThanOrEqual(1200);
    expect(new Set(rows.map((r) => r.ownerId)).size).toBeGreaterThanOrEqual(1200);
  });
});
