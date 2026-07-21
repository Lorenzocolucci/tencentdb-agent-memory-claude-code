/**
 * Cura #2 Phase 2b — read-path `merged_into` wiring (Pezzo 1).
 *
 * After a merge marks a satellite `merged_into = canonical`, the read-path MUST:
 *   1. resolveOrCreateEntity(satellite key/name) → return the CANONICAL
 *      (so new facts land on the canonical, not the merged-away row).
 *   2. queryEntitiesByTokens / listEntities → NEVER return the satellite
 *      (recall reaches the canonical via the folded alias instead).
 *
 * ALL tests run on a THROWAWAY temp DB (NEVER the live vectors.db). They use the
 * real store init (so the additive `merged_into` column is present) and set the
 * merged state directly, isolating the read-path from the merge engine.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";

const DIMS = 4;
const NOW = "2026-07-21T00:00:00.000Z";

interface RawDb {
  prepare: (q: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
    get: (...a: unknown[]) => Record<string, unknown> | undefined;
    run: (...a: unknown[]) => unknown;
  };
}

function rawDb(store: VectorStore): RawDb {
  return (store as unknown as { db: RawDb }).db;
}

describe("Cura #2 read-path: merged_into", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-merged-test-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    const res = store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    expect(res.needsReindex).toBe(false);
    expect(store.isKbReady()).toBe(true);
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("init creates the additive merged_into column + index", () => {
    const cols = rawDb(store).prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === "merged_into")).toHaveLength(1);
    const idx = rawDb(store)
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ent_merged'")
      .all();
    expect(idx).toHaveLength(1);
  });

  /** Merge satellite → canonical by setting the pointer directly (isolates the read-path). */
  function markMerged(satelliteId: string, canonicalId: string, satName: string): void {
    const db = rawDb(store);
    // Fold the satellite's name into the canonical's aliases (what the merge engine does),
    // so recall can still reach the canonical by the satellite's tokens.
    const canon = db.prepare("SELECT aliases_json FROM entities WHERE id = ?").get(canonicalId) as { aliases_json: string };
    const aliases = new Set<string>(JSON.parse(canon.aliases_json || "[]") as string[]);
    aliases.add(satName);
    db.prepare("UPDATE entities SET aliases_json = ? WHERE id = ?").run(JSON.stringify([...aliases]), canonicalId);
    db.prepare("UPDATE entities SET merged_into = ? WHERE id = ?").run(canonicalId, satelliteId);
  }

  it("resolveOrCreateEntity(satellite, exact key) returns the CANONICAL", () => {
    const canon = store.resolveOrCreateEntity({ type: "topic", name: "OpenAI", now: NOW });
    const sat = store.resolveOrCreateEntity({ type: "topic", name: "Open AI", now: NOW });
    expect(sat.id).not.toBe(canon.id);

    markMerged(sat.id, canon.id, "Open AI");

    // Exact match lands on the satellite row, must follow to the canonical.
    const resolved = store.resolveOrCreateEntity({ type: "topic", name: "Open AI", now: NOW });
    expect(resolved.id).toBe(canon.id);

    // No new entity was created; satellite row still exists (non-destructive).
    const count = rawDb(store).prepare("SELECT count(*) AS c FROM entities").get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("resolveOrCreateEntity(satellite via ALIAS) returns the CANONICAL", () => {
    const canon = store.resolveOrCreateEntity({ type: "topic", name: "OpenAI", now: NOW });
    const sat = store.resolveOrCreateEntity({
      type: "topic",
      name: "OpenAI Inc",
      aliases: ["oai-inc"],
      now: NOW,
    });
    markMerged(sat.id, canon.id, "OpenAI Inc");

    // Resolve by the satellite's alias → alias match lands on the satellite → follow to canonical.
    const resolved = store.resolveOrCreateEntity({ type: "topic", name: "oai-inc", now: NOW });
    expect(resolved.id).toBe(canon.id);
  });

  it("new facts on a merged satellite land on the CANONICAL (re-key going-forward)", () => {
    const canon = store.resolveOrCreateEntity({ type: "topic", name: "OpenAI", now: NOW });
    const sat = store.resolveOrCreateEntity({ type: "topic", name: "Open AI", now: NOW });
    markMerged(sat.id, canon.id, "Open AI");

    const ent = store.resolveOrCreateEntity({ type: "topic", name: "Open AI", now: NOW });
    store.upsertFact({ entityId: ent.id, attribute: "cost", value: "€18", now: NOW });

    const onCanon = rawDb(store).prepare("SELECT count(*) AS c FROM facts WHERE entity_id = ?").get(canon.id) as { c: number };
    const onSat = rawDb(store).prepare("SELECT count(*) AS c FROM facts WHERE entity_id = ?").get(sat.id) as { c: number };
    expect(onCanon.c).toBe(1);
    expect(onSat.c).toBe(0);
  });

  it("queryEntitiesByTokens never returns a merged satellite (canonical reachable via alias)", () => {
    const canon = store.resolveOrCreateEntity({ type: "topic", name: "OpenAI", now: NOW });
    const sat = store.resolveOrCreateEntity({ type: "topic", name: "Open AI", now: NOW });
    markMerged(sat.id, canon.id, "Open AI");

    const hits = store.queryEntitiesByTokens(["open", "ai"], "default", 20);
    const ids = hits.map((h) => h.id);
    expect(ids).not.toContain(sat.id);
    expect(ids).toContain(canon.id); // reachable via the folded "Open AI" alias
  });

  it("listEntities never returns a merged satellite", () => {
    const canon = store.resolveOrCreateEntity({ type: "topic", name: "OpenAI", now: NOW });
    const sat = store.resolveOrCreateEntity({ type: "topic", name: "Open AI", now: NOW });
    markMerged(sat.id, canon.id, "Open AI");

    const ids = store.listEntities("default", { limit: 500 }).map((e) => e.id);
    expect(ids).not.toContain(sat.id);
    expect(ids).toContain(canon.id);
  });

  it("follows a merged chain and survives a cycle (no infinite loop)", () => {
    const a = store.resolveOrCreateEntity({ type: "topic", name: "Alpha", now: NOW });
    const b = store.resolveOrCreateEntity({ type: "topic", name: "Beta", now: NOW });
    const c = store.resolveOrCreateEntity({ type: "topic", name: "Gamma", now: NOW });
    const db = rawDb(store);
    // Chain: Alpha → Beta → Gamma (transitive follow should reach Gamma).
    db.prepare("UPDATE entities SET merged_into = ? WHERE id = ?").run(c.id, b.id);
    db.prepare("UPDATE entities SET merged_into = ? WHERE id = ?").run(b.id, a.id);
    const resolved = store.resolveOrCreateEntity({ type: "topic", name: "Alpha", now: NOW });
    expect(resolved.id).toBe(c.id);

    // Introduce a cycle Gamma → Alpha: resolution must terminate (cycle guard).
    db.prepare("UPDATE entities SET merged_into = ? WHERE id = ?").run(a.id, c.id);
    expect(() => store.resolveOrCreateEntity({ type: "topic", name: "Alpha", now: NOW })).not.toThrow();
  });
});
