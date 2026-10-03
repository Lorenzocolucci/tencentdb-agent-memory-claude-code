/**
 * Phase 5: two VectorStore connections on one DB file, as in production. The worker (leader)
 * builds / compacts / persists the nav index and reports owner writes; the gateway (follower)
 * never builds or persists, loads the published snapshot, and re-syncs owners it is told about.
 * Real sqlite-vec, temp dir.
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

function open(dbPath: string, opts?: ConstructorParameters<typeof VectorStore>[3]): VectorStore {
  const s = new VectorStore(dbPath, DIMS, undefined, opts);
  s.init({ provider: "openai", model: "m" });
  expect(s.isDegraded()).toBe(false);
  return s;
}

const topOwner = (s: VectorStore, q: Float32Array): string | undefined =>
  s.searchKbVector(q, 1, undefined, { allowBruteForce: false })[0]?.owner_id;

type RawDb = { db: { prepare(sql: string): { run(): unknown } } };

describe("kb nav index: leader (worker) and follower (gateway)", () => {
  let dir: string;
  let dbPath: string;
  const opened: VectorStore[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-nav-follower-"));
    dbPath = path.join(dir, "vectors.db");
  });
  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function track(s: VectorStore): VectorStore {
    opened.push(s);
    return s;
  }

  async function leaderWithOwners(n: number): Promise<VectorStore> {
    const leader = track(open(dbPath));
    for (let i = 0; i < n; i++) leader.upsertKbVector(`fact_${i}`, "fact", [unit(i + 1)], "t");
    expect(await leader.buildKbNavIndex()).toBe(true);
    await new Promise((r) => setTimeout(r, 50)); // snapshot persist is deferred one tick
    return leader;
  }

  it("a follower without a snapshot does NOT build one (and never writes the snapshot)", async () => {
    const seed = open(dbPath);
    for (let i = 0; i < 30; i++) seed.upsertKbVector(`fact_${i}`, "fact", [unit(i + 1)], "t");
    seed.close();
    const follower = track(open(dbPath, { kbNavRole: "follower", busyTimeoutMs: 100 }));
    expect(await follower.initKbNavIndex()).toBe(false);
    expect(follower.isKbNavIndexActive()).toBe(false);
    expect(fs.existsSync(path.join(dir, "kb-nav-index.v1.snapshot.json"))).toBe(false);
  });

  it("loads the leader's snapshot and answers the same top hit", async () => {
    const leader = await leaderWithOwners(60);
    const follower = track(open(dbPath, { kbNavRole: "follower", busyTimeoutMs: 100 }));
    expect(await follower.followKbNavIndex()).toBe(true);
    expect(follower.getKbNavIndexSize()).toBe(60);
    const q = unit(7);
    expect(topOwner(follower, q)).toBe(topOwner(leader, q));
  });

  it("re-syncs an owner the worker reports (new vector becomes searchable)", async () => {
    const leader = await leaderWithOwners(40);
    const follower = track(open(dbPath, { kbNavRole: "follower", busyTimeoutMs: 100 }));
    await follower.followKbNavIndex();

    const changed: string[] = [];
    leader.setKbVecChangeListener((id) => changed.push(id));
    const fresh = unit(999);
    leader.upsertKbVector("fact_new", "fact", [fresh], "t");
    expect(changed).toEqual(["fact_new"]); // the worker has something to report

    expect(topOwner(follower, fresh)).not.toBe("fact_new"); // gateway does not know it yet
    follower.resyncKbOwners(changed);
    await new Promise((r) => setTimeout(r, 50)); // drained in short slices
    expect(topOwner(follower, fresh)).toBe("fact_new");
  });

  it("keeps owner re-syncs that arrive while a snapshot reload is in flight", async () => {
    await leaderWithOwners(50);
    const follower = track(open(dbPath, { kbNavRole: "follower", busyTimeoutMs: 100 }));
    const writer = track(open(dbPath));
    const loading = follower.followKbNavIndex();
    writer.upsertKbVector("during_load", "fact", [unit(4242)], "t");
    follower.resyncKbOwners(["during_load"]);
    expect(await loading).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(topOwner(follower, unit(4242))).toBe("during_load");
  });

  it("tells the worker's listener when the snapshot file was rewritten", async () => {
    const leader = track(open(dbPath));
    for (let i = 0; i < 20; i++) leader.upsertKbVector(`fact_${i}`, "fact", [unit(i + 1)], "t");
    let published = 0;
    leader.setKbNavPublishedListener(() => published++);
    await leader.buildKbNavIndex();
    await new Promise((r) => setTimeout(r, 100));
    expect(published).toBe(1);
  });

  it("short busy_timeout: the gateway connection fails fast instead of sleeping on the worker's write lock", () => {
    const worker = track(open(dbPath));
    const gateway = track(open(dbPath, { kbNavRole: "follower", busyTimeoutMs: 50 }));
    // The worker holds the write lock (an open write transaction).
    (worker as unknown as RawDb).db.prepare("BEGIN IMMEDIATE").run();
    const t0 = performance.now();
    const ok = gateway.upsertKbVector("blocked", "fact", [unit(1)], "t");
    const ms = performance.now() - t0;
    (worker as unknown as RawDb).db.prepare("ROLLBACK").run();
    expect(ok).toBe(false);
    expect(ms).toBeLessThan(500);
  });
});
