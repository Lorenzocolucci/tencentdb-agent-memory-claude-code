/**
 * Import Claude Code history into Sinapsys with REAL timestamps and the right project.
 *
 * Sources (see src/cli/backfill/code-history.ts):
 *   - ~/.claude/history.jsonl          prompts only, 27/09/2025 → 29/06/2026
 *   - ~/.claude/projects/** /*.jsonl    full transcripts (30-day retention): only the
 *                                      turns the live Stop hook never captured
 * Argus `claude -p` children and sessions touched in the last --active-hours are skipped.
 *
 * Why not /capture: it dates every message at import time — nine months of history
 * would all look like today and fool every recency-aware part of recall.
 *
 * USAGE
 *   npx tsx tools/import-code-history.mts                 # dry run: counts only
 *   npx tsx tools/import-code-history.mts --real          # write L0 (gateway MUST be stopped)
 *   npx tsx tools/import-code-history.mts --digest        # gateway running: extract the imported keys
 * Options: --data-dir <dir> --history <file> --projects-root <dir> --active-hours 24
 *
 * Idempotent: messages are keyed (hist:<hash>, cc:<session>:<turn>:u|a) in the same
 * backfill-ledger.db the chat import uses, and record ids are deterministic.
 * --digest remembers finished keys in code-history-digest-done.json and resumes.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../src/core/store/sqlite.js";
import { ImportLedger } from "../src/cli/backfill/import-ledger.js";
import { ingestConversation } from "../src/cli/backfill/message-ingestor.js";
import { historyToConversations, transcriptToConversation, type CodeConversation } from "../src/cli/backfill/code-history.js";
import { buildPlan } from "../src/cli/backfill-cc/build-plan.js";
import { postDigest, readToken } from "../src/cli/backfill-cc/gateway-http.js";
import { getProjectName } from "../claude-code-plugin/lib/session-key.js";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const HOME = os.homedir();
const dataDir = arg("data-dir", path.join(HOME, ".claude", "plugins", "data", "tdai-memory-tdai-local"));
const historyPath = arg("history", path.join(HOME, ".claude", "history.jsonl"));
const projectsRoot = arg("projects-root", path.join(HOME, ".claude", "projects"));
const activeHours = Number(arg("active-hours", "24"));
const keysPath = path.join(dataDir, "code-history-keys.json");
const donePath = path.join(dataDir, "code-history-digest-done.json");

interface Source { conv: CodeConversation; prefix: "histimport" | "ccimport" }

async function collect(): Promise<Source[]> {
  const out: Source[] = [];
  if (fs.existsSync(historyPath)) {
    const lines = fs.readFileSync(historyPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const conv of historyToConversations(lines)) out.push({ conv, prefix: "histimport" });
  }
  const plan = await buildPlan({ projectsRoot, dataDir });
  const cutoff = Date.now() - activeHours * 3600_000;
  for (const r of plan.rows) {
    if (r.cls !== "captured-partial" && r.cls !== "never-captured") continue;
    if (!r.sessionId || !r.cwd) continue;
    if (fs.statSync(r.transcriptPath).mtimeMs > cutoff) continue; // still live: the hook owns it
    const lines = fs.readFileSync(r.transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
    const conv = transcriptToConversation(r.sessionId, r.cwd, lines, r.cursorTurns ?? 0);
    if (conv) out.push({ conv, prefix: "ccimport" });
  }
  return out;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

function summary(sources: Source[]): void {
  const by = new Map<string, { convs: number; msgs: number }>();
  for (const { conv, prefix } of sources) {
    const k = `${prefix}  ${getProjectName(conv.cwd)}`;
    const v = by.get(k) ?? { convs: 0, msgs: 0 };
    by.set(k, { convs: v.convs + 1, msgs: v.msgs + conv.chat_messages.length });
  }
  for (const [k, v] of [...by].sort((a, b) => b[1].msgs - a[1].msgs)) console.log(`  ${k.padEnd(48)} ${String(v.convs).padStart(4)} conv  ${String(v.msgs).padStart(6)} msg`);
  const msgs = sources.reduce((n, s) => n + s.conv.chat_messages.length, 0);
  console.log(`TOTAL ${sources.length} conversations, ${msgs} messages`);
}

async function runImport(real: boolean): Promise<void> {
  const sources = await collect();
  summary(sources);
  if (!real) { console.log("DRY RUN: nothing written. Re-run with --real (gateway stopped)."); return; }
  if (await portOpen(8421)) throw new Error("gateway is running on :8421 — stop it first (single writer)");

  const store = new VectorStore(path.join(dataDir, "vectors.db"), 0);
  store.init();
  if (store.isDegraded()) throw new Error("VectorStore degraded — aborting");
  const ledger = new ImportLedger(path.join(dataDir, "backfill-ledger.db"));
  const keys: string[] = [];
  let ingested = 0, dup = 0, failed = 0;
  try {
    for (const { conv, prefix } of sources) {
      const s = await ingestConversation(conv, { store, ledger, dryRun: false, keyPrefix: prefix });
      ingested += s.messagesIngested; dup += s.messagesSkippedDuplicate; failed += s.messagesFailed;
      const key = `${prefix}_${conv.uuid}`;
      store.setSessionProject(key, getProjectName(conv.cwd));
      keys.push(key);
    }
  } finally {
    store.close();
  }
  fs.writeFileSync(keysPath, JSON.stringify(keys, null, 1));
  console.log(`WRITTEN: ingested=${ingested} duplicates_skipped=${dup} failed=${failed} keys=${keys.length} → ${keysPath}`);
  if (failed > 0) process.exitCode = 1;
}

async function runDigest(): Promise<void> {
  const keys = JSON.parse(fs.readFileSync(keysPath, "utf8")) as string[];
  const done = new Set<string>(fs.existsSync(donePath) ? (JSON.parse(fs.readFileSync(donePath, "utf8")) as string[]) : []);
  const token = await readToken(path.join(dataDir, "token"));
  const todo = keys.filter((k) => !done.has(k));
  console.log(`digest: ${todo.length} to do, ${done.size} already done`);
  let i = 0;
  for (const key of todo) {
    i++;
    const t0 = Date.now();
    try {
      const r = await postDigest({ baseUrl: "http://127.0.0.1:8421", token, sessionKey: key });
      done.add(key);
      fs.writeFileSync(donePath, JSON.stringify([...done]));
      console.log(`[${i}/${todo.length}] ${key} processed=${r.processedCount ?? "?"} ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (err) {
      console.log(`[${i}/${todo.length}] ${key} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

if (has("digest")) await runDigest();
else await runImport(has("real"));
