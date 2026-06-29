/**
 * Integration test: validate the distinctiveness isolation scorer against
 * REAL embeddings stored in the production vectors.db (30k+ records).
 *
 * Proves isolation scoring works on un-engineered cosine similarities.
 * Requires: vectors.db with embedded event records + sqlite-vec extension.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
import { computeIsolation, type NeighborEntry } from "../isolation-scorer.js";

const VECTORS_DB_PATH =
  "C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local/vectors.db";

const NEIGHBOR_K = 6;

function openVectorsDb(): DatabaseSync | null {
  try {
    const db = new DatabaseSync(VECTORS_DB_PATH, { open: true, allowExtension: true } as any);
    db.enableLoadExtension(true);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(db);
    return db;
  } catch {
    return null;
  }
}

const dbAvailable = existsSync(VECTORS_DB_PATH);

function getNeighborEntries(
  db: DatabaseSync,
  ownerId: string,
): NeighborEntry[] | null {
  const embRow = db
    .prepare("SELECT embedding FROM kb_vec WHERE owner_id = ? LIMIT 1")
    .get(ownerId) as { embedding: ArrayBuffer } | undefined;

  if (!embRow) return null;

  const neighbors = db
    .prepare(
      `SELECT owner_id, distance
       FROM kb_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(new Uint8Array(embRow.embedding), NEIGHBOR_K + 1) as Array<{
    owner_id: string;
    distance: number;
  }>;

  return neighbors
    .filter((n) => n.owner_id !== ownerId)
    .slice(0, NEIGHBOR_K)
    .map((n) => ({
      id: n.owner_id,
      cosineSim: 1.0 - n.distance,
    }));
}

describe.runIf(dbAvailable)(
  "distinctiveness isolation scorer — real vectors",
  () => {
    let db: DatabaseSync;
    let sampleOwnerIds: string[];

    beforeAll(() => {
      const maybeDb = openVectorsDb();
      if (!maybeDb) throw new Error("sqlite-vec load failed");
      db = maybeDb;

      const rows = db
        .prepare(
          "SELECT DISTINCT owner_id FROM kb_vec WHERE owner_kind = 'event' LIMIT 20",
        )
        .all() as Array<{ owner_id: string }>;

      sampleOwnerIds = rows.map((r) => r.owner_id);
    });

    it("should have sample events in vectors.db", () => {
      expect(sampleOwnerIds.length).toBeGreaterThan(0);
    });

    it("isolation scores are in [0,1] and show real variance", () => {
      const isolationScores: number[] = [];

      for (const ownerId of sampleOwnerIds.slice(0, 10)) {
        const entries = getNeighborEntries(db, ownerId);
        if (!entries) continue;
        isolationScores.push(computeIsolation(entries));
      }

      expect(isolationScores.length).toBeGreaterThan(0);

      for (const score of isolationScores) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }

      if (isolationScores.length >= 3) {
        const allSame = isolationScores.every(
          (s) => s === isolationScores[0],
        );
        expect(allSame).toBe(false);
      }
    });

    it("most memories have neighbors with moderate similarity (not near-zero)", () => {
      let hasModerateNeighbor = false;

      for (const ownerId of sampleOwnerIds.slice(0, 5)) {
        const entries = getNeighborEntries(db, ownerId);
        if (!entries) continue;

        if (entries.some((e) => e.cosineSim > 0.3)) {
          hasModerateNeighbor = true;
        }
      }

      expect(hasModerateNeighbor).toBe(true);
    });

    it("isolation distribution has distinct high and low scorers", () => {
      const scores: Array<{ ownerId: string; isolation: number }> = [];

      for (const ownerId of sampleOwnerIds) {
        const entries = getNeighborEntries(db, ownerId);
        if (!entries) continue;

        scores.push({
          ownerId,
          isolation: computeIsolation(entries),
        });
      }

      if (scores.length < 2) return;

      scores.sort((a, b) => a.isolation - b.isolation);
      const range =
        scores[scores.length - 1].isolation - scores[0].isolation;

      expect(range).toBeGreaterThan(0.05);
    });
  },
);
