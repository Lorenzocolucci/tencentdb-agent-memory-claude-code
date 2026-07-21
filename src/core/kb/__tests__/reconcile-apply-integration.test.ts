/**
 * Cura #2 Phase 2b — acceptance test on the REAL store schema (the point 1d
 * "costo OpenAI → one value" in miniature, deterministic, no live DB).
 *
 * Two fragmented "OpenAI" entities each hold a `cost` fact (€18 old, €387 new)
 * plus an event referencing the satellite. Running the FULL runner pipeline
 * (renderReport → parseReport → toMergePlans → mergeEntities) must:
 *   - collapse the two costs to ONE HEAD (the most recent, €387);
 *   - re-key the event onto the canonical (events completeness);
 *   - resolve satellite lookups (queryEntityById/ByKey) to the canonical;
 *   - drop the satellite from token recall.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { queryEntityById, queryEntityByKey } from "../kb-queries.js";
import type { EntityCluster } from "../entity-reconciliation.js";
import { renderReport, parseReport, toMergePlans, type EntityMeta } from "../entity-merge-plan.js";
import { mergeEntities } from "../entity-merge.js";

const DIMS = 4;

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

describe("Cura #2 acceptance: cost consolidation via the full pipeline", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-recon-int-"));
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

  it("two OpenAI entities → merge → ONE cost HEAD (most recent), event + lookups re-keyed", () => {
    const canon = store.resolveOrCreateEntity({ type: "topic", name: "OpenAI", now: "2026-01-01T00:00:00.000Z" });
    const sat = store.resolveOrCreateEntity({ type: "topic", name: "Open AI", now: "2026-02-01T00:00:00.000Z" });
    expect(sat.id).not.toBe(canon.id);

    // Conflicting cost on the SAME canonical attribute, satellite's is more recent.
    store.upsertFact({ entityId: canon.id, attribute: "cost", value: "€18", validFrom: "2026-01-01T00:00:00.000Z", now: "2026-01-01T00:00:00.000Z" });
    store.upsertFact({ entityId: sat.id, attribute: "cost", value: "€387", validFrom: "2026-06-01T00:00:00.000Z", now: "2026-06-01T00:00:00.000Z" });

    // An event referencing the satellite (must follow to the canonical after merge).
    rawDb(store)
      .prepare("INSERT INTO events (id, ts, recorded_at, session_key, type, text, entities_json, namespace) VALUES (?,?,?,?,?,?,?,?)")
      .run("evt1", "2026-06-02T00:00:00.000Z", "2026-06-02T00:00:00.000Z", "s1", "note", "OpenAI billing note", JSON.stringify([sat.id]), "default");

    // Build the cluster + meta the runner would produce (canonical picked = OpenAI, older createdTime).
    const cluster: EntityCluster = {
      members: [canon.id, sat.id], memberNames: ["OpenAI", "Open AI"],
      type: "topic", size: 2, band: "auto", maxScore: 0.97, minScore: 0.97,
    };
    const meta = new Map<string, EntityMeta>([
      [canon.id, { name: "OpenAI", type: "topic", factCount: 1, importance: 50, createdTime: "2026-01-01T00:00:00.000Z" }],
      [sat.id, { name: "Open AI", type: "topic", factCount: 1, importance: 50, createdTime: "2026-02-01T00:00:00.000Z" }],
    ]);

    // FULL pipeline: render → parse → plans → merge.
    const md = renderReport({ clusters: [cluster], meta, topAsk: 30, totals: { entities: 2, entitiesWithVector: 2 }, generatedAt: "2026-07-21T00:00:00Z" });
    const plans = toMergePlans(parseReport(md), { autoOnly: true });
    expect(plans).toHaveLength(1);
    expect(plans[0].canonicalId).toBe(canon.id);

    const result = mergeEntities(rawDb(store) as never, plans[0], "2026-07-21T00:00:00.000Z");
    expect(result.satellitesMerged).toBe(1);
    expect(result.eventsRekeyed).toBe(1);

    // 1. ONE cost HEAD on the canonical, and it is the most recent value.
    const heads = rawDb(store)
      .prepare("SELECT value FROM facts WHERE entity_id=? AND attribute='cost' AND superseded_by IS NULL AND valid_to IS NULL")
      .all(canon.id) as Array<{ value: string }>;
    expect(heads).toHaveLength(1);
    expect(heads[0].value).toBe("€387");

    // The €18 fact is superseded, NOT deleted (non-destructive).
    const superseded = rawDb(store)
      .prepare("SELECT value, valid_to, superseded_by FROM facts WHERE value='€18'")
      .get() as { value: string; valid_to: string | null; superseded_by: string | null };
    expect(superseded.valid_to).not.toBeNull();
    expect(superseded.superseded_by).not.toBeNull();

    // 2. The event now references the canonical, not the satellite.
    const evt = rawDb(store).prepare("SELECT entities_json FROM events WHERE id='evt1'").get() as { entities_json: string };
    const evEnts = JSON.parse(evt.entities_json) as string[];
    expect(evEnts).toContain(canon.id);
    expect(evEnts).not.toContain(sat.id);

    // 3. Direct lookups of the satellite resolve to the canonical.
    expect(queryEntityById(rawDb(store) as never, sat.id)?.id).toBe(canon.id);
    expect(queryEntityByKey(rawDb(store) as never, "default", "topic", sat.canonical_key)?.id).toBe(canon.id);

    // 4. Token recall excludes the satellite (reaches canonical via folded alias).
    const ids = store.queryEntitiesByTokens(["open", "ai"], "default", 20).map((e) => e.id);
    expect(ids).not.toContain(sat.id);
    expect(ids).toContain(canon.id);
  });
});
