/**
 * Replay a fixed set of real prompts per project through the REAL recall path
 * (performAutoRecall + the gateway's composeRecallContext) against a DB path, and
 * measure what the agent would have been shown:
 *
 *   - memory lines per turn, % of turns with NO <relevant-memories> block
 *   - cross-project lines (a memory whose project is known and is not the prompt's)
 *   - injected chars per turn (stable + dynamic, after the gateway's budget trim)
 *   - recall latency p50 / p95
 *
 * Asserts 0 cross-project lines (exit code 1 otherwise) — the Phase 3 acceptance rail.
 *
 * Read-mostly: the store's bookkeeping writes (ledger, gate, reinforce, recap, registry)
 * are stubbed unless --writes is given. Always point --db at a COPY, never the live DB.
 *
 * USAGE
 *   node --max-old-space-size=3072 --import tsx tools/recall-replay.mts \
 *        --db C:/Users/lo/tdai-perf-copy/vectors-copy.db \
 *        --data-dir C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local \
 *        --prompts C:/Users/lo/tdai-perf-copy/replay-set.json \
 *        [--out report.json] [--label before] [--legacy] [--dims 1024] [--show]
 *
 *   --legacy   run with recall.selective.enabled=false (the pre-Phase-3 behaviour)
 *   --show     print the memory lines (default: counts only — prompts are private)
 *
 * Prompt set: produced by tools/build-replay-set.mts, kept OUTSIDE the repo.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { VectorStore } from "../src/core/store/sqlite.js";
import { parseConfig } from "../src/config.js";
import { performAutoRecall } from "../src/core/hooks/auto-recall.js";
import { SessionBannerTracker } from "../src/core/hooks/session-banner.js";
import { composeRecallContext } from "../src/gateway/recall-context.js";
import { renderGroundedTrustInterrupt } from "../src/core/kb/grounded-trust-ask.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

interface PromptSet {
  projects: Record<string, { cwd: string; prompts: string[] }>;
}

interface TurnReport {
  project: string;
  turn: number;
  lines: number;
  silent: boolean;
  assocLines: number;
  crossProject: number;
  chars: number;
  stableChars: number;
  askLines: number;
  ms: number;
}

const WRITE_METHODS = new Set([
  "gateRecalledUnits", "recordRecallInjections", "reinforceRecalledOwners",
  "insertEvent", "setSessionProject", "recordSilentTurn",
]);

function stubWrites(store: VectorStore): VectorStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      if (typeof prop === "string" && WRITE_METHODS.has(prop)) return () => undefined;
      return (...a: unknown[]) => (v as (...x: unknown[]) => unknown).apply(target, a);
    },
  });
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

/** Memory lines of the <relevant-memories> block of a composed context ("- " bullets). */
function memoryLinesOf(context: string): string[] {
  const m = context.match(/<relevant-memories>([\s\S]*?)<\/relevant-memories>/);
  if (!m) return [];
  return m[1]!.split("\n").filter((l) => l.trimStart().startsWith("-"));
}

/** project of a memory owner, '' when unknown (chat imports, un-tagged). Same coalesce the filter uses. */
function ownerProject(db: import("node:sqlite").DatabaseSync, ownerId: string, kind: string): string {
  const row = (kind === "event"
    ? db.prepare(
        `SELECT COALESCE(NULLIF(e.project,''), sp.project, '') AS p
           FROM events e LEFT JOIN session_projects sp ON sp.session_key = e.session_key WHERE e.id = ?`,
      ).get(ownerId)
    : db.prepare(
        `SELECT COALESCE(NULLIF(ev.project,''), sp.project, NULLIF(en.project,''), '') AS p, en.type AS t
           FROM facts f LEFT JOIN events ev ON ev.id = f.source_event_id
           LEFT JOIN session_projects sp ON sp.session_key = ev.session_key
           LEFT JOIN entities en ON en.id = f.entity_id WHERE f.id = ?`,
      ).get(ownerId)) as { p?: string; t?: string } | undefined;
  if (!row) return "";
  if (kind !== "event" && (row.t === "person" || row.t === "preference")) return ""; // user-level
  return row.p ?? "";
}

async function main(): Promise<void> {
  const dbPath = arg("db");
  const dataDir = arg("data-dir");
  const promptsPath = arg("prompts");
  if (!dbPath || !dataDir || !promptsPath) {
    throw new Error("--db, --data-dir and --prompts are required");
  }
  const label = arg("label") ?? "run";
  const dims = Number(arg("dims") ?? "1024");
  const set = JSON.parse(fs.readFileSync(promptsPath, "utf-8")) as PromptSet;

  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const raw = new VectorStore(dbPath, dims, quiet);
  raw.init();
  const store = flag("writes") ? raw : stubWrites(raw);
  const db = (raw as unknown as { db: import("node:sqlite").DatabaseSync }).db;

  const cfg = parseConfig({
    recall: { source: "kb", ...(flag("legacy") ? { selective: { enabled: false } } : {}) },
  });
  const askMod = (await import("../src/core/kb/grounded-trust-ask.js")) as Record<string, unknown>;
  const buildAsks = askMod.buildGroundedTrustBlock as
    | ((s: unknown, o: { project?: string; sessionId?: string }) => string)
    | undefined;

  const reports: TurnReport[] = [];
  for (const [project, { cwd, prompts }] of Object.entries(set.projects)) {
    const sessionKey = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
    const sessionId = `replay-${label}-${project}`;
    const tracker = new SessionBannerTracker();
    for (let i = 0; i < prompts.length; i++) {
      const t0 = performance.now();
      const result = await performAutoRecall({
        userText: prompts[i]!,
        actorId: "replay",
        sessionKey,
        sessionId,
        cfg,
        pluginDataDir: dataDir,
        projectName: project,
        logger: quiet,
        vectorStore: store,
        bannerTracker: tracker,
      });
      if (result?.bannerEmitted) tracker.markEmitted(sessionId);
      let ask = "";
      try {
        ask = buildAsks
          ? buildAsks(store, { project, sessionId })
          : renderGroundedTrustInterrupt(
              (store as unknown as { getPendingAsks(n: number): never[] }).getPendingAsks(5),
            );
      } catch { /* asks are best-effort, as in the gateway */ }
      const prepend = ask ? (result?.prependContext ? `${ask}\n\n${result.prependContext}` : ask) : result?.prependContext;
      const ms = performance.now() - t0;
      const context = composeRecallContext({ appendSystemContext: result?.appendSystemContext, prependContext: prepend });
      const lines = memoryLinesOf(context);
      let cross = 0;
      for (const m of result?.recalledL1Memories ?? []) {
        const id = (m as { ownerId?: string }).ownerId;
        if (!id) continue;
        const p = ownerProject(db, id, m.type);
        if (p && p !== project) cross++;
      }
      if (flag("show")) {
        console.log(`\n[${project} #${i}] ${lines.length} lines, ${context.length} chars`);
        for (const l of lines) console.log("   ", l.slice(0, 200));
      }
      reports.push({
        project, turn: i, lines: lines.length, silent: lines.length === 0,
        assocLines: lines.filter((l) => l.includes("associato")).length,
        crossProject: cross, chars: context.length,
        stableChars: result?.appendSystemContext?.length ?? 0,
        askLines: ask ? ask.split("\n").filter((l) => /^\d+\./.test(l)).length : 0,
        ms,
      });
    }
  }

  const n = reports.length;
  const sum = (f: (r: TurnReport) => number): number => reports.reduce((a, r) => a + f(r), 0);
  const summary = {
    label, legacy: flag("legacy"), turns: n,
    projects: Object.keys(set.projects).length,
    linesPerTurn: +(sum((r) => r.lines) / n).toFixed(2),
    maxLines: Math.max(...reports.map((r) => r.lines)),
    silentTurnsPct: +((100 * reports.filter((r) => r.silent).length) / n).toFixed(1),
    assocLinesPerTurn: +(sum((r) => r.assocLines) / n).toFixed(2),
    crossProjectLines: sum((r) => r.crossProject),
    charsPerTurn: Math.round(sum((r) => r.chars) / n),
    stableCharsPerTurn: Math.round(sum((r) => r.stableChars) / n),
    askLinesPerTurn: +(sum((r) => r.askLines) / n).toFixed(2),
    latencyMs: { p50: Math.round(pct(reports.map((r) => r.ms), 0.5)), p95: Math.round(pct(reports.map((r) => r.ms), 0.95)) },
  };
  console.log(JSON.stringify(summary, null, 2));
  const out = arg("out");
  if (out) fs.writeFileSync(out, JSON.stringify({ summary, turns: reports }, null, 1));
  if (summary.crossProjectLines > 0) {
    console.error(`FAIL: ${summary.crossProjectLines} cross-project memory line(s)`);
    process.exitCode = 1;
  }
}

await main();
