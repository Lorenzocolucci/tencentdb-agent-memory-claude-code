/**
 * Offline recall evaluation on GROUND TRUTH: replay real past prompts through the
 * recall path and score what comes back against the recall ledger's USED / noise
 * verdicts (see src/core/kb/recall-eval.ts for the metrics).
 *
 * How a prompt is rebuilt: the ledger stores, per recall turn, (session_key, ts) and the
 * judged memories but not the prompt. The prompt is the first L0 user message of that
 * session_key captured at/after the recall time. The pairing is CONFIRMED by re-running
 * the usage judge on (that prompt, that turn's reply) over the turn's memories: only
 * turns whose stored verdicts are reproduced exactly are kept.
 *
 * Fairness rails:
 *   - time guard: a memory recorded after the prompt (events.recorded_at, facts.learned_at)
 *     is excluded — it did not exist then, and the memory extracted from the very turn
 *     would otherwise echo the reply;
 *   - chronic noise is computed point-in-time from ledger rows BEFORE the prompt;
 *   - no session de-dup and no situation seeds (each prompt is replayed alone);
 *   - all store writes stubbed; open a COPY, never the live DB.
 *
 * USAGE
 *   node --max-old-space-size=3072 --import tsx tools/recall-eval.mts \
 *     --db C:/Users/lo/tdai-perf-copy/vectors-copy.db [--dims 1024] \
 *     [--arms legacy,selective] [--selective '{"minRelevance":0.6}'] [--grid grid.json] \
 *     [--split train|holdout|all] [--seed 42] [--holdout 0.3] [--per-project 80] [--min-per-project 15] \
 *     [--env-file C:/Users/lo/tdai-gateway/gateway.secrets.env --embed-key-env DEEPINFRA_API_KEY \
 *      --embed-base-url https://api.deepinfra.com/v1/openai --embed-model Qwen/Qwen3-Embedding-4B \
 *      --embed-cache C:/Users/lo/tdai-perf-copy/recall-eval-embed-cache.json] \
 *     [--no-vector] [--out report.json] [--diagnose] [--before 2026-10-03T00:00:00Z]
 *
 * Prints counts and metrics only — never prompt or memory text (private), never a secret.
 */

import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../src/core/store/sqlite.js";
import { parseConfig } from "../src/config.js";
import { runKbRecall } from "../src/core/hooks/auto-recall.js";
import { createEmbeddingService, type EmbeddingService } from "../src/core/store/embedding.js";
import { judgeMemoryUsage, judgeTurn } from "../src/core/kb/recall-usage.js";
import { distinctiveTokens, evidencePoints, ownerKey, projectsConflict } from "../src/core/kb/selective-recall.js";
import {
  ChronicNoiseTimeline,
  isMachinePrompt,
  scoreQuery,
  splitOf,
  stratifiedSample,
  summarize,
  type LabeledQuery,
  type QueryScore,
} from "../src/core/kb/recall-eval.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const PAIR_WINDOW_MS = 3 * 3600_000;
const MAX_PROMPT_CHARS = 6000;

// ─── ground truth ────────────────────────────────────────────────────────────

interface LedgerRow {
  session_key: string;
  ts: string;
  owner_id: string;
  owner_kind: string;
  used: number;
  unjudgeable: number;
  memory_text: string;
}

function loadQueries(db: DatabaseSync, before: string): { queries: LabeledQuery[]; timeline: ChronicNoiseTimeline; stats: Record<string, number> } {
  const rows = db
    .prepare(
      `SELECT session_key, ts, owner_id, owner_kind, used, unjudgeable, memory_text FROM recall_ledger
        WHERE judged = 1 AND owner_kind != 'turn' AND ts < ? ORDER BY session_key, ts`,
    )
    .all(before) as unknown as LedgerRow[];
  const timeline = new ChronicNoiseTimeline(
    rows.filter((r) => !r.unjudgeable).map((r) => ({ key: ownerKey(r.owner_kind, r.owner_id), atMs: Date.parse(r.ts), used: r.used === 1 })),
  );
  const turns = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    if (r.unjudgeable) continue;
    const k = `${r.session_key}|${r.ts}`;
    const list = turns.get(k) ?? [];
    list.push(r);
    turns.set(k, list);
  }
  const projectOf = db.prepare("SELECT project FROM session_projects WHERE session_key = ?");
  const nextUser = db.prepare(
    "SELECT timestamp, message_text, session_id FROM l0_conversations WHERE session_key = ? AND role = 'user' AND timestamp >= ? ORDER BY timestamp LIMIT 1",
  );
  const replyAt = db.prepare(
    "SELECT group_concat(message_text, char(10)) AS t FROM l0_conversations WHERE session_key = ? AND role = 'assistant' AND timestamp = ?",
  );
  const stats = { turns: turns.size, paired: 0, confirmed: 0, machine: 0, noProject: 0 };
  const byKey = new Map<string, LabeledQuery>();
  for (const list of turns.values()) {
    const { session_key: sk, ts } = list[0]!;
    const atMs = Date.parse(ts);
    const u = nextUser.get(sk, atMs) as { timestamp: number; message_text: string; session_id: string } | undefined;
    if (!u || u.timestamp - atMs > PAIR_WINDOW_MS) continue;
    stats.paired++;
    const reply = (replyAt.get(sk, u.timestamp) as { t?: string } | undefined)?.t ?? "";
    const verdict = judgeTurn(list.map((r) => ({ ownerId: r.owner_id, memoryText: r.memory_text })), u.message_text, reply);
    const mine = new Map(verdict.perMemory.map((m) => [m.ownerId, m.used]));
    if (!list.every((r) => (mine.get(r.owner_id) ? 1 : 0) === r.used)) continue;
    stats.confirmed++;
    const query = u.message_text.trim();
    if (query.length < 3 || query.length > MAX_PROMPT_CHARS || isMachinePrompt(query)) {
      stats.machine++;
      continue;
    }
    const project = ((projectOf.get(sk) as { project?: string } | undefined)?.project ?? "").trim();
    if (!project) {
      stats.noProject++;
      continue;
    }
    const key = createHash("sha256").update(`${project}\u0000${query}`).digest("hex").slice(0, 20);
    const q = byKey.get(key) ?? { key, project, query, atMs, labels: new Map<string, boolean>(), replies: [] as string[], conversationIds: [] as string[] };
    q.atMs = Math.min(q.atMs, atMs);
    q.replies!.push(reply);
    if (u.session_id) q.conversationIds!.push(u.session_id);
    for (const r of list) {
      const k = ownerKey(r.owner_kind, r.owner_id);
      q.labels.set(k, (q.labels.get(k) ?? false) || r.used === 1); // used in any turn = used
    }
    byKey.set(key, q);
  }
  return { queries: [...byKey.values()], timeline, stats: { ...stats, uniquePrompts: byKey.size } };
}

// ─── store wrappers ──────────────────────────────────────────────────────────

const WRITE_METHODS = new Set([
  "gateRecalledUnits", "recordRecallInjections", "reinforceRecalledOwners",
  "insertEvent", "setSessionProject", "recordSilentTurn",
]);

type Owner = { owner_id: string; owner_kind: string };

/** Owners recorded after `atMs` ("kind:id"). */
function futureKeys(db: DatabaseSync, owners: readonly Owner[], atMs: number): Set<string> {
  const out = new Set<string>();
  const iso = new Date(atMs).toISOString();
  const ev = owners.filter((o) => o.owner_kind === "event").map((o) => o.owner_id);
  const fa = owners.filter((o) => o.owner_kind === "fact").map((o) => o.owner_id);
  for (let i = 0; i < ev.length; i += 400) {
    const ids = ev.slice(i, i + 400);
    for (const r of db.prepare(`SELECT id FROM events WHERE recorded_at > ? AND id IN (${ids.map(() => "?").join(",")})`).all(iso, ...ids) as Array<{ id: string }>)
      out.add(ownerKey("event", r.id));
  }
  for (let i = 0; i < fa.length; i += 400) {
    const ids = fa.slice(i, i + 400);
    for (const r of db.prepare(`SELECT id FROM facts WHERE learned_at > ? AND id IN (${ids.map(() => "?").join(",")})`).all(iso, ...ids) as Array<{ id: string }>)
      out.add(ownerKey("fact", r.id));
  }
  return out;
}

function wrapStore(store: VectorStore, db: DatabaseSync, clock: { atMs: number }): VectorStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      if (typeof prop === "string" && WRITE_METHODS.has(prop)) return () => undefined;
      if (prop === "otherProjectOwnerKeys") {
        return (owners: Owner[], project: string | undefined) => {
          const out = (v as (o: Owner[], p?: string) => Set<string>).call(target, owners, project);
          for (const k of futureKeys(db, owners, clock.atMs)) out.add(k);
          return out;
        };
      }
      return (...a: unknown[]) => (v as (...x: unknown[]) => unknown).apply(target, a);
    },
  });
}

/** Query embeddings cached on disk by text hash (the vectors, never the text). */
function cachedEmbedding(inner: EmbeddingService, path: string | undefined): EmbeddingService & { flush(): void; misses: number } {
  const cache = new Map<string, number[]>();
  if (path && fs.existsSync(path)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path, "utf-8")) as Record<string, number[]>)) cache.set(k, v);
  }
  const svc = Object.create(inner) as EmbeddingService & { flush(): void; misses: number };
  svc.misses = 0;
  svc.embed = async (text, opts) => {
    const k = createHash("sha256").update(text).digest("hex");
    const hit = cache.get(k);
    if (hit) return Float32Array.from(hit);
    svc.misses++;
    const v = await inner.embed(text, { ...opts, timeoutMs: 30_000 });
    if (v.length > 0) cache.set(k, Array.from(v));
    return v;
  };
  svc.flush = () => {
    if (path) fs.writeFileSync(path, JSON.stringify(Object.fromEntries(cache)));
  };
  return svc;
}

function loadEnvFile(path: string): void {
  for (const line of fs.readFileSync(path, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const name = t.slice(0, eq).trim();
    if (process.env[name] === undefined) process.env[name] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

interface Arm {
  name: string;
  legacy: boolean;
  selective: Record<string, unknown>;
}

interface PerQuery {
  key: string;
  project: string;
  split: "train" | "holdout";
  returned: string[];
  score: QueryScore;
  /** --explain: per returned owner, why it could be there (no text). */
  explain?: Array<{ key: string; label: "used" | "noise" | "unlabeled"; judged: boolean; sameConversation: boolean | null; rel: string; ageDays: number | null; points: number; score: number; associative: boolean }>;
}

async function runArm(
  arm: Arm,
  queries: readonly (LabeledQuery & { split: "train" | "holdout"; eligibleUsed: Set<string> })[],
  ctx: { store: VectorStore; raw: VectorStore; db: DatabaseSync; clock: { atMs: number }; timeline: ChronicNoiseTimeline; embedding?: EmbeddingService; embeddingCfg: Record<string, unknown>; explain?: boolean },
): Promise<PerQuery[]> {
  const cfg = parseConfig({
    recall: { source: "kb", consolidationBoost: true, selective: arm.legacy ? { enabled: false } : arm.selective },
    embedding: ctx.embeddingCfg,
  });
  const out: PerQuery[] = [];
  for (const q of queries) {
    ctx.clock.atMs = q.atMs;
    const chronic = { keys: (_s: unknown, c: { chronicNoiseMinInjections: number }) => ctx.timeline.keysAt(q.atMs, c.chronicNoiseMinInjections) };
    const t0 = performance.now();
    let results = await runKbRecall(q.query, cfg, quiet as never, ctx.store, ctx.embedding, q.project, undefined, {
      chronicNoise: chronic as never,
      nowMs: q.atMs,
    });
    const ms = performance.now() - t0;
    if (arm.legacy) {
      const fut = futureKeys(ctx.db, results, q.atMs);
      results = results.filter((r) => !fut.has(ownerKey(r.owner_kind, r.owner_id)));
    }
    const returned = results.map((r) => ownerKey(r.owner_kind, r.owner_id));
    // Counterfactual verdict: the same judge, on the same prompt and reply, for every returned line.
    const replies = q.replies ?? [];
    const judgedUsed = replies.length === 0 ? undefined : results.filter((r) =>
      replies.some((reply) => judgeMemoryUsage({ memoryText: r.text, userText: q.query, assistantText: reply }).used)).length;
    let cross = 0;
    const projects = ctx.raw.getOwnerProjects(results.map((r) => ({ owner_id: r.owner_id, owner_kind: r.owner_kind })));
    for (const k of returned) {
      const info = projects.get(k);
      if (info && !info.userLevel && projectsConflict(info.project, q.project)) cross++;
    }
    const entry: PerQuery = { key: q.key, project: q.project, split: q.split, returned, score: scoreQuery(returned, q.labels, { crossProject: cross, ms, eligibleUsed: q.eligibleUsed, judgedUsed }) };
    if (ctx.explain) {
      const tokens = distinctiveTokens(q.query);
      const rare = (ctx.raw as unknown as { rareKbTokens(t: readonly string[], n: number): Set<string> }).rareKbTokens(tokens, 100);
      const convs = new Set(q.conversationIds ?? []);
      entry.explain = results.map((r) => {
        const src = sourceConversation(ctx.db, r.owner_kind, r.owner_id);
        const k = ownerKey(r.owner_kind, r.owner_id);
        const info = projects.get(k);
        const rel = !info ? "unknown" : info.userLevel ? "user-level" : info.project === "" ? "empty-project" : projectsConflict(info.project, q.project) ? "other-project" : "same-project";
        const t = r.ts ? Date.parse(r.ts) : NaN;
        const label = q.labels.has(k) ? (q.labels.get(k) ? "used" : "noise") : "unlabeled";
        return {
          key: k, label, rel,
          judged: replies.some((reply) => judgeMemoryUsage({ memoryText: r.text, userText: q.query, assistantText: reply }).used),
          sameConversation: src && convs.size > 0 ? convs.has(src) : null,
          ageDays: Number.isFinite(t) ? Math.round((q.atMs - t) / 86_400_000) : null,
          points: evidencePoints(tokens, r.text, rare), score: +r.score.toFixed(3), associative: !!r.associative,
        } as const;
      });
    }
    out.push(entry);
  }
  return out;
}

/** CC conversation an owner was extracted in (events directly, facts via their source event). */
function sourceConversation(db: DatabaseSync, kind: string, id: string): string {
  const row = (kind === "event"
    ? db.prepare("SELECT session_id AS s FROM events WHERE id = ?").get(id)
    : db.prepare("SELECT e.session_id AS s FROM facts f JOIN events e ON e.id = f.source_event_id WHERE f.id = ?").get(id)) as { s?: string } | undefined;
  return row?.s ?? "";
}

/** Returned lines by class (project relation × kind × points × conversation) with labeled and judged hit rates. */
function explainSummary(per: readonly PerQuery[]): Record<string, { n: number; used: number; noise: number; judged: number }> {
  const out: Record<string, { n: number; used: number; noise: number; judged: number }> = {};
  for (const p of per) {
    for (const e of p.explain ?? []) {
      const conv = e.sameConversation == null ? "conv?" : e.sameConversation ? "sameConv" : "otherConv";
      const k = `${e.rel}|${e.key.slice(0, e.key.indexOf(":"))}|age${e.ageDays == null ? "?" : e.ageDays <= 14 ? "<=14" : ">14"}|pts${Math.min(e.points, 4)}|${conv}${e.associative ? "|assoc" : ""}`;
      const c = (out[k] ??= { n: 0, used: 0, noise: 0, judged: 0 });
      c.n++;
      if (e.label === "used") c.used++;
      if (e.label === "noise") c.noise++;
      if (e.judged) c.judged++;
    }
  }
  return out;
}

/** Why are historically used memories not returned? Counts per cause (lexical evidence, label, existence). */
function diagnose(
  queries: readonly LabeledQuery[],
  perQuery: readonly PerQuery[],
  ctx: { raw: VectorStore; db: DatabaseSync },
): Record<string, unknown> {
  const byKey = new Map(perQuery.map((p) => [p.key, p]));
  const counts: Record<string, number> = {};
  const bump = (k: string): void => { counts[k] = (counts[k] ?? 0) + 1; };
  const pointsHist: Record<string, number> = {};
  const eventText = ctx.db.prepare("SELECT text, recorded_at FROM events WHERE id = ?");
  const factRow = ctx.db.prepare("SELECT f.attribute, f.value, f.superseded_by, f.valid_to, e.name FROM facts f LEFT JOIN entities e ON e.id = f.entity_id WHERE f.id = ?");
  for (const q of queries) {
    const p = byKey.get(q.key);
    if (!p) continue;
    const got = new Set(p.returned);
    const tokens = distinctiveTokens(q.query);
    const rare = (ctx.raw as unknown as { rareKbTokens(t: readonly string[], n: number): Set<string> }).rareKbTokens(tokens, 100);
    const missed = [...q.labels].filter(([k, used]) => used && !got.has(k)).map(([k]) => k);
    if (missed.length === 0) continue;
    const projects = ctx.raw.getOwnerProjects(missed.map((k) => ({ owner_kind: k.split(":")[0]!, owner_id: k.slice(k.indexOf(":") + 1) })));
    for (const k of missed) {
      const [kind] = k.split(":");
      const id = k.slice(k.indexOf(":") + 1);
      let body = "";
      if (kind === "event") {
        const r = eventText.get(id) as { text: string } | undefined;
        if (!r) { bump("gone"); continue; }
        body = r.text;
      } else {
        const r = factRow.get(id) as { attribute: string; value: string; superseded_by: string | null; valid_to: string | null; name: string | null } | undefined;
        if (!r) { bump("gone"); continue; }
        if (r.superseded_by || r.valid_to) { bump("fact-not-head"); continue; }
        body = `${r.attribute} ${r.value}`;
      }
      const info = projects.get(k);
      const rel = !info ? "unknown" : info.userLevel ? "user-level" : info.project === "" ? "empty-project" : projectsConflict(info.project, q.project) ? "other-project" : "same-project";
      bump(`project:${rel}`);
      const pts = tokens.length === 0 ? -1 : evidencePoints(tokens, body, rare);
      const bucket = pts < 0 ? "no-tokens" : pts >= 4 ? "4+" : String(pts);
      pointsHist[`${rel}:${bucket}`] = (pointsHist[`${rel}:${bucket}`] ?? 0) + 1;
    }
  }
  return { missedUsedByCause: counts, missedUsedByProjectAndPoints: pointsHist };
}

async function main(): Promise<void> {
  const dbPath = arg("db");
  if (!dbPath) throw new Error("--db is required (a COPY, never the live DB)");
  if (/plugins[\\/]data/i.test(dbPath)) throw new Error("refusing a DB under plugins/data — use a copy");
  const freeGb = os.freemem() / 1e9;
  if (freeGb < 3) throw new Error(`only ${freeGb.toFixed(1)} GB free — need 3 GB`);
  const dims = Number(arg("dims", "1024"));
  const seed = Number(arg("seed", "42"));
  const holdout = Number(arg("holdout", "0.3"));
  const split = (arg("split", "train") as "train" | "holdout" | "all");
  const before = arg("before", "2026-10-03T00:00:00.000Z")!;

  const ro = new DatabaseSync(dbPath, { readOnly: true });
  const { queries: all, timeline, stats } = loadQueries(ro, before);
  const sampled = stratifiedSample(all, (q) => q.project, (q) => q.key, {
    perProject: Number(arg("per-project", "80")),
    minPerProject: Number(arg("min-per-project", "15")),
    seed,
  }).map((q) => ({ ...q, split: splitOf(q.key, seed, holdout) }));
  const chosen = split === "all" ? sampled : sampled.filter((q) => q.split === split);
  const perProject: Record<string, number> = {};
  for (const q of chosen) perProject[q.project] = (perProject[q.project] ?? 0) + 1;
  const withUsed = chosen.filter((q) => [...q.labels.values()].some(Boolean)).length;
  console.log(JSON.stringify({ groundTruth: stats, sampled: sampled.length, split, queries: chosen.length, withUsedOwner: withUsed, perProject }));

  const raw = new VectorStore(dbPath, dims, quiet);
  raw.init();
  const db = (raw as unknown as { db: DatabaseSync }).db;
  // Used owners recall may show: still in the KB and not labeled with another project.
  const queries = chosen.map((q) => {
    const used = [...q.labels].filter(([, v]) => v).map(([k]) => ({ owner_kind: k.slice(0, k.indexOf(":")), owner_id: k.slice(k.indexOf(":") + 1) }));
    const info = raw.getOwnerProjects(used);
    const eligibleUsed = new Set<string>();
    for (const [k, p] of info) if (p.userLevel || !projectsConflict(p.project, q.project)) eligibleUsed.add(k);
    return { ...q, eligibleUsed };
  });
  // Ceiling: under the 0-cross-project rail, only eligible used owners can ever be returned.
  const ceiling = (qs: typeof queries) => {
    const used = qs.reduce((n, q) => n + [...q.labels.values()].filter(Boolean).length, 0);
    const eligible = qs.reduce((n, q) => n + q.eligibleUsed.size, 0);
    return { usedOwners: used, eligibleUsedOwners: eligible, maxRecallUsed: used ? +(eligible / used).toFixed(4) : 0 };
  };
  console.log(JSON.stringify({ ceiling: { all: ceiling(queries), train: ceiling(queries.filter((q) => q.split === "train")), holdout: ceiling(queries.filter((q) => q.split === "holdout")) } }));
  const clock = { atMs: Date.now() };
  const store = wrapStore(raw, db, clock);

  let embedding: (EmbeddingService & { flush(): void; misses: number }) | undefined;
  const embeddingCfg: Record<string, unknown> = { enabled: false, provider: "none" };
  if (!flag("no-vector") && arg("embed-key-env")) {
    if (arg("env-file")) loadEnvFile(arg("env-file")!);
    const key = process.env[arg("embed-key-env")!];
    if (!key) throw new Error(`env ${arg("embed-key-env")} is not set`);
    Object.assign(embeddingCfg, {
      enabled: true, provider: "openai-compatible", baseUrl: arg("embed-base-url"), apiKey: key,
      model: arg("embed-model"), dimensions: dims, recallTimeoutMs: 30_000,
    });
    const svc = createEmbeddingService(parseConfig({ embedding: embeddingCfg }).embedding, quiet as never);
    embedding = cachedEmbedding(svc, arg("embed-cache"));
    const t0 = performance.now();
    const ok = await (raw as unknown as { initKbNavIndex(): Promise<boolean> }).initKbNavIndex();
    console.log(JSON.stringify({ kbNavIndex: ok, active: raw.isKbNavIndexActive(), loadSec: Math.round((performance.now() - t0) / 1000) }));
    // Warm the cache once so arm latency measures the local path, not the network.
    for (const q of queries) await embedding.embed(q.query);
    embedding.flush();
    console.log(JSON.stringify({ embedMisses: embedding.misses }));
  }

  const arms: Arm[] = [];
  const armNames = (arg("arms", "legacy,selective") ?? "").split(",").filter(Boolean);
  if (armNames.includes("legacy")) arms.push({ name: "legacy", legacy: true, selective: {} });
  if (armNames.includes("selective")) arms.push({ name: "selective", legacy: false, selective: arg("selective") ? JSON.parse(arg("selective")!) : {} });
  if (arg("grid")) {
    const grid = JSON.parse(fs.readFileSync(arg("grid")!, "utf-8")) as Array<Record<string, unknown>>;
    grid.forEach((g, i) => arms.push({ name: `grid${i}`, legacy: false, selective: g }));
  }

  const ctx = { store, raw, db, clock, timeline, embedding, embeddingCfg, explain: flag("explain") };
  // Warm-up pass (statement caches, rarity memo) so latency is the warm path.
  if (queries.length > 0 && arms.length > 0) await runArm(arms[arms.length - 1]!, queries.slice(0, 20), ctx);

  const report: Record<string, unknown> = { stats, split, seed, holdout, queries: queries.length, perProject, arms: {} };
  for (const arm of arms) {
    const per = await runArm(arm, queries, ctx);
    const summary = summarize(per.map((p) => p.score));
    const byProject: Record<string, ReturnType<typeof summarize>> = {};
    for (const p of Object.keys(perProject)) byProject[p] = summarize(per.filter((x) => x.project === p).map((x) => x.score));
    const entry: Record<string, unknown> = { selective: arm.selective, summary, byProject };
    if (flag("diagnose")) entry.diagnose = diagnose(queries, per, { raw, db });
    if (flag("per-query") || flag("explain")) entry.perQuery = per;
    if (flag("explain")) {
      entry.explainSummary = explainSummary(per);
      console.log(JSON.stringify(entry.explainSummary));
    }
    if (split === "all") {
      entry.bySplit = {
        train: summarize(per.filter((x) => x.split === "train").map((x) => x.score)),
        holdout: summarize(per.filter((x) => x.split === "holdout").map((x) => x.score)),
      };
    }
    (report.arms as Record<string, unknown>)[arm.name] = entry;
    console.log(JSON.stringify({ arm: arm.name, selective: arm.selective, ...summary }));
    if (entry.bySplit) console.log(JSON.stringify({ arm: arm.name, bySplit: entry.bySplit }));
    if (flag("diagnose")) console.log(JSON.stringify(entry.diagnose));
  }
  // Historical baseline: what legacy actually served for these prompts (from the ledger itself).
  const historical = (qs: readonly LabeledQuery[]) => {
    const used = qs.reduce((a, q) => a + [...q.labels.values()].filter(Boolean).length, 0);
    const labeled = qs.reduce((a, q) => a + q.labels.size, 0);
    return { precision: labeled ? +(used / labeled).toFixed(4) : null, labeledPerTurn: +(labeled / Math.max(1, qs.length)).toFixed(2), recallUsed: 1, silentPct: 0 };
  };
  report.historical = {
    all: historical(queries),
    train: historical(queries.filter((q) => q.split === "train")),
    holdout: historical(queries.filter((q) => q.split === "holdout")),
  };
  console.log(JSON.stringify({ historicalAsServed: report.historical }));
  const out = arg("out");
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
  raw.close();
}

await main();
