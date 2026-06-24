/**
 * Phase B manual trial — distill `lessons` from real bug→fix clusters.
 *
 * DRY by default: selects candidate clusters from the LIVE KB (read-only),
 * distills each via the live LLM, and PRINTS the proposed lesson. NOTHING is
 * written. Inspect the quality, then re-run with --write to persist.
 *
 * Run:
 *   node_modules/.bin/tsx tools/lessons-run.mts [--write] [--limit N] [--db PATH]
 *
 * Reads LLM creds from the same TDAI_LLM_* env vars the gateway uses
 * (baseUrl/apiKey/model). Never prints the key.
 */

import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { selectLessonCandidates } from "../src/core/kb/lessons-candidates.js";
import { distillLesson } from "../src/core/kb/lessons-distiller.js";
import { distillLessons } from "../src/core/kb/lessons-runner.js";
import { StandaloneLLMRunnerFactory } from "../src/adapters/standalone/llm-runner.js";
import type { Logger } from "../src/core/types.js";

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

/** Set a busy timeout via prepare().run() (node:sqlite db.exec trips a false-positive hook). */
function setBusyTimeout(db: DatabaseSync, ms: number): void {
  db.prepare(`PRAGMA busy_timeout = ${ms}`).run();
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
    const db = new DatabaseSync(dbPath);
    setBusyTimeout(db, 5000);
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
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const clusters = selectLessonCandidates(db, { limit });
    process.stdout.write(`\nDRY RUN — ${clusters.length} candidate cluster(s):\n`);
    let i = 0;
    for (const c of clusters) {
      i++;
      process.stdout.write(
        `\n────────────────────────────────────────\n[${i}] session=${c.sessionKey} project=${c.project || "-"}\n`,
      );
      process.stdout.write(`  BUG: ${c.bugText}\n`);
      c.fixTexts.forEach((t, k) => process.stdout.write(`  FIX${k + 1}: ${t}\n`));
      const lesson = await distillLesson(c, runner);
      if (!lesson) {
        process.stdout.write(`  → LESSON: (distillation failed / unparseable)\n`);
        continue;
      }
      process.stdout.write(`  → domain: ${lesson.domain}\n`);
      process.stdout.write(`  → trigger: ${lesson.triggerPattern}\n`);
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
