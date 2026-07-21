/**
 * LongMemEval MULTI-ARM runner — isolates Sinapsys's associative edge honestly.
 *
 * Per question: ONE seed into an isolated temp dir (kb extraction dominates cost),
 * then several RECALL arms read the SAME seeded KB via kbRecall directly:
 *
 *   A  flat        — kbRecall(flat=true): FTS + vector hybrid RRF only. The
 *                    entity-graph source AND Implicit Priming are OFF. This is the
 *                    "what a normal RAG memory does" baseline on the identical facts.
 *   B  kb          — full kbRecall: + entity-name graph match + spreading-activation
 *                    priming + HEAD-only supersedence. Sinapsys's differentiator.
 *                    EDGE = B − A (same seed, same embedder, same reader/judge).
 *   C  kb+consol   — full kbRecall AFTER runConsolidation(now=question_date) on every
 *                    session key. Probe: does consolidation move recall? (Reported.)
 *   D  kb@5        — full kbRecall at a small retrieval budget (top-k sensitivity).
 *
 * NB: a kb-engine seed does NOT populate legacy l1_records, so an "l1 recall" arm
 * would read an empty store — an invalid baseline. The honest flat baseline is the
 * kbRecall `flat` ablation on the same KB (see benchmark/longmemeval/DESIGN-2026-07-21.md).
 *
 * Controlled config (production-faithful, fixed across arms):
 *   - Embedder: deepinfra / Qwen/Qwen3-Embedding-4B / 1024 (the LIVE embedder,
 *     verified from the live DB embedding_meta). Set EXPLICITLY here.
 *   - Extraction: gpt-4o temp 0 + generic-extraction.txt (TDAI_KB_EXTRACTION_PROMPT_FILE).
 *   - Reader / in-loop judge: gpt-4o (qa.ts). REPORTED number = official evaluate_qa.py
 *     GPT-4o judge over the emitted per-arm hypothesis JSONL.
 *
 * Outputs (runs/): arms-<dataset>-<N>q.jsonl (all arms per question) +
 *   hyp-<arm>-<dataset>-<N>q.jsonl ({question_id, hypothesis} for the official judge).
 * Resumable: a question already recorded is skipped.
 *
 * Run:
 *   TDAI_KB_EXTRACTION_PROMPT_FILE=benchmark/longmemeval/prompts/generic-extraction.txt \
 *   node --import tsx benchmark/longmemeval/src/run-arms.ts \
 *     --dataset data/longmemeval_oracle.json --per-type 5 \
 *     --types single-session-user,temporal-reasoning,multi-session,knowledge-update
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadGatewayConfig } from "../../../src/gateway/config.js";
import { validateAndNormalizeRaw } from "../../../src/core/seed/input.js";
import { executeSeed } from "../../../src/core/seed/seed-runtime.js";
import { VectorStore } from "../../../src/core/store/sqlite.js";
import { OpenAIEmbeddingService } from "../../../src/core/store/embedding.js";
import { kbRecall } from "../../../src/core/kb/retrieval.js";
import type { Logger } from "../../../src/core/types.js";

import { lmeQuestionToSeed, parseHaystackDate, type LmeQuestion } from "./convert.js";
import { reader, judge } from "./qa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Embedder selection ──
// Default = the LIVE production embedder (DeepInfra Qwen3-4B/1024, verified from
// DB embedding_meta) for production fidelity. But DeepInfra Qwen3-4B is too slow
// to BULK-embed s_cleaned's huge ultrachat distractor haystacks (hundreds of long
// L0 messages → timeouts). Set TDAI_BENCH_EMBEDDER=openai to use the fast
// text-embedding-3-small/1536 instead: the flat-vs-kb edge is a property of the
// recall ALGORITHM (both arms share the embedder), so the comparison stays valid
// — only "the exact live embedder" fidelity is traded for tractable seeding.
const USE_OPENAI_EMB = process.env.TDAI_BENCH_EMBEDDER === "openai";
const EMB_PROVIDER = USE_OPENAI_EMB ? "openai" : "deepinfra";
const EMB_BASE_URL = USE_OPENAI_EMB ? "https://api.openai.com/v1" : "https://api.deepinfra.com/v1/openai";
const EMB_MODEL = USE_OPENAI_EMB ? "text-embedding-3-small" : "Qwen/Qwen3-Embedding-4B";
const EMB_DIMS = USE_OPENAI_EMB ? 1536 : 1024;
const EMB_KEY_ENV = USE_OPENAI_EMB ? "OPENAI_API_KEY" : "DEEPINFRA_API_KEY";

const VERBOSE = process.env.LME_VERBOSE === "1";
const logger: Logger = {
  debug: () => {},
  info: (m: string) => { if (VERBOSE && /l1|kb|recall|embedding|extract|store|consolidat/i.test(m)) console.error(`[inf] ${m}`); },
  warn: (m: string) => console.error(`[wrn] ${m}`),
  error: (m: string) => console.error(`[err] ${m}`),
};

interface Args { dataset: string; perType: number; types: string[]; }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return {
    dataset: get("--dataset", "data/longmemeval_oracle.json")!,
    perType: Number(get("--per-type", "3")),
    types: (get("--types", "single-session-user,temporal-reasoning,multi-session,knowledge-update")!).split(","),
  };
}

function embKey(): string {
  const key = process.env[EMB_KEY_ENV] ?? "";
  if (!key) throw new Error(`${EMB_KEY_ENV} not set — required for embeddings (${EMB_MODEL})`);
  return key;
}

// DeepInfra Qwen3-Embedding-4B can take tens of seconds per call under a heavy
// seed burst (a 48-session s_cleaned haystack fires many concurrent embeds). Two
// timeouts must BOTH be generous or the run corrupts:
//   1. the per-request AbortSignal (config.embedding.timeoutMs, below), and
//   2. the undici dispatcher's socket headers/body timeout, which defaults to
//      ~15s UNLESS TDAI_EMBED_AGENT_TIMEOUT_MS is set (the live reindex sets it).
// If (2) fires, recycleDispatcher() destroys the shared dispatcher mid-burst and
// every in-flight call fails "The client is destroyed" → facts/events written
// WITHOUT vectors → kb_vec empty → flat/kb comparison invalid. We set BOTH here.
const EMB_TIMEOUT_MS = 120_000;
if (!process.env.TDAI_EMBED_AGENT_TIMEOUT_MS) process.env.TDAI_EMBED_AGENT_TIMEOUT_MS = String(EMB_TIMEOUT_MS);
// Bound in-flight embeds so a large-haystack seed burst can't overwhelm DeepInfra
// (kb-writer + L0 background streams share one dispatcher). Default 4 here.
if (!process.env.TDAI_EMBED_MAX_CONCURRENCY) process.env.TDAI_EMBED_MAX_CONCURRENCY = "4";

/** Explicit, production-faithful embedding block merged into the memory config. */
function embeddingConfig(): Record<string, unknown> {
  return {
    enabled: true, provider: EMB_PROVIDER, baseUrl: EMB_BASE_URL,
    apiKey: embKey(), model: EMB_MODEL, dimensions: EMB_DIMS,
    timeoutMs: EMB_TIMEOUT_MS, captureTimeoutMs: EMB_TIMEOUT_MS, recallTimeoutMs: EMB_TIMEOUT_MS,
  };
}

function makeEmbeddingService(): OpenAIEmbeddingService {
  return new OpenAIEmbeddingService({
    provider: EMB_PROVIDER, baseUrl: EMB_BASE_URL, apiKey: embKey(),
    model: EMB_MODEL, dimensions: EMB_DIMS, timeoutMs: EMB_TIMEOUT_MS,
  }, logger);
}

/** gpt-4o extraction override (measure architecture, not Moonshot). */
function benchConfig(baseDir: string) {
  const gw = loadGatewayConfig();
  const openaiKey = process.env.OPENAI_API_KEY ?? "";
  if (!openaiKey) throw new Error("OPENAI_API_KEY not set — required for gpt-4o extraction/reader/judge");
  gw.data = { baseDir };
  gw.llm = { ...gw.llm, baseUrl: "https://api.openai.com/v1", apiKey: openaiKey, model: "gpt-4o", temperature: 0 };
  (gw.memory as unknown as Record<string, unknown>).embedding = embeddingConfig();
  return gw;
}

/** question_date → ISO string for consolidation "now". Falls back to Date.parse. */
function questionNowIso(q: LmeQuestion): string {
  try { return new Date(parseHaystackDate(q.question_date)).toISOString(); }
  catch {
    const ms = Date.parse(q.question_date);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString();
  }
}

type ArmKey = "flat" | "kb" | "kb_consol" | "kb5";

interface ArmOutcome { answer: string; retrieved: number; correct: boolean; }

interface QResult {
  question_id: string;
  question_type: string;
  abstention: boolean;
  gold: string;
  arms: Record<ArmKey, ArmOutcome>;
  consolidation?: { events: number; facts: number; staled: number; flagged: number };
  error?: string;
}

/** Render kbRecall rows into the reader's memory-context string. */
async function recall(
  store: VectorStore,
  emb: OpenAIEmbeddingService,
  query: string,
  opts: { maxResults: number; flat?: boolean },
): Promise<{ context: string; retrieved: number }> {
  const rows = await kbRecall(query, {
    store, embeddingService: emb, maxResults: opts.maxResults, flat: opts.flat, logger,
  });
  const context = rows.map((r) => `- ${r.text}`).join("\n");
  return { context, retrieved: rows.length };
}

async function runQuestion(q: LmeQuestion): Promise<QResult> {
  const isAbs = String(q.question_id).includes("_abs");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lme-arms-"));
  try {
    const gw = benchConfig(tempDir);
    const seedInput = lmeQuestionToSeed(q);
    const normalized = validateAndNormalizeRaw(seedInput, { autoFillTimestamps: false });
    const pluginConfig: Record<string, unknown> = {
      ...(gw.memory as unknown as Record<string, unknown>),
      llm: {
        enabled: true, baseUrl: gw.llm.baseUrl, apiKey: gw.llm.apiKey, model: gw.llm.model,
        maxTokens: gw.llm.maxTokens, temperature: gw.llm.temperature, timeoutMs: gw.llm.timeoutMs,
      },
    };
    await executeSeed(normalized, { outputDir: tempDir, openclawConfig: {}, pluginConfig, logger });
    const sessionKeys = seedInput.sessions.map((s) => s.sessionKey);

    // Open ONE store handle (reads for every arm + the consolidation write) and
    // one embedding service (query embeddings). init matches the seeded meta →
    // non-destructive no-op.
    const store = new VectorStore(path.join(tempDir, "vectors.db"), EMB_DIMS, logger);
    store.init({ provider: EMB_PROVIDER, model: EMB_MODEL });
    const emb = makeEmbeddingService();

    const arms = {} as Record<ArmKey, ArmOutcome>;
    let consolidation: QResult["consolidation"];
    try {
      const evalArm = async (key: ArmKey, o: { maxResults: number; flat?: boolean }): Promise<void> => {
        const { context, retrieved } = await recall(store, emb, q.question, o);
        const answer = await reader(q.question, context);
        const correct = await judge(q.question, q.answer, answer, isAbs);
        arms[key] = { answer, retrieved, correct };
        if (VERBOSE) console.error(`      [${key}] retrieved=${retrieved} correct=${correct}`);
      };

      // Pre-consolidation arms first.
      await evalArm("flat", { maxResults: 20, flat: true });
      await evalArm("kb", { maxResults: 20 });
      await evalArm("kb5", { maxResults: 5 });

      // Consolidation pass (production path: reinforce/decay/contradiction), now=question_date.
      const nowIso = questionNowIso(q);
      const totals = { events: 0, facts: 0, staled: 0, flagged: 0 };
      for (const sk of sessionKeys) {
        const s = store.consolidateSession?.({ sessionKey: sk, now: nowIso });
        if (s) {
          totals.events += s.eventsReinforced; totals.facts += s.factsReinforced;
          totals.staled += s.staled; totals.flagged += s.contradictionsFlagged;
        }
      }
      consolidation = totals;

      await evalArm("kb_consol", { maxResults: 20 });
    } finally {
      store.close();
    }

    return { question_id: q.question_id, question_type: q.question_type, abstention: isAbs, gold: q.answer, arms, consolidation };
  } catch (err) {
    return {
      question_id: q.question_id, question_type: q.question_type, abstention: isAbs,
      gold: q.answer, arms: {} as Record<ArmKey, ArmOutcome>,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function selectSubset(all: LmeQuestion[], types: string[], perType: number): LmeQuestion[] {
  const out: LmeQuestion[] = [];
  for (const t of types) out.push(...all.filter((q) => q.question_type === t).slice(0, perType));
  return out;
}

/** Prove the embedder answers at the right dim before spending seed cost.
 *  Retries transient failures (esp. OpenAI 429 rate-limits under sustained load)
 *  with backoff — a single transient 429 must NOT abort the whole driver run. */
async function verifyEmbedder(): Promise<void> {
  const svc = makeEmbeddingService();
  const backoffs = [0, 10_000, 30_000, 60_000, 90_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await new Promise((r) => setTimeout(r, backoffs[attempt]));
    try {
      const v = await svc.embed("longmemeval embedder probe");
      const len = (v as Float32Array).length;
      if (len !== EMB_DIMS) throw new Error(`embedder probe: expected ${EMB_DIMS} dims, got ${len}`);
      console.error(`✓ embedder OK: ${EMB_PROVIDER}/${EMB_MODEL} → ${len} dims`);
      return;
    } catch (err) {
      lastErr = err;
      console.error(`[wrn] embedder probe attempt ${attempt + 1}/${backoffs.length} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function main(): Promise<void> {
  const args = parseArgs();
  await verifyEmbedder();

  const datasetPath = path.isAbsolute(args.dataset) ? args.dataset : path.join(__dirname, "..", args.dataset);
  const all = JSON.parse(fs.readFileSync(datasetPath, "utf-8")) as LmeQuestion[];
  const subset = selectSubset(all, args.types, args.perType);

  const runsDir = path.join(__dirname, "..", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const base = `${path.basename(datasetPath, ".json")}-${subset.length}q`;
  const jsonlPath = path.join(runsDir, `arms-${base}.jsonl`);

  const doneById = new Map<string, QResult>();
  if (fs.existsSync(jsonlPath)) {
    for (const line of fs.readFileSync(jsonlPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as QResult; doneById.set(r.question_id, r); } catch { /* skip */ }
    }
  }

  console.error(`\n=== LongMemEval MULTI-ARM run ===`);
  console.error(`dataset: ${path.basename(datasetPath)} | questions: ${subset.length} ` +
    `(${args.perType}/type × ${args.types.length}) | done: ${doneById.size}`);
  console.error(`arms: A=flat@20  B=kb@20  C=kb@20+consol  D=kb@5\n`);

  // ONE_PER_RUN: process exactly ONE new question, then exit cleanly. The seed
  // path hits a native sqlite-vec / node:sqlite crash (exit 127) when a second
  // question's store is initialised in the SAME process; doing one question per
  // invocation and exiting BEFORE the next never reaches that trigger. The driver
  // (arms-driver.sh) relaunches until all are done — clean, deterministic, no crash.
  const ONE_PER_RUN = process.env.TDAI_ARMS_ONE_PER_RUN === "1";
  const remaining = subset.filter((q) => !doneById.has(q.question_id));
  for (let i = 0; i < remaining.length; i++) {
    const q = remaining[i]!;
    const t0 = Date.now();
    const r = await runQuestion(q);
    fs.appendFileSync(jsonlPath, JSON.stringify(r) + "\n");
    doneById.set(r.question_id, r);
    if (r.error) {
      console.error(`[${doneById.size}/${subset.length}] ERR ${r.question_type} ${r.question_id} (${((Date.now() - t0) / 1000).toFixed(0)}s): ${r.error}`);
    } else {
      const c = (k: ArmKey) => (r.arms[k]?.correct ? "✓" : "✗");
      console.error(`[${doneById.size}/${subset.length}] ${r.question_type} ${r.question_id} ` +
        `(${((Date.now() - t0) / 1000).toFixed(0)}s)  flat${c("flat")} kb${c("kb")} kbC${c("kb_consol")} kb5${c("kb5")}  ` +
        `[ret flat=${r.arms.flat?.retrieved} kb=${r.arms.kb?.retrieved}] consol=${JSON.stringify(r.consolidation)}`);
      console.error(`      gold: ${r.gold}`);
    }
    if (ONE_PER_RUN) { console.error(`(one-per-run: exiting cleanly, driver will resume)`); break; }
  }

  // ── Aggregate (in-loop judge, directional) + emit official-judge hypothesis JSONLs ──
  const results = subset.map((q) => doneById.get(q.question_id)).filter(Boolean) as QResult[];
  const armKeys: ArmKey[] = ["flat", "kb", "kb_consol", "kb5"];
  const hyp: Record<ArmKey, string[]> = { flat: [], kb: [], kb_consol: [], kb5: [] };
  const agg: Record<ArmKey, { n: number; correct: number; byType: Record<string, { n: number; c: number }> }> = {
    flat: { n: 0, correct: 0, byType: {} }, kb: { n: 0, correct: 0, byType: {} },
    kb_consol: { n: 0, correct: 0, byType: {} }, kb5: { n: 0, correct: 0, byType: {} },
  };
  for (const r of results) {
    if (r.error) continue;
    for (const k of armKeys) {
      const a = r.arms[k];
      if (!a) continue;
      hyp[k].push(JSON.stringify({ question_id: r.question_id, hypothesis: a.answer }));
      agg[k].n += 1; if (a.correct) agg[k].correct += 1;
      agg[k].byType[r.question_type] ??= { n: 0, c: 0 };
      agg[k].byType[r.question_type]!.n += 1; if (a.correct) agg[k].byType[r.question_type]!.c += 1;
    }
  }
  for (const k of armKeys) {
    fs.writeFileSync(path.join(runsDir, `hyp-${k}-${base}.jsonl`), hyp[k].join("\n") + (hyp[k].length ? "\n" : ""));
  }

  const pct = (c: number, n: number) => (n ? ((c / n) * 100).toFixed(0) : "–");
  console.error(`\n=== IN-LOOP JUDGE (directional; official evaluate_qa.py is the reported number) ===`);
  const types = [...new Set(results.map((r) => r.question_type))];
  console.error(`arm            overall    ` + types.map((t) => t.slice(0, 10).padEnd(12)).join(""));
  for (const k of armKeys) {
    const row = types.map((t) => {
      const s = agg[k].byType[t];
      return (s ? `${s.c}/${s.n}(${pct(s.c, s.n)}%)` : "–").padEnd(12);
    }).join("");
    console.error(`${(k + "  " + agg[k].correct + "/" + agg[k].n + "(" + pct(agg[k].correct, agg[k].n) + "%)").padEnd(25)}` + row);
  }
  const ov = (k: ArmKey) => (agg[k].n ? (agg[k].correct / agg[k].n) * 100 : 0);
  console.error(`\nEDGE  kb − flat (associative graph + priming): ${(ov("kb") - ov("flat")).toFixed(0)} pts`);
  console.error(`      kb_consol − kb (consolidation→recall coupling): ${(ov("kb_consol") - ov("kb")).toFixed(0)} pts`);
  console.error(`      kb − kb5 (budget 20 vs 5): ${(ov("kb") - ov("kb5")).toFixed(0)} pts`);
  console.error(`\nper-question: ${jsonlPath}`);
  console.error(`hypotheses (official judge input): runs/hyp-<arm>-${base}.jsonl`);
  console.error(`NOTE: ${path.basename(datasetPath).includes("oracle") ? "ORACLE = evidence-only, upper bound, NOT leaderboard-comparable." : "s_cleaned = distractors, realistic."}`);
}

main()
  // Force a clean exit: after the sqlite-vec / node:sqlite work, letting node fall
  // through its own teardown can segfault (exit 127). All results are already
  // flushed synchronously (appendFileSync), so exit(0) loses nothing.
  .then(() => process.exit(0))
  .catch((err) => { console.error("ARMS RUN FAILED:", err); process.exit(1); });
