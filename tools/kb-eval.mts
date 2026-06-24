/**
 * kb-eval.mts — STANDALONE recall scorecard (throwaway dev, NOT shipped).
 *
 * Opens the scratch KB built by kb-migrate.mts (READ) + the same OpenAI embedding
 * service, runs kbRecall() over a GOLD query set, and prints a real scorecard. For
 * every MISS it classifies the cause as EXTRACTION (fact absent from the KB) vs
 * RETRIEVAL (present but not surfaced in top-5) by probing the raw tables.
 *
 * Run: node_modules/.bin/tsx tools/kb-eval.mts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { VectorStore } from "../src/core/store/sqlite.js";
import { createEmbeddingService } from "../src/core/store/embedding.js";
import { kbRecall } from "../src/core/kb/retrieval.js";
import type { Logger } from "../src/core/types.js";

const DIMS = 1536;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
// Default: the scratch eval DB. Override with KB_EVAL_DB=<path> to eval the LIVE DB.
const SCRATCH_DB = process.env.KB_EVAL_DB || path.join(REPO_ROOT, ".kb-scratch", "vectors.db");

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (m: string) => process.stdout.write(`  [warn] ${m}\n`),
  error: (m: string) => process.stdout.write(`  [ERROR] ${m}\n`),
};

// ============================
// GOLD set (substring match, case-insensitive). expectAny = any of these substrings.
// ============================

interface Gold {
  n: number;
  query: string;
  expectAny: string[];
  note?: string;
}

const GOLD: Gold[] = [
  { n: 1, query: "MANGO-STELLARE-99", expectAny: ["MANGO-STELLARE-99"] },
  { n: 2, query: "qual è il codice segreto", expectAny: ["MANGO-STELLARE-99"] },
  { n: 3, query: "ZAFFIRO-LUNARE-77", expectAny: ["ZAFFIRO-LUNARE-77"] },
  { n: 4, query: "codice di test", expectAny: ["ZAFFIRO-LUNARE-77"] },
  { n: 5, query: "Sofia idempotency post-call", expectAny: ["idempotency", "idempoten"], note: "may be absent" },
  { n: 6, query: "ENABLE_LEADDOC_BACKFILL", expectAny: ["LEADDOC"], note: "may be absent" },
  { n: 7, query: "errore 42703 colonna postcall", expectAny: ["42703"], note: "may be absent" },
];

// ============================
// Diagnosis: is the expected substring present ANYWHERE in the KB tables?
// (entities.name/aliases, facts.attribute/value, events.text). If yes but kbRecall
// missed it → RETRIEVAL; if no → EXTRACTION.
// ============================

function existsInKb(rdb: DatabaseSync, needle: string): { present: boolean; where: string[] } {
  const like = `%${needle}%`;
  const where: string[] = [];

  const factRows = rdb
    .prepare(
      `SELECT e.name AS name, f.attribute AS attribute, f.value AS value, f.superseded_by AS sb, f.valid_to AS vt
         FROM facts f JOIN entities e ON e.id = f.entity_id
        WHERE f.attribute LIKE ? COLLATE NOCASE OR f.value LIKE ? COLLATE NOCASE
        LIMIT 5`,
    )
    .all(like, like) as { name: string; attribute: string; value: string; sb: string | null; vt: string | null }[];
  for (const r of factRows) {
    const head = r.sb === null && r.vt === null ? "HEAD" : "SUPERSEDED";
    where.push(`fact[${head}] ${r.name} — ${r.attribute}: ${r.value}`);
  }

  const entRows = rdb
    .prepare(
      `SELECT name, type, aliases_json FROM entities
        WHERE name LIKE ? COLLATE NOCASE OR aliases_json LIKE ? COLLATE NOCASE LIMIT 5`,
    )
    .all(like, like) as { name: string; type: string; aliases_json: string | null }[];
  for (const r of entRows) where.push(`entity ${r.type}:${r.name} (aliases=${r.aliases_json ?? ""})`);

  const evRows = rdb
    .prepare(`SELECT text FROM events WHERE text LIKE ? COLLATE NOCASE LIMIT 5`)
    .all(like) as { text: string }[];
  for (const r of evRows) where.push(`event "${r.text.slice(0, 80)}"`);

  return { present: where.length > 0, where };
}

async function main(): Promise<void> {
  const required = ["OPENAI_API_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    process.stdout.write(`STOP: missing env vars: ${missing.join(", ")}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(SCRATCH_DB)) {
    process.stdout.write(`STOP: scratch db not found at ${SCRATCH_DB} — run kb-migrate.mts first\n`);
    process.exit(1);
  }

  process.stdout.write("=== KB EVAL (recall scorecard) ===\n");
  process.stdout.write(`scratch db: ${SCRATCH_DB}\n\n`);

  // Store for kbRecall (read path uses query* + searchKb* methods).
  const store = new VectorStore(SCRATCH_DB, DIMS, logger);
  store.init({ provider: "openai", model: "text-embedding-3-small" });
  if (store.isDegraded() || !store.isKbReady()) {
    process.stdout.write("STOP: store degraded or KB not ready\n");
    process.exit(1);
  }

  const embeddingService = createEmbeddingService(
    {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY!,
      model: "text-embedding-3-small",
      dimensions: DIMS,
      maxInputChars: 8000,
      chunkSize: 2000,
      chunkOverlap: 200,
      maxChunksPerText: 50,
    },
    logger,
  );

  // Separate read-only connection for the EXTRACTION-vs-RETRIEVAL probe.
  const rdb = new DatabaseSync(SCRATCH_DB, { readOnly: true });

  let hits = 0;
  let canaryHits = 0; // gold 1-4

  for (const g of GOLD) {
    const results = await kbRecall(g.query, {
      store,
      embeddingService,
      maxResults: 5,
    });

    // First top-5 result satisfying the expectation (case-insensitive substring).
    let firstHitRank = -1;
    for (let i = 0; i < results.length; i++) {
      const text = results[i].text.toLowerCase();
      if (g.expectAny.some((sub) => text.includes(sub.toLowerCase()))) {
        firstHitRank = i + 1; // 1-based
        break;
      }
    }
    const isHit = firstHitRank > 0;
    if (isHit) {
      hits++;
      if (g.n <= 4) canaryHits++;
    }

    const top = results[0];
    process.stdout.write(`--- GOLD ${g.n}: "${g.query}"${g.note ? ` (${g.note})` : ""}\n`);
    process.stdout.write(`    expect contains (any): ${g.expectAny.join(" | ")}\n`);
    process.stdout.write(`    results returned: ${results.length}\n`);
    if (top) {
      process.stdout.write(`    top score: ${top.score.toFixed(4)} | top text: "${top.text}"\n`);
    } else {
      process.stdout.write(`    top score: n/a (0 results)\n`);
    }
    process.stdout.write(`    verdict: ${isHit ? `HIT @rank ${firstHitRank}` : "MISS"}\n`);

    if (isHit) {
      // Show the satisfying hit's score/text for transparency.
      const h = results[firstHitRank - 1];
      process.stdout.write(`    hit score: ${h.score.toFixed(4)} | hit text: "${h.text}"\n`);
    } else {
      // Diagnose: EXTRACTION (absent) vs RETRIEVAL (present but not surfaced).
      // present-anywhere if ANY expected substring is found in the KB tables.
      let presentWhere: string[] = [];
      let present = false;
      for (const sub of g.expectAny) {
        const probe = existsInKb(rdb, sub);
        if (probe.present) {
          present = true;
          presentWhere = probe.where;
          break;
        }
      }
      if (present) {
        process.stdout.write(`    cause: RETRIEVAL — present in KB but NOT in top-5. Found at:\n`);
        for (const w of presentWhere) process.stdout.write(`           ${w}\n`);
      } else {
        process.stdout.write(`    cause: EXTRACTION — substring(s) [${g.expectAny.join(", ")}] absent from entities/facts/events.\n`);
      }
    }
    process.stdout.write("\n");
  }

  rdb.close();
  store.close?.();

  process.stdout.write(
    `RECALL: ${hits}/7 gold hits (canaries 1-4 are the hard acceptance gate: ${canaryHits}/4)\n`,
  );
}

main().catch((err) => {
  process.stdout.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
