#!/usr/bin/env node
/**
 * Standalone entry — Consolidation Cura #2, Phase 2a: entity-reconciliation
 * candidate DETECTION. READ-ONLY: it never merges or writes to vectors.db. It
 * proposes near-duplicate entity pairs (score + band) for Lorenzo to review
 * before any merge (Grounded Trust).
 *
 * Entity vector = mean-pool of its HEAD facts' kb_vec vectors, L2-normalized
 * (zero new embedding cost). Requires the sqlite-vec (vec0) extension to read
 * kb_vec — loaded exactly like the live store.
 */

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { getEnv } from "../utils/env.js";
import { findCandidatePairs, buildClusters, aggregateEntityVector, type RecEntity } from "../core/kb/entity-reconciliation.js";

const USAGE = `
Usage:
  node dist/src/cli/reconcile-entities-standalone.mjs --data-dir <dir> [--report <file>]

READ-ONLY: proposes near-duplicate entity pairs; never merges. --report defaults
to <data-dir>/entity-reconciliation-candidates.json.
`;

function parseArgs(argv: readonly string[]): { dataDir?: string; reportFile?: string } {
  const out: { dataDir?: string; reportFile?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a.startsWith("--data-dir=")) out.dataDir = a.slice("--data-dir=".length);
    else if (a === "--report") out.reportFile = argv[++i];
    else if (a.startsWith("--report=")) out.reportFile = a.slice("--report=".length);
    else if (a === "--help" || a === "-h") { process.stdout.write(USAGE); process.exit(0); }
    else { process.stderr.write(`\n❌ Unknown argument: ${a}\n${USAGE}`); process.exit(1); }
  }
  return out;
}

/** node:sqlite BLOB → Float32Array (embedding is dims*4 little-endian floats). */
function toFloat32(blob: unknown): Float32Array | null {
  if (blob instanceof Uint8Array) {
    if (blob.byteLength % 4 !== 0) return null;
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  if (blob instanceof ArrayBuffer) return new Float32Array(blob);
  return null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir ?? getEnv("TDAI_DATA_DIR");
  if (!dataDir || !dataDir.trim()) {
    process.stderr.write(`\n❌ --data-dir is required (or set TDAI_DATA_DIR).\n${USAGE}`);
    process.exit(1);
  }
  const dbPath = join(dataDir, "vectors.db");
  if (!existsSync(dbPath)) {
    process.stderr.write(`\n❌ No vectors.db at ${dbPath}. Check --data-dir.\n`);
    process.exit(1);
  }
  const reportFile = args.reportFile ?? join(dataDir, "entity-reconciliation-candidates.json");

  const db = new DatabaseSync(dbPath, { allowExtension: true, readOnly: true });
  try {
    createRequire(import.meta.url)("sqlite-vec").load(db);

    // 1. Entities.
    const entRows = db.prepare("SELECT id, type, name, importance FROM entities").all() as Array<{
      id: string; type: string; name: string; importance: number;
    }>;

    // 2. HEAD fact → entity map.
    const factToEntity = new Map<string, string>();
    for (const f of db.prepare("SELECT id, entity_id FROM facts WHERE superseded_by IS NULL AND valid_to IS NULL").all() as Array<{ id: string; entity_id: string }>) {
      factToEntity.set(f.id, f.entity_id);
    }

    // 3. Aggregate fact vectors per entity (single kb_vec scan; fact owners only).
    const vecsByEntity = new Map<string, Float32Array[]>();
    for (const row of db.prepare("SELECT owner_id, owner_kind, embedding FROM kb_vec").all() as Array<{ owner_id: string; owner_kind: string; embedding: unknown }>) {
      if (row.owner_kind !== "fact") continue;
      const entId = factToEntity.get(row.owner_id);
      if (!entId) continue; // superseded/non-HEAD fact → skip
      const v = toFloat32(row.embedding);
      if (!v) continue;
      const arr = vecsByEntity.get(entId);
      if (arr) arr.push(v);
      else vecsByEntity.set(entId, [v]);
    }

    // 4. Build RecEntity[] with aggregated vectors.
    const entities: RecEntity[] = entRows.map((e) => ({
      id: e.id, type: e.type, name: e.name, importance: e.importance,
      vector: aggregateEntityVector(vecsByEntity.get(e.id) ?? []),
    }));
    const withVec = entities.filter((e) => e.vector).length;

    // 5. Detect candidate pairs → cluster into connected components (one
    //    resolved record per cluster; one question to Lorenzo per ask-cluster).
    const { pairs, skippedBlocks, droppedGlueTokens, maxDocFreq } = findCandidatePairs(entities);
    const clusters = buildClusters(pairs);
    const autoClusters = clusters.filter((c) => c.band === "auto");
    const askClusters = clusters.filter((c) => c.band === "ask");
    const entitiesInAuto = autoClusters.reduce((s, c) => s + c.size, 0);
    const entitiesInAsk = askClusters.reduce((s, c) => s + c.size, 0);

    writeFileSync(reportFile, JSON.stringify({ version: 1, summary: {
      entities: entities.length, entitiesWithVector: withVec,
      pairs: pairs.length, clusters: clusters.length,
      autoClusters: autoClusters.length, askClusters: askClusters.length,
      entitiesInAutoClusters: entitiesInAuto, entitiesInAskClusters: entitiesInAsk,
      skippedBlocks: skippedBlocks.length,
    }, skippedBlocks, clusters }, null, 2));

    process.stderr.write(
      `\n🔎 Entity-reconciliation clusters (READ-ONLY)\n` +
        `  entities:               ${entities.length} (${withVec} with a vector)\n` +
        `  candidate pairs:        ${pairs.length}\n` +
        `  CLUSTERS:               ${clusters.length}  →  auto: ${autoClusters.length} (${entitiesInAuto} entities), ASK: ${askClusters.length} (${entitiesInAsk} entities)\n` +
        `  → Lorenzo answers ${askClusters.length} questions (not ${pairs.length} pairs)\n` +
        `  distinctive blocking:   maxDocFreq=${maxDocFreq}, dropped ${droppedGlueTokens.length} glue tokens (e.g. ${droppedGlueTokens.slice(0, 8).map((g) => `${g.token}:${g.docFreq}`).join(", ")})\n` +
        `  oversized blocks skipped: ${skippedBlocks.length}\n` +
        `  report written:         ${reportFile}\n`,
    );

    const fmt = (c: { band: string; size: number; type: string; maxScore: number; minScore: number; memberNames: string[] }) =>
      `   [${c.band}] n=${c.size} <${c.type}> score ${c.minScore.toFixed(2)}–${c.maxScore.toFixed(2)}: ${c.memberNames.map((n) => JSON.stringify(n)).join(", ")}`;

    process.stderr.write(`\n  Biggest clusters (top 12):\n`);
    for (const c of clusters.slice(0, 12)) process.stderr.write(fmt(c).slice(0, 400) + "\n");

    const openaiCluster = clusters.find((c) => c.memberNames.some((n) => /openai/i.test(n)));
    if (openaiCluster) {
      process.stderr.write(`\n  OpenAI cluster (n=${openaiCluster.size}, band=${openaiCluster.band}):\n`);
      process.stderr.write(`   ${openaiCluster.memberNames.map((n) => JSON.stringify(n)).join(", ").slice(0, 800)}\n`);
    }
  } finally {
    db.close();
  }
}

main();
