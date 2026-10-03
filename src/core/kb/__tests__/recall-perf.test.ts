/**
 * Perf guard (Phase 2.8): runKbRecall on a synthetic DB at today's order of
 * magnitude (25k entities, 16k events, ~40k facts, 20k relations).
 *
 * Asserts (a) a generous p95 budget (CI-safe; the real-size target is 300 ms and is
 * measured by the bench on a live-DB copy, not here) and (b) STRUCTURE, which is
 * what actually regresses: recall must not run the full entity scan nor LIKE-scan
 * events.entities_json.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../../store/sqlite.js";
import { runKbRecall } from "../../hooks/auto-recall.js";

const N_ENT = 25_000;
const N_EVT = 16_000;
const P95_BUDGET_MS = 800;
const WORDS = ["gateway", "recall", "banner", "memory", "sofia", "dashboard", "vercel", "hook", "plugin", "timeout",
  "entity", "graph", "fact", "event", "session", "persona", "scene", "vector", "index", "build", "deploy", "fix"];
const NOW = "2026-10-01T10:00:00.000Z";

describe("runKbRecall perf guard (synthetic 25k entities / 16k events)", () => {
  let dir: string;
  let store: VectorStore;
  let db: DatabaseSync;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-recallperf-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    db = (store as unknown as { db: DatabaseSync }).db;

    const insEnt = db.prepare(
      "INSERT INTO entities (id, type, name, canonical_key, namespace, aliases_json, importance, created_time, updated_time) VALUES (?, 'thing', ?, ?, 'default', ?, 50, ?, ?)",
    );
    const insFact = db.prepare(
      "INSERT INTO facts (id, entity_id, attribute, value, valid_from, learned_at, created_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insEvt = db.prepare(
      "INSERT INTO events (id, ts, recorded_at, session_key, type, text, entities_json) VALUES (?, ?, ?, 'sk', 'event', ?, ?)",
    );
    const insRel = db.prepare(
      "INSERT OR IGNORE INTO relations (id, src_entity_id, type, dst_entity_id, namespace, valid_from, created_time) VALUES (?, ?, 'related', ?, 'default', ?, ?)",
    );
    db.prepare("BEGIN").run();
    for (let i = 0; i < N_ENT; i++) {
      const w1 = WORDS[i % WORDS.length]!;
      const w2 = WORDS[(i * 7 + 3) % WORDS.length]!;
      insEnt.run(`ent_${i}`, `${w1} ${w2} ${i}`, `thing:${w1}-${w2}-${i}`, JSON.stringify([`alias ${w2} ${i}`]), NOW, NOW);
      insFact.run(`fact_${i}a`, `ent_${i}`, "status", `${w1} works with ${w2}`, NOW, NOW, NOW);
      if (i % 2 === 0) insFact.run(`fact_${i}b`, `ent_${i}`, "note", `note about ${w2} ${i}`, NOW, NOW, NOW);
      insRel.run(`rel_${i}`, `ent_${i}`, `ent_${(i * 31 + 17) % N_ENT}`, NOW, NOW);
      insRel.run(`rel_${i}b`, `ent_${i}`, `ent_${(i * 13 + 5) % N_ENT}`, NOW, NOW);
    }
    for (let i = 0; i < N_EVT; i++) {
      const ents = [`ent_${(i * 3) % N_ENT}`, `ent_${(i * 3 + 1) % N_ENT}`, `ent_${(i % 40)}`];
      insEvt.run(`evt_${String(i).padStart(6, "0")}`, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00Z`, NOW,
        `event ${i} ${WORDS[i % WORDS.length]}`, JSON.stringify(ents));
    }
    db.prepare("COMMIT").run();
  }, 120_000);

  afterAll(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("the trigger-built indexes cover the bulk load (so the fast path is what recall uses)", () => {
    const fts = (db.prepare("SELECT COUNT(*) AS n FROM entities_fts").get() as { n: number }).n;
    const ee = (db.prepare("SELECT COUNT(*) AS n FROM event_entities").get() as { n: number }).n;
    expect(fts).toBe(N_ENT);
    expect(ee).toBeGreaterThan(N_EVT); // ~3 entities per event
  });

  it(`p95 < ${P95_BUDGET_MS} ms and no full entity scan / LIKE scan during recall`, async () => {
    const cfg = { recall: { maxResults: 5, rerank: false }, embedding: {} } as never;
    const queries = ["gateway recall timeout", "banner memory", "sofia dashboard vercel", "Riprova", "fix the hook plugin",
      "entity graph fact", "session persona scene", "deploy index build", "vector memory", "ok procedi"];
    const seen: string[] = [];
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      seen.push(sql);
      return realPrepare(sql);
    };
    const times: number[] = [];
    try {
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        await runKbRecall(queries[i % queries.length]!, cfg, undefined, store, undefined, "proj", { sessionKey: "sk", namespace: "default" }, { deferWrites: true });
        times.push(performance.now() - t0);
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      (db as unknown as { prepare: unknown }).prepare = realPrepare;
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    expect(p95).toBeLessThan(P95_BUDGET_MS);
    expect(seen.filter((s) => /SELECT \* FROM entities WHERE namespace = \?/.test(s))).toEqual([]);
    expect(seen.filter((s) => /entities_json LIKE/.test(s))).toEqual([]);
  }, 120_000);
});
