/**
 * Phase B manual trial — preview / persist `lessons` from real bug→fix clusters.
 *
 * Since the auto-distiller now runs on every session end (tdai-core.handleSessionEnd
 * → store.runLessonDistillation), this tool is for MANUAL inspection: preview which
 * cross-session failure clusters exist and what the LLM would distil, before (or
 * instead of) waiting for the automatic pass.
 *
 * DRY by default: selects candidate clusters from the LIVE KB (read-only) via
 * selectFailureClusters, distils each via the live LLM, and PRINTS the proposal.
 * NOTHING is written. Re-run with --write to persist via distillLessons (the same
 * path the gateway uses automatically).
 *
 * Run:
 *   node_modules/.bin/tsx tools/lessons-run.mts [--write] [--limit N] [--db PATH]
 *
 * Reads LLM creds from the same TDAI_LLM_* env vars the gateway uses. Never prints
 * the key. Loads sqlite-vec so the bug-clustering reader can read kb_vec.
 */

import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

import { selectFailureClusters } from "../src/core/kb/bug-clusters.js";
import { distillLesson, type DistillableCluster } from "../src/core/kb/lessons-distiller.js";
import { distillLessons } from "../src/core/kb/lessons-runner.js";
import { StandaloneLLMRunnerFactory } from "../src/adapters/standalone/llm-runner.js";
import type { Logger } from "../src/core/types.js";

const require = createRequire(import.meta.url);

const DEFAULT_DB = path.join(
  os.homedir(),
  ".claude",
  "plugins",
  "data",
  "tdai-memory-tdai-local",
  "vectors.db",
);

function parseArgs(argv: string[]): { write: boolean; limit: number; db: string } {
  let write = false;
  let limit = 5;
  let db = DEFAULT_DB;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") write = true;
    else if (a === "--limit") limit = Math.max(1, parseInt(argv[++i] ?? "5", 10) || 5);
    else if (a === "--db") db = argv[++i] ?? DEFAULT_DB;
  }
  return { write, limit, db };
}

// Logs go to stderr so stdout stays clean for the lesson output.
const logger: Logger = {
  debug: () => {},
  info: (m: string) => process.stderr.write(`${m}\n`),
  warn: (m: string) => process.stderr.write(`${m}\n`),
  error: (m: string) => process.stderr.write(`${m}\n`),
};

/** Open the live DB with sqlite-vec loaded (bug clustering reads kb_vec). */
function openDb(dbPath: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly, allowExtension: true });
  db.enableLoadExtension(true);
  require("sqlite-vec").load(db);
  db.prepare("PRAGMA busy_timeout = 8000").run();
  return db;
}

function buildRunner() {
  const apiKey = process.env.TDAI_LLM_API_KEY ?? "";
  if (!apiKey) {
    process.stderr.write("STOP: TDAI_LLM_API_KEY is not set — cannot reach the LLM.\n");
    process.exit(1);
  }
  const factory = new StandaloneLLMRunnerFactory({
    config: {
      baseUrl: process.env.TDAI_LLM_BASE_URL ?? "https://api.openai.com/v1",
      apiKey,
      model: process.env.TDAI_LLM_MODEL ?? "gpt-4o",
      maxTokens: Number(process.env.TDAI_LLM_MAX_TOKENS ?? 16000),
      temperature: Number(process.env.TDAI_LLM_TEMPERATURE ?? 1),
      timeoutMs: Number(process.env.TDAI_LLM_TIMEOUT_MS ?? 120_000),
    },
    logger,
  });
  return factory.createRunner({ enableTools: false });
}

async function main(): Promise<void> {
  const { write, limit, db: dbPath } = parseArgs(process.argv.slice(2));
  const runner = buildRunner();
  process.stderr.write(
    `Phase B ${write ? "WRITE" : "DRY"} run · model=${process.env.TDAI_LLM_MODEL} · db=${dbPath} · limit=${limit}\n`,
  );

  if (write) {
    // The SAME path the gateway runs automatically on session end.
    const db = openDb(dbPath, false);
    try {
      const stats = await distillLessons(db, runner, {
        now: new Date().toISOString(),
        maxClusters: limit,
      });
      process.stdout.write(`\n=== WRITE stats ===\n${JSON.stringify(stats, null, 2)}\n`);
    } finally {
      db.close();
    }
    return;
  }

  // DRY: read-only, print proposals, write nothing.
  const db = openDb(dbPath, true);
  try {
    const clusters = selectFailureClusters(db, {}).slice(0, limit);
    process.stdout.write(`\nDRY RUN — ${clusters.length} candidate cluster(s):\n`);
    let i = 0;
    for (const c of clusters) {
      i++;
      process.stdout.write(
        `\n────────────────────────────────────────\n` +
          `[${i}] ${c.bugEventIds.length} recurrence(s) across ${c.distinctSessionCount} session(s) · project=${c.project || "-"}\n`,
      );
      c.bugTexts.forEach((t, k) => process.stdout.write(`  BUG${k + 1}: ${t}\n`));
      const distillable: DistillableCluster = { project: c.project, bugTexts: c.bugTexts, fixTexts: [] };
      const lesson = await distillLesson(distillable, runner);
      if (!lesson) {
        process.stdout.write(`  → LESSON: (distillation failed / unparseable)\n`);
        continue;
      }
      process.stdout.write(`  → domain: ${lesson.domain}\n`);
      process.stdout.write(`  → lesson: ${lesson.lessonText}\n`);
      process.stdout.write(`  → anti-patterns: ${JSON.stringify(lesson.antiPatterns)}\n`);
      process.stdout.write(`  → confidence: ${lesson.confidence}\n`);
    }
    process.stdout.write(`\n(DRY — nothing written. Re-run with --write to persist.)\n`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
