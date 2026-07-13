/**
 * Single-question smoke runner — drives ONE LongMemEval question through
 * Sinapsys end-to-end (seed → recall) in an isolated temp data dir.
 *
 * WHAT:  picks one oracle question, seeds its haystack, then recalls with the
 *        question text and prints what Sinapsys retrieved.
 * WHY:   first real signal + cheapest bug-finder, BEFORE spending on a subset.
 *        Isolation per question is mandatory (recall is NOT session-scoped) and
 *        also keeps the live memory untouched.
 *
 * KEY WIRING: seed writes vectors.db into `outputDir`; TdaiCore reads vectors.db
 * from `dataDir`. We set BOTH to the same temp dir so they coincide (the gateway
 * deliberately splits them, which would yield zero recall here).
 *
 * Run:  node --import tsx benchmark/longmemeval/src/run-one.ts [questionIndex]
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORACLE_PATH = path.join(__dirname, "..", "data", "longmemeval_oracle.json");

function makeLogger(): Logger {
  return {
    debug: (m: string) => console.error(`[dbg] ${m}`),
    info: (m: string) => console.error(`[inf] ${m}`),
    warn: (m: string) => console.error(`[wrn] ${m}`),
    error: (m: string) => console.error(`[err] ${m}`),
  };
}

async function main(): Promise<void> {
  const idx = Number(process.argv[2] ?? "0");
  const sessionLimit = process.argv[3] ? Number(process.argv[3]) : Infinity;
  const oracle = JSON.parse(fs.readFileSync(ORACLE_PATH, "utf-8")) as LmeQuestion[];
  const q = oracle[idx];
  if (!q) throw new Error(`No question at index ${idx} (have ${oracle.length})`);

  // Optional: limit haystack sessions for a fast, cheap diagnostic run.
  if (Number.isFinite(sessionLimit)) {
    q.haystack_sessions = q.haystack_sessions.slice(0, sessionLimit);
    q.haystack_dates = q.haystack_dates.slice(0, sessionLimit);
    q.haystack_session_ids = q.haystack_session_ids.slice(0, sessionLimit);
  }

  console.error(`\n=== Question[${idx}] ${q.question_id} (${q.question_type}) ===`);
  console.error(`Q: ${q.question}`);
  console.error(`Gold A: ${q.answer}`);
  console.error(`haystack sessions: ${q.haystack_sessions.length}`);

  // Fresh isolated temp dir — seed output AND recall read share it.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lme-"));
  console.error(`temp data dir: ${tempDir}`);

  const logger = makeLogger();
  const gwConfig = loadGatewayConfig({ data: { baseDir: tempDir } });

  // BENCHMARK LLM OVERRIDE: extraction on OpenAI gpt-4o (Lorenzo's choice) — not
  // the live Moonshot setup, so we measure the architecture, not the model's
  // slowness/Chinese-output. Embeddings stay OpenAI (memory.embedding config).
  const openaiKey = process.env.OPENAI_API_KEY ?? "";
  if (!openaiKey) throw new Error("OPENAI_API_KEY not set — required for gpt-4o extraction");
  const benchLlm = {
    ...gwConfig.llm,
    baseUrl: "https://api.openai.com/v1",
    apiKey: openaiKey,
    model: "gpt-4o",
    temperature: 0, // deterministic extraction for reproducible benchmark
  };
  gwConfig.llm = benchLlm;
  console.error(
    `LLM (extraction): model=${benchLlm.model} baseUrl=${benchLlm.baseUrl} keyLen=${benchLlm.apiKey.length} temp=${benchLlm.temperature}`,
  );

  // ---- Seed (blocking) — outputDir == dataDir == tempDir ----
  const seedInput = lmeQuestionToSeed(q);
  const normalized = validateAndNormalizeRaw(seedInput, { autoFillTimestamps: false });
  const pluginConfig: Record<string, unknown> = {
    ...(gwConfig.memory as unknown as Record<string, unknown>),
    llm: {
      enabled: true,
      baseUrl: gwConfig.llm.baseUrl,
      apiKey: gwConfig.llm.apiKey,
      model: gwConfig.llm.model,
      maxTokens: gwConfig.llm.maxTokens,
      temperature: gwConfig.llm.temperature,
      timeoutMs: gwConfig.llm.timeoutMs,
    },
  };

  const tSeed = Date.now();
  const summary = await executeSeed(normalized, {
    outputDir: tempDir,
    openclawConfig: {},
    pluginConfig,
    logger,
  });
  console.error(
    `\nSEED done in ${((Date.now() - tSeed) / 1000).toFixed(1)}s: ` +
    `sessions=${summary.sessionsProcessed} rounds=${summary.roundsProcessed} ` +
    `msgs=${summary.messagesProcessed} l0=${summary.l0RecordedCount}`,
  );
  // Did a vectors.db actually get written where recall will look?
  const dbPath = path.join(tempDir, "vectors.db");
  console.error(`vectors.db exists: ${fs.existsSync(dbPath)} (${dbPath})`);

  // ---- Recall — open a fresh core on the same dir ----
  const adapter = new StandaloneHostAdapter({
    dataDir: tempDir,
    llmConfig: gwConfig.llm,
    logger,
    platform: "gateway",
  });
  const core = new TdaiCore({ hostAdapter: adapter, config: gwConfig.memory });
  await core.initialize();
  // Give async store init a beat to settle before querying.
  await new Promise((r) => setTimeout(r, 500));

  const tRec = Date.now();
  const search = await core.searchMemories({ query: q.question, limit: 10 });
  console.error(`\nRECALL (searchMemories) in ${Date.now() - tRec}ms: ` +
    `total=${search.total} strategy=${search.strategy}`);
  console.error("--- retrieved memories ---");
  console.error(search.text || "(empty)");

  await core.destroy();

  // Honest proxy signal: does the retrieved text contain the gold answer?
  const hit = search.text.toLowerCase().includes(q.answer.toLowerCase());
  console.error(`\nPROXY gold-answer-in-recall: ${hit ? "YES ✓" : "NO ✗"}`);

  // Cleanup temp dir
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch((err) => {
  console.error("RUN FAILED:", err);
  process.exit(1);
});
