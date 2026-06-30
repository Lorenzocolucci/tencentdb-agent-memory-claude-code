/**
 * LongMemEval subset runner — the real benchmark loop for Sinapsys.
 *
 * Per question (isolated temp data dir): seed haystack → recall → reader (gpt-4o
 * answers from retrieved memories) → judge (gpt-4o semantic correctness vs gold).
 * Aggregates accuracy overall and per question_type, writes a results JSON.
 *
 * Run:
 *   node --import tsx benchmark/longmemeval/src/run-subset.ts \
 *        --dataset data/longmemeval_oracle.json --per-type 2 \
 *        --types temporal-reasoning,multi-session,knowledge-update
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadGatewayConfig } from "../../../src/gateway/config.js";
import { StandaloneHostAdapter } from "../../../src/adapters/standalone/host-adapter.js";
import { TdaiCore } from "../../../src/core/tdai-core.js";
import { validateAndNormalizeRaw } from "../../../src/core/seed/input.js";
import { executeSeed } from "../../../src/core/seed/seed-runtime.js";
import type { Logger } from "../../../src/core/types.js";

import { lmeQuestionToSeed, type LmeQuestion } from "./convert.js";
import { reader, judge } from "./qa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Logger: quiet by default; set LME_VERBOSE=1 to surface seed/recall internals.
const VERBOSE = process.env.LME_VERBOSE === "1";
const logger: Logger = {
  debug: () => {},
  info: (m: string) => { if (VERBOSE && /l1|kb|recall|embedding|extract|store/i.test(m)) console.error(`[inf] ${m}`); },
  warn: (m: string) => console.error(`[wrn] ${m}`),
  error: (m: string) => console.error(`[err] ${m}`),
};

interface Args {
  dataset: string;
  perType: number;
  types: string[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return {
    dataset: get("--dataset", "data/longmemeval_oracle.json")!,
    perType: Number(get("--per-type", "2")),
    types: (get("--types", "temporal-reasoning,multi-session,knowledge-update")!).split(","),
  };
}

function benchLlmConfig() {
  const gw = loadGatewayConfig();
  const openaiKey = process.env.OPENAI_API_KEY ?? "";
  if (!openaiKey) throw new Error("OPENAI_API_KEY not set");
  return {
    ...gw,
    llm: {
      ...gw.llm,
      baseUrl: "https://api.openai.com/v1",
      apiKey: openaiKey,
      model: "gpt-4o",
      temperature: 0,
    },
  };
}

/** Seed one question's haystack into a fresh isolated dir, then recall. */
async function seedAndRecall(q: LmeQuestion): Promise<{ context: string; retrievedCount: number }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lme-sub-"));
  const gw = benchLlmConfig();
  gw.data = { baseDir: tempDir };

  try {
    const seedInput = lmeQuestionToSeed(q);
    const normalized = validateAndNormalizeRaw(seedInput, { autoFillTimestamps: false });
    const pluginConfig: Record<string, unknown> = {
      ...(gw.memory as unknown as Record<string, unknown>),
      llm: {
        enabled: true,
        baseUrl: gw.llm.baseUrl,
        apiKey: gw.llm.apiKey,
        model: gw.llm.model,
        maxTokens: gw.llm.maxTokens,
        temperature: gw.llm.temperature,
        timeoutMs: gw.llm.timeoutMs,
      },
    };
    const summary = await executeSeed(normalized, { outputDir: tempDir, openclawConfig: {}, pluginConfig, logger });
    if (VERBOSE) {
      const dbPath = path.join(tempDir, "vectors.db");
      const emb = gw.memory.embedding as Record<string, unknown> | undefined;
      const rec = gw.memory.recall as Record<string, unknown> | undefined;
      console.error(`      [seed] l0=${summary.l0RecordedCount} rounds=${summary.roundsProcessed} ` +
        `vectors.db=${fs.existsSync(dbPath)} embedProvider=${emb?.provider} ` +
        `embedKeyLen=${(emb?.apiKey as string)?.length ?? "n/a"} recall.source=${rec?.source}`);
    }

    const adapter = new StandaloneHostAdapter({
      dataDir: tempDir,
      llmConfig: gw.llm,
      logger,
      platform: "gateway",
    });
    const core = new TdaiCore({ hostAdapter: adapter, config: gw.memory });
    await core.initialize();
    await new Promise((r) => setTimeout(r, 800));
    const search = await core.searchMemories({ query: q.question, limit: 10 });
    if (VERBOSE) console.error(`      [recall] total=${search.total} strategy=${search.strategy}`);
    await core.destroy();
    return { context: search.text, retrievedCount: search.total };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

interface Result {
  question_id: string;
  question_type: string;
  abstention: boolean;
  gold: string;
  model_answer: string;
  retrieved: number;
  correct: boolean;
  error?: string;
}

async function runQuestion(q: LmeQuestion): Promise<Result> {
  const isAbs = String(q.question_id).includes("_abs");
  try {
    const { context, retrievedCount } = await seedAndRecall(q);
    const answer = await reader(q.question, context);
    const correct = await judge(q.question, q.answer, answer, isAbs);
    return {
      question_id: q.question_id,
      question_type: q.question_type,
      abstention: isAbs,
      gold: q.answer,
      model_answer: answer,
      retrieved: retrievedCount,
      correct,
    };
  } catch (err) {
    return {
      question_id: q.question_id,
      question_type: q.question_type,
      abstention: isAbs,
      gold: q.answer,
      model_answer: "",
      retrieved: 0,
      correct: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function selectSubset(all: LmeQuestion[], types: string[], perType: number): LmeQuestion[] {
  const out: LmeQuestion[] = [];
  for (const t of types) {
    const ofType = all.filter((q) => q.question_type === t).slice(0, perType);
    out.push(...ofType);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const datasetPath = path.isAbsolute(args.dataset)
    ? args.dataset
    : path.join(__dirname, "..", args.dataset);
  const all = JSON.parse(fs.readFileSync(datasetPath, "utf-8")) as LmeQuestion[];
  const subset = selectSubset(all, args.types, args.perType);

  console.error(`\n=== LongMemEval subset run ===`);
  console.error(`dataset: ${path.basename(datasetPath)} | questions: ${subset.length} ` +
    `(${args.perType}/type × ${args.types.length} types)\n`);

  const results: Result[] = [];
  for (let i = 0; i < subset.length; i++) {
    const q = subset[i]!;
    const t0 = Date.now();
    const r = await runQuestion(q);
    results.push(r);
    const mark = r.error ? "ERR" : r.correct ? "✓" : "✗";
    console.error(
      `[${i + 1}/${subset.length}] ${mark} ${r.question_type} ${r.question_id} ` +
      `(${((Date.now() - t0) / 1000).toFixed(0)}s, retrieved=${r.retrieved})` +
      (r.error ? ` ERROR: ${r.error}` : ""),
    );
    if (!r.error) {
      console.error(`      gold:  ${r.gold}`);
      console.error(`      model: ${r.model_answer.replace(/\n/g, " ").slice(0, 140)}`);
    }
  }

  // Aggregate
  const byType: Record<string, { n: number; correct: number }> = {};
  let totalCorrect = 0, totalErr = 0;
  for (const r of results) {
    byType[r.question_type] ??= { n: 0, correct: 0 };
    byType[r.question_type]!.n += 1;
    if (r.correct) byType[r.question_type]!.correct += 1;
    if (r.correct) totalCorrect += 1;
    if (r.error) totalErr += 1;
  }

  console.error(`\n=== RESULTS ===`);
  for (const [t, s] of Object.entries(byType)) {
    console.error(`  ${t}: ${s.correct}/${s.n} (${((s.correct / s.n) * 100).toFixed(0)}%)`);
  }
  console.error(`  OVERALL: ${totalCorrect}/${results.length} ` +
    `(${((totalCorrect / results.length) * 100).toFixed(1)}%)` +
    (totalErr ? ` — ${totalErr} errored` : ""));
  console.error(`  NOTE: dataset=${path.basename(datasetPath)} ` +
    `${datasetPath.includes("oracle") ? "(ORACLE = easy mode, no distractors — upper bound, NOT leaderboard-comparable)" : ""}`);

  // Persist
  const runsDir = path.join(__dirname, "..", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const outPath = path.join(runsDir, `subset-${path.basename(datasetPath, ".json")}-${subset.length}q.json`);
  fs.writeFileSync(outPath, JSON.stringify({ dataset: path.basename(datasetPath), results, byType }, null, 2));
  console.error(`\nresults written: ${outPath}`);
}

main().catch((err) => {
  console.error("SUBSET RUN FAILED:", err);
  process.exit(1);
});
