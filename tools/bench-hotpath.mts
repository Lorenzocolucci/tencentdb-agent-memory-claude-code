/**
 * bench-hotpath — does the gateway hot path (/recall /pretool /observe /health) stay
 * responsive while heavy background work runs? Phase 5 acceptance benchmark.
 *
 * Starts the REAL gateway (src/gateway/cli.ts through tsx) on a temp port against a COPY
 * of the live DB, with stub LLM + embedding servers (a child process, so it cannot skew
 * the measurement), then fires concurrent background work through the public HTTP API:
 *   - capture bursts on 4 sessions  -> capture inbox drain, L0 index, forced extraction
 *     (stub LLM, 3 s latency) -> applyKbDelta writes + embeddings
 *   - /kb/write every 3 s            -> deterministic KB writes
 *   - /session/end on a rotating session -> consolidation + recap + distillation
 *   - session-open /recall on fresh sessions -> cornerstone build + distillation triggers
 *   - boot: kb-nav snapshot load/build (the load starts at the first 200 from /health)
 * while probing /recall, /pretool, /observe, /health and a trivial 404 route (pure
 * event-loop probe) and reading the gateway's own event-loop lag from /health.
 *
 * Usage (one heavy process at a time; needs >= 3 GB free RAM):
 *   npx tsx tools/bench-hotpath.mts --prepare-copy           # once: VACUUM INTO the live DB (read-only)
 *   npx tsx tools/bench-hotpath.mts --label before --duration 90
 *   npx tsx tools/bench-hotpath.mts --label after  --duration 90
 * Options: --data-dir <dir> (default C:\Users\lo\tdai-p5-copy), --port <n> (default 18421),
 *          --src <repo root holding dist/src/gateway/cli.mjs> (default: this repo; run `npm run build` first),
 *          --tsx (run src/gateway/cli.ts through tsx instead of the built bundle), --no-load (probes only)
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const LIVE_DB = path.join(os.homedir(), ".claude/plugins/data/tdai-memory-tdai-local/vectors.db");
const LIVE_SNAPSHOT = path.join(os.homedir(), ".claude/plugins/data/tdai-memory-tdai-local/kb-nav-index.v1.snapshot.json");
const MIN_FREE_BYTES = 3e9;
const TSX = import.meta.resolve("tsx");

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}
const flag = (n: string) => process.argv.includes(`--${n}`);

// ---------------------------------------------------------------------------
// Stub server (child mode): OpenAI-compatible /chat/completions + /embeddings
// ---------------------------------------------------------------------------
function runStub(port: number, llmDelayMs: number): void {
  let seq = 0;
  const embed = (text: string): number[] => {
    // deterministic pseudo-random unit vector from the text (cosine-meaningful enough)
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    const v = new Array<number>(1024);
    let s = h || 1;
    let norm = 0;
    for (let i = 0; i < 1024; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      v[i] = s / 4294967296 - 0.5;
      norm += v[i]! * v[i]!;
    }
    norm = Math.sqrt(norm);
    return v.map((x) => x / norm);
  };
  const delta = (n: number) => ({
    language: "en",
    entities: [
      { ref: "e1", type: "project", name: `Bench Project ${n}`, aliases: [], language: "en" },
      { ref: "e2", type: "bug", name: `Bench Bug ${n}`, aliases: [], language: "en" },
    ],
    facts: [
      { entity_ref: "e1", attribute: `bench_state_${n % 7}`, value: `value for run ${n} of the benchmark`, confidence: 0.8 },
      { entity_ref: "e2", attribute: "status", value: n % 2 ? "open" : "fixed", confidence: 0.8 },
    ],
    events: [
      { ref: "v1", type: "decision", ts: new Date().toISOString(), text: `Decided to benchmark the hot path, round ${n}`, entity_refs: ["e1"], source_message_ids: [] },
      { ref: "v2", type: "bug", ts: new Date().toISOString(), text: `Observed a synthetic bug number ${n} in the bench`, entity_refs: ["e2"], source_message_ids: [] },
    ],
    relations: [{ src_ref: "e2", type: "related-to", dst_ref: "e1" }],
  });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const send = (obj: unknown) => {
        const j = JSON.stringify(obj);
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(j) });
        res.end(j);
      };
      if (req.url?.endsWith("/embeddings")) {
        const input = (JSON.parse(body) as { input: string | string[] }).input;
        const arr = Array.isArray(input) ? input : [input];
        send({ object: "list", data: arr.map((t, index) => ({ object: "embedding", index, embedding: embed(String(t)) })), model: "stub", usage: { prompt_tokens: 1, total_tokens: 1 } });
        return;
      }
      if (req.url?.endsWith("/chat/completions")) {
        const isKb = body.includes("entity-centric memory extractor");
        setTimeout(() => {
          const content = isKb ? JSON.stringify(delta(++seq)) : "{}";
          send({ id: `stub-${seq}`, object: "chat.completion", model: "stub", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        }, llmDelayMs);
        return;
      }
      res.writeHead(404).end();
    });
  });
  server.listen(port, "127.0.0.1", () => process.stdout.write(`stub listening ${port}\n`));
}

// ---------------------------------------------------------------------------
// Copy preparation
// ---------------------------------------------------------------------------
async function prepareCopy(dataDir: string): Promise<void> {
  const dst = path.join(dataDir, "vectors.db");
  if (fs.existsSync(dst)) throw new Error(`${dst} already exists - one copy only (delete it yourself to refresh)`);
  if (os.freemem() < MIN_FREE_BYTES) throw new Error(`free RAM ${(os.freemem() / 1e9).toFixed(1)} GB < 3 GB - refusing to copy`);
  fs.mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const req = createRequire(path.join(REPO, "package.json"));
  const db = new DatabaseSync(LIVE_DB, { readOnly: true, allowExtension: true });
  db.prepare("PRAGMA busy_timeout=5000").run();
  db.enableLoadExtension(true);
  (req("sqlite-vec") as { load(d: unknown): void }).load(db);
  const t = Date.now();
  db.prepare(`VACUUM INTO '${dst.replace(/\\/g, "/")}'`).run();
  db.close();
  if (fs.existsSync(LIVE_SNAPSHOT)) fs.copyFileSync(LIVE_SNAPSHOT, path.join(dataDir, "kb-nav-index.v1.snapshot.json"));
  console.log(`copy ready in ${Date.now() - t} ms -> ${dst}`);
}

// ---------------------------------------------------------------------------
// HTTP client + stats
// ---------------------------------------------------------------------------
interface Sample { ms: number; status: number }
const samples = new Map<string, Sample[]>();
const phaseOf = { current: "boot" };
function record(name: string, ms: number, status: number): void {
  const key = `${phaseOf.current}|${name}`;
  const a = samples.get(key) ?? [];
  a.push({ ms, status });
  samples.set(key, a);
}

async function call(base: string, name: string, method: string, url: string, body?: unknown, timeoutMs = 60_000): Promise<{ status: number; json: unknown }> {
  const t = performance.now();
  let status = 0;
  let json: unknown = null;
  try {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch {
    status = -1;
  }
  record(name, performance.now() - t, status);
  return { status, json };
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(0).padStart(6) : "     -");

function report(label: string, lagSeries: Array<{ phase: string; p99: number; max: number }>): string {
  const lines: string[] = [];
  const phases = [...new Set([...samples.keys()].map((k) => k.split("|")[0]!))];
  lines.push(`=== bench-hotpath [${label}] ===`);
  for (const ph of phases) {
    lines.push(`-- phase: ${ph}`);
    lines.push("endpoint        n   err    p50    p95    p99    max   (ms, client-side)");
    for (const [k, v] of samples) {
      if (!k.startsWith(`${ph}|`)) continue;
      const ok = v.filter((s) => s.status >= 200 && s.status < 300).map((s) => s.ms);
      const all = v.map((s) => s.ms);
      const err = v.filter((s) => !(s.status >= 200 && s.status < 300) && !(k.endsWith("|loop-404") && s.status === 404)).length;
      const xs = k.endsWith("|loop-404") ? all : ok.length ? ok : all;
      lines.push(`${k.split("|")[1]!.padEnd(14)} ${String(v.length).padStart(4)} ${String(err).padStart(5)} ${f(pct(xs, 0.5))} ${f(pct(xs, 0.95))} ${f(pct(xs, 0.99))} ${f(Math.max(...xs))}`);
    }
    const lag = lagSeries.filter((l) => l.phase === ph);
    if (lag.length) lines.push(`gateway event-loop lag (/health, per-second p99 bucket): p99-of-p99=${f(pct(lag.map((l) => l.p99), 0.99))} max=${f(Math.max(...lag.map((l) => l.max)))}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const stubPort = Number(arg("stub-port", "18499"));
  if (flag("stub")) { runStub(stubPort, Number(arg("llm-delay", "3000"))); await new Promise<never>(() => {}); }

  const dataDir = path.resolve(arg("data-dir", path.join(os.homedir(), "tdai-p5-copy"))!);
  if (flag("prepare-copy")) { await prepareCopy(dataDir); return; }

  const label = arg("label", "run")!;
  const port = Number(arg("port", "18421"));
  const durationS = Number(arg("duration", "90"));
  const srcRoot = path.resolve(arg("src", REPO)!);
  if (port === 8421) throw new Error("refusing to use the live gateway port");
  if (!fs.existsSync(path.join(dataDir, "vectors.db"))) throw new Error(`no copy at ${dataDir} - run with --prepare-copy first`);
  if (os.freemem() < MIN_FREE_BYTES) throw new Error(`free RAM ${(os.freemem() / 1e9).toFixed(1)} GB < 3 GB - not starting a heavy run`);

  // The copy dir is bench scratch: drop the previous run's undrained capture files so every run starts equal.
  fs.rmSync(path.join(dataDir, "capture-inbox"), { recursive: true, force: true });
  // The bench kills its gateway hard, which leaves the locks behind; a pid reused by another process
  // would make them look live. They are bench scratch: start clean.
  for (const lock of ["gateway.lock", "worker.lock"]) fs.rmSync(path.join(dataDir, lock), { force: true });
  const logDir = path.join(dataDir, "bench-logs");
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const gwOut = path.join(logDir, `${label}-${stamp}.gateway.log`);

  fs.writeFileSync(path.join(dataDir, "tdai-gateway.yaml"), [
    "memory:",
    "  extraction:",
    "    engine: kb",
    "  recall:",
    "    source: kb",
    "  embedding:",
    "    provider: deepinfra",
    `    baseUrl: http://127.0.0.1:${stubPort}/v1`,
    "    apiKey: stub-key",
    "    model: Qwen/Qwen3-Embedding-4B",
    "    dimensions: 1024",
    "",
  ].join("\n"));

  const children: ChildProcess[] = [];
  const stopAll = () => { for (const c of children) { try { c.kill(); } catch { /* gone */ } } };
  process.on("exit", stopAll);

  const stub = spawn(process.execPath, ["--import", TSX, fileURLToPath(import.meta.url), "--stub", "--stub-port", String(stubPort)], { stdio: "ignore" });
  children.push(stub);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["OPENAI_API_KEY", "DEEPINFRA_API_KEY", "TDAI_FALLBACK_LLM_API_KEY", "TDAI_GATEWAY_TOKEN", "TDAI_TOKEN_PATH", "TDAI_CC_PID"]) delete env[k];
  Object.assign(env, {
    TDAI_GATEWAY_PORT: String(port),
    TDAI_DATA_DIR: dataDir,
    TDAI_GATEWAY_CONFIG: path.join(dataDir, "tdai-gateway.yaml"),
    TDAI_LLM_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
    TDAI_LLM_API_KEY: "stub-key",
    TDAI_LLM_MODEL: "stub",
    TDAI_LLM_TIMEOUT_MS: "30000",
  });
  const out = fs.openSync(gwOut, "w");
  // Default: the BUILT bundle (what the live gateway runs). tsx compiles TS on the fly, which freezes the
  // loop on first use of every module and would pollute the lag numbers; --tsx opts into running sources.
  const gwArgs = flag("tsx")
    ? ["--max-old-space-size=3072", "--import", TSX, path.join(srcRoot, "src/gateway/cli.ts")]
    : ["--max-old-space-size=3072", path.join(srcRoot, "dist/src/gateway/cli.mjs")];
  // --cpu-prof: V8 CPU profiles of the gateway AND the worker (child processes inherit NODE_OPTIONS). The profile
  // is only written on a clean exit, so the gateway is stopped through its TDAI_CC_PID parent-watch (a dummy
  // process we kill at the end) instead of a hard kill.
  const profDir = path.join(logDir, `prof-${label}-${stamp}`);
  let ccHolder: ChildProcess | undefined;
  if (flag("cpu-prof")) {
    fs.mkdirSync(profDir, { recursive: true });
    ccHolder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(ccHolder);
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --cpu-prof --cpu-prof-dir=${profDir}`.trim();
    env.TDAI_CC_PID = String(ccHolder.pid);
  }
  const gw = spawn(process.execPath, gwArgs, {
    cwd: dataDir,
    env,
    stdio: ["ignore", out, out],
  });
  children.push(gw);
  const base = `http://127.0.0.1:${port}`;
  console.log(`[${label}] gateway pid=${gw.pid} port=${port} src=${srcRoot} log=${gwOut}`);

  const bootStart = performance.now();
  let ready = false;
  while (performance.now() - bootStart < 15 * 60_000) {
    if (gw.exitCode !== null) throw new Error(`gateway exited early (code ${gw.exitCode}); see ${gwOut}`);
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      if (r.status === 200 || (r.status === 503 && ((await r.json().catch(() => ({}))) as { status?: string }).status !== "starting")) { ready = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error("gateway never became ready");
  const bootMs = performance.now() - bootStart;
  console.log(`[${label}] ready after ${(bootMs / 1000).toFixed(1)} s`);

  const lagSeries: Array<{ phase: string; p99: number; max: number }> = [];
  const extra: string[] = [];
  let stopFlag = false;

  const loops: Array<Promise<void>> = [];
  const every = (ms: number, fn: () => Promise<void>) => loops.push((async () => {
    while (!stopFlag) { const t = performance.now(); await fn().catch(() => {}); const wait = ms - (performance.now() - t); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
  })());

  const QUERIES = ["dove eravamo? riprendi il lavoro sul gateway sinapsys", "fix the recall timeout in the hook", "come funziona il banner di apertura sessione", "sofia dashboard deploy vercel", "controlla le entita duplicate nel grafo", "typescript strict zod validation", "perche la memoria non inietta i ricordi giusti"];
  let q = 0;
  every(1000, async () => { const i = q++; await call(base, "recall", "POST", "/recall", { query: QUERIES[i % QUERIES.length], session_key: `bench-probe-${i % 3}`, session_id: `bench-probe-${i % 3}`, project: "tencentdb-agent-memory" }); });
  every(250, async () => { await call(base, "pretool", "POST", "/pretool", { session_key: "bench-probe-0", project: "tencentdb-agent-memory", tool_name: "Edit", tool_input: { file_path: "C:/Users/lo/tencentdb-agent-memory/src/core/store/sqlite.ts" } }); });
  every(500, async () => { await call(base, "observe", "POST", "/observe", { session_key: "bench-probe-1", tool_name: "Read", tool_input: { file_path: "src/gateway/server.ts" }, project: "tencentdb-agent-memory" }); });
  every(250, async () => { const r = await call(base, "health", "GET", "/health"); const ev = (r.json as { event_loop?: { p99Ms: number; maxMs: number } } | null)?.event_loop; if (ev) lagSeries.push({ phase: phaseOf.current, p99: ev.p99Ms, max: ev.maxMs }); });
  every(50, async () => { await call(base, "loop-404", "GET", "/__loop_probe", undefined, 30_000); });

  if (!flag("no-load")) {
    const sessions = ["bench-load-a", "bench-load-b", "bench-load-c", "bench-load-d"];
    let burst = 0;
    every(2000, async () => {
      const sk = sessions[burst++ % sessions.length]!;
      const text = `benchmark turn ${burst}: we decided to change the retry logic in module ${burst % 11} because of bug ${burst % 5}`;
      await call(base, "bg-capture", "POST", "/capture", { user_content: text, assistant_content: `ack ${text}`, session_key: sk, session_id: `${sk}-id`, idempotency_key: `bench_${label}_${stamp}_${burst}` });
    });
    let big = 0;
    every(15_000, async () => {
      const sk = `bench-big-${big++}`;
      const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `big batch ${big} message ${i}: investigating the sqlite wal checkpoint and the fts rowid layout`, timestamp: Date.now() + i }));
      await call(base, "bg-capture-60", "POST", "/capture", { user_content: messages[0]!.content, assistant_content: messages[1]!.content, session_key: sk, session_id: sk, messages, idempotency_key: `benchbig_${label}_${stamp}_${big}` });
    });
    let kw = 0;
    every(3000, async () => { const n = kw++; await call(base, "bg-kbwrite", "POST", "/kb/write", { facts: [{ entity_name: `Bench Entity ${n}`, entity_type: "concept", attribute: "note", value: `kb write ${n} ${Date.now()}` }], session_key: "bench-kbwrite" }); });
    let se = 0;
    every(12_000, async () => { await call(base, "bg-session-end", "POST", "/session/end", { session_key: sessions[se++ % sessions.length] }, 300_000); });
    let so = 0;
    every(8000, async () => { const n = so++; await call(base, "bg-session-open", "POST", "/recall", { query: "dove eravamo", session_key: `bench-open-${n}`, session_id: `bench-open-${n}`, project: "tencentdb-agent-memory" }); });
  }

  // Phase 1: "boot" = background jobs + kb-nav load/build starting right at readiness.
  phaseOf.current = "boot-60s";
  await new Promise((r) => setTimeout(r, 60_000));
  phaseOf.current = "steady";
  await new Promise((r) => setTimeout(r, durationS * 1000));
  stopFlag = true;
  await Promise.all(loops);

  const health = await call(base, "final-health", "GET", "/health");
  extra.push(`final /health: ${JSON.stringify(health.json)}`);
  if (ccHolder) {
    ccHolder.kill();
    await Promise.race([new Promise<void>((r) => gw.once("exit", () => r())), new Promise((r) => setTimeout(r, 60_000))]);
    extra.push(`cpu profiles written to ${profDir}`);
  }
  gw.kill();
  stub.kill();
  await new Promise((r) => setTimeout(r, 1500));

  // L0 capture write cost from the gateway log ("Capture timing: ... l0VecIndex=NNNms").
  const logText = fs.readFileSync(gwOut, "utf-8");
  const l0 = [...logText.matchAll(/l0VecIndex=(\d+)ms/g)].map((m) => Number(m[1]));
  const l0msgs = [...logText.matchAll(/l0VecIndex=\d+ms \([^)]*msgs=(\d+)\)/g)].map((m) => Number(m[1]));
  const perMsg = l0.map((ms, i) => ms / Math.max(1, l0msgs[i] ?? 1));
  const slow = [...logText.matchAll(/SLOW RECALL[^\n]*/g)].length;
  const w = (re: RegExp) => [...logText.matchAll(re)].length;
  extra.push(`L0 capture write cost (l0VecIndex): n=${l0.length} p50=${pct(l0, 0.5).toFixed(0)}ms p95=${pct(l0, 0.95).toFixed(0)}ms max=${Math.max(...l0, 0).toFixed(0)}ms | per message p50=${pct(perMsg, 0.5).toFixed(1)}ms max=${Math.max(...perMsg, 0).toFixed(1)}ms`);
  extra.push(`SLOW RECALL lines: ${slow} | kb-nav load/build lines: ${w(/kb-nav index (built|LOADED)/g)} | extraction applied lines: ${w(/\[kb-extractor\][^\n]*(applied|entities)/g)}`);

  const text = report(label, lagSeries) + "\n" + extra.join("\n");
  console.log(text);
  fs.writeFileSync(path.join(logDir, `${label}-${stamp}.report.txt`), text + "\n");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
