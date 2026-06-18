/**
 * Phase 2 — applyKbDelta tests (temp DB, NEVER the live vectors.db).
 *
 * Covers:
 *   - a golden KbDelta → rows correct (entities/facts/events/relations) AND
 *     kb_vec/kb_fts populated (searchKbFts/searchKbVector find the fact).
 *   - a second window that SUPERSEDES a fact → head updated + old row kept.
 *   - idempotent re-apply → identical head state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { applyKbDelta } from "../kb-writer.js";
import { parseKbDelta } from "../extraction-schema.js";
import type { KbDelta } from "../extraction-schema.js";
import type { EmbeddingService, EmbeddingProviderInfo } from "../../store/embedding.js";
import { _resetUlidStateForTest } from "../kb-queries.js";

const DIMS = 4;
const NOW = "2026-06-05T12:00:00.000Z";

/** L2-normalize a raw vector (cosine expectations). */
function normalize(values: number[]): Float32Array {
  const mag = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return new Float32Array(values.map((v) => v / mag));
}

/**
 * Deterministic 4-dim fake embedding: hashes the text to a stable unit vector.
 * Same text → same vector, so a query for a fact's exact text recalls it.
 */
class FakeEmbeddingService implements EmbeddingService {
  private vec(text: string): Float32Array {
    const v = [0, 0, 0, 0];
    for (let i = 0; i < text.length; i++) {
      v[i % 4] += text.charCodeAt(i);
    }
    return normalize(v);
  }
  async embed(text: string): Promise<Float32Array> {
    return this.vec(text);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.vec(t));
  }
  async embedChunks(text: string): Promise<Float32Array[]> {
    return text.trim().length === 0 ? [] : [this.vec(text)];
  }
  getDimensions(): number {
    return DIMS;
  }
  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: "fake", model: "fake-4d" };
  }
  isReady(): boolean {
    return true;
  }
  startWarmup(): void {
    /* no-op */
  }
}

/** Direct DB row reader for assertions. */
function dbAll(store: VectorStore, sql: string, ...args: unknown[]): Record<string, unknown>[] {
  const handle = (store as unknown as {
    db: { prepare: (q: string) => { all: (...a: unknown[]) => Record<string, unknown>[] } };
  }).db;
  return handle.prepare(sql).all(...args);
}

/** Golden delta: bug → entity + event(bug) + status=open fact; file; fixed-by relation. */
function goldenDelta(): KbDelta {
  const res = parseKbDelta({
    language: "en",
    entities: [
      { ref: "e1", type: "bug", name: "booking-loop", aliases: ["booking loop bug"], language: "en" },
      { ref: "e2", type: "file", name: "booking.ts", aliases: [], language: "en" },
    ],
    facts: [
      {
        entity_ref: "e1",
        attribute: "status",
        value: "open",
        valid_from: "2026-06-06T09:00:00Z",
        confidence: 0.9,
        source_event_ref: "ev1",
      },
    ],
    events: [
      {
        ref: "ev1",
        type: "bug",
        ts: "2026-06-06T09:00:00Z",
        text: "Bug: bookSlot() in booking.ts recurses forever when the slot is already taken.",
        entity_refs: ["e1", "e2"],
        source_message_ids: ["msg_b1"],
      },
    ],
    relations: [{ src_ref: "e1", type: "fixed-by", dst_ref: "e2" }],
  });
  if (!res.ok) throw new Error(`golden delta invalid: ${res.error}`);
  return res.delta;
}

describe("applyKbDelta (temp DB)", () => {
  let dir: string;
  let store: VectorStore;
  let embedding: FakeEmbeddingService;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-kbwriter-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    expect(store.isKbReady()).toBe(true);
    embedding = new FakeEmbeddingService();
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("golden delta: rows correct + kb_vec/kb_fts populated", async () => {
    const result = await applyKbDelta(goldenDelta(), {
      store,
      embeddingService: embedding,
      namespace: "default",
      project: "repo",
      sessionKey: "sess-1",
      sessionId: "sid-1",
      now: NOW,
    });

    // ── Returned shape ──
    expect(result.entities).toHaveLength(2);
    expect(result.facts).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(result.relations).toHaveLength(1);
    // 1 head fact + 1 event embedded.
    expect(result.embedded).toBe(2);

    // ── entities table ──
    expect(dbAll(store, "SELECT count(*) AS c FROM entities")[0].c).toBe(2);
    const bug = store.queryEntityByKey("default", "bug", "bug:booking-loop");
    expect(bug).not.toBeNull();
    expect(bug!.project).toBe("repo");

    // ── facts table: a single HEAD with the right value, linked to the event ──
    const headFacts = store.queryHeadFacts(bug!.id);
    expect(headFacts).toHaveLength(1);
    expect(headFacts[0].attribute).toBe("status");
    expect(headFacts[0].value).toBe("open");
    expect(headFacts[0].source_event_id).toBe(result.events[0].id);
    expect(headFacts[0].language).toBe("en");

    // ── events table: append-only, provenance preserved ──
    expect(dbAll(store, "SELECT count(*) AS c FROM events")[0].c).toBe(1);
    expect(result.events[0].source_message_ids).toEqual(["msg_b1"]);
    expect(result.events[0].session_key).toBe("sess-1");
    expect(result.events[0].entities.length).toBe(2); // both resolved entity ids

    // ── relations table: fixed-by edge between the two resolved entities ──
    const fileEnt = store.queryEntityByKey("default", "file", "file:booking.ts");
    expect(dbAll(store, "SELECT count(*) AS c FROM relations")[0].c).toBe(1);
    expect(result.relations[0].src_entity_id).toBe(bug!.id);
    expect(result.relations[0].dst_entity_id).toBe(fileEnt!.id);
    expect(result.relations[0].type).toBe("fixed-by");

    // ── kb_fts finds the fact via its rendered text "{name} — {attr}: {value}" ──
    const factId = headFacts[0].id;
    const fts = store.searchKbFts('"booking"', 10);
    expect(fts.some((r) => r.owner_id === factId && r.owner_kind === "fact")).toBe(true);

    // ── kb_vec finds the fact when queried with its exact rendered text ──
    const factText = `booking-loop — status: open`;
    const queryVec = await embedding.embed(factText);
    const vec = store.searchKbVector(queryVec, 10, "fact");
    expect(vec.some((r) => r.owner_id === factId)).toBe(true);

    // ── kb_fts / kb_vec also indexed the event text ──
    const eventId = result.events[0].id;
    const ftsEvt = store.searchKbFts('"recurses"', 10);
    expect(ftsEvt.some((r) => r.owner_id === eventId && r.owner_kind === "event")).toBe(true);
  });

  it("second window supersedes a fact → head updated, old row kept", async () => {
    // Window 1: status=open.
    await applyKbDelta(goldenDelta(), {
      store,
      embeddingService: embedding,
      sessionKey: "sess-1",
      now: NOW,
    });
    const bug = store.queryEntityByKey("default", "bug", "bug:booking-loop")!;
    const head1 = store.queryHeadFacts(bug.id)[0];
    expect(head1.value).toBe("open");

    // Window 2: a fix → status=fixed (NEWER valid_from → supersede).
    const win2 = parseKbDelta({
      language: "en",
      entities: [{ ref: "e1", type: "bug", name: "booking-loop", language: "en" }],
      facts: [
        {
          entity_ref: "e1",
          attribute: "status",
          value: "fixed",
          valid_from: "2026-06-06T09:05:00Z",
          confidence: 0.9,
          source_event_ref: "ev1",
        },
      ],
      events: [
        {
          ref: "ev1",
          type: "fix",
          ts: "2026-06-06T09:05:00Z",
          text: "Fix: added a taken-slot guard in booking.ts so bookSlot() returns early.",
          entity_refs: ["e1"],
          source_message_ids: ["msg_b2"],
        },
      ],
      relations: [],
    });
    expect(win2.ok).toBe(true);
    if (!win2.ok) return;

    await applyKbDelta(win2.delta, {
      store,
      embeddingService: embedding,
      sessionKey: "sess-1",
      now: "2026-06-06T09:06:00.000Z",
    });

    // HEAD is now "fixed"; exactly one head per (entity, attribute).
    const heads = store.queryHeadFacts(bug.id);
    expect(heads).toHaveLength(1);
    expect(heads[0].value).toBe("fixed");

    // The OLD row is KEPT (never deleted): superseded_by + valid_to set.
    const allStatus = dbAll(
      store,
      "SELECT value, valid_to, superseded_by FROM facts WHERE entity_id = ? AND attribute = 'status' ORDER BY valid_from",
      bug.id,
    );
    expect(allStatus).toHaveLength(2);
    const old = allStatus.find((r) => r.value === "open")!;
    expect(old.valid_to).not.toBeNull();
    expect(old.superseded_by).toBe(heads[0].id);

    // The superseded (closed) fact must NOT be re-embedded as a head; only the
    // NEW head fact + the new event were embedded in window 2.
    // (We assert the head fact's text is what kb_vec returns for "fixed".)
    const fixedText = `booking-loop — status: fixed`;
    const qv = await embedding.embed(fixedText);
    const vec = store.searchKbVector(qv, 10, "fact");
    expect(vec[0]?.owner_id).toBe(heads[0].id);
  });

  it("idempotent re-apply → identical head state", async () => {
    const delta = goldenDelta();
    const r1 = await applyKbDelta(delta, {
      store,
      embeddingService: embedding,
      sessionKey: "sess-1",
      now: NOW,
    });
    // Re-apply the SAME delta (deterministic entity/relation ids; same-value
    // fact → corroboration, NOT a new version).
    const r2 = await applyKbDelta(delta, {
      store,
      embeddingService: embedding,
      sessionKey: "sess-1",
      now: "2026-06-06T10:00:00.000Z",
    });

    // Same entity ids (deterministic).
    expect(r2.entities.map((e) => e.id).sort()).toEqual(r1.entities.map((e) => e.id).sort());
    // Still exactly 2 entities, 1 relation (unique edge → support++, no dup).
    expect(dbAll(store, "SELECT count(*) AS c FROM entities")[0].c).toBe(2);
    expect(dbAll(store, "SELECT count(*) AS c FROM relations")[0].c).toBe(1);

    // HEAD fact unchanged in VALUE; corroboration bumped support, no new head.
    const bug = store.queryEntityByKey("default", "bug", "bug:booking-loop")!;
    const heads = store.queryHeadFacts(bug.id);
    expect(heads).toHaveLength(1);
    expect(heads[0].value).toBe("open");
    expect(heads[0].support).toBe(2); // corroborated once

    // Events are append-only → re-apply added a SECOND event row (immutable log).
    expect(dbAll(store, "SELECT count(*) AS c FROM events")[0].c).toBe(2);
  });

  it("no embedding service → rows still written (FTS/vec skipped), never throws", async () => {
    const result = await applyKbDelta(goldenDelta(), {
      store,
      // embeddingService omitted on purpose
      sessionKey: "sess-1",
      now: NOW,
    });
    expect(result.facts).toHaveLength(1);
    expect(result.embedded).toBe(0);
    // Entities/facts/events/relations are still persisted.
    expect(dbAll(store, "SELECT count(*) AS c FROM facts")[0].c).toBe(1);
    expect(dbAll(store, "SELECT count(*) AS c FROM events")[0].c).toBe(1);
  });
});
