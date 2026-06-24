/**
 * kb-migrate.mts — STANDALONE verification tool (throwaway dev, NOT shipped).
 *
 * Migrates the LIVE L0 days 2026-06-16.jsonl + 2026-06-17.jsonl (READ-ONLY) into
 * a FRESH scratch KB at .kb-scratch/vectors.db using the real entity-centric write
 * path (extractKbDelta → parseKbDelta → applyKbDelta). It NEVER touches the 4.6GB
 * live vectors.db; it only reads the conversations/*.jsonl files.
 *
 * Run: node_modules/.bin/tsx tools/kb-migrate.mts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);

import { VectorStore } from "../src/core/store/sqlite.js";
import { createEmbeddingService } from "../src/core/store/embedding.js";
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";
import { extractKbDelta } from "../src/core/kb/kb-extractor.js";
import type { ConversationMessage } from "../src/core/conversation/l0-recorder.js";
import type { Logger } from "../src/core/types.js";

// ============================
// Constants (NO caps / truncation on the data — see windowing note below)
// ============================

const LIVE_CONV_DIR =
  "C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local/conversations";
const DAYS = ["2026-06-16.jsonl", "2026-06-17.jsonl"];
const WINDOW_SIZE = 10; // messages per extraction window (per spec)
const DIMS = 1536; // REQUIRED so kb_vec(vec0) is created

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRATCH_DIR = path.join(REPO_ROOT, ".kb-scratch");
const SCRATCH_DB = path.join(SCRATCH_DIR, "vectors.db");

// ============================
// L0 line shape (exactly as written by l0-recorder.ts)
// ============================

interface L0Line {
  sessionKey: string;
  sessionId: string;
  recordedAt: string;
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// ============================
// Minimal console logger (this is a throwaway CLI tool, not shipped code)
// ============================

const logger: Logger = {
  debug: () => {},
  info: (m: string) => process.stdout.write(`  [info] ${m}\n`),
  warn: (m: string) => process.stdout.write(`  [warn] ${m}\n`),
  error: (m: string) => process.stdout.write(`  [ERROR] ${m}\n`),
};

// ============================
// Helpers
// ============================

function readL0Day(file: string): L0Line[] {
  const full = path.join(LIVE_CONV_DIR, file);
  const raw = fs.readFileSync(full, "utf8"); // READ-ONLY
  const out: L0Line[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as L0Line;
      if (typeof o.sessionKey === "string" && typeof o.content === "string") {
        out.push(o);
      }
    } catch {
      // skip malformed line (defensive; real lines are well-formed)
    }
  }
  return out;
}

/** Group by sessionKey, sort each group by timestamp ASC. */
function groupBySession(lines: L0Line[]): Map<string, L0Line[]> {
  const m = new Map<string, L0Line[]>();
  for (const l of lines) {
    const arr = m.get(l.sessionKey);
    if (arr) arr.push(l);
    else m.set(l.sessionKey, [l]);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
  }
  return m;
}

function toConvMessage(l: L0Line): ConversationMessage {
  return { id: l.id, role: l.role, content: l.content, timestamp: l.timestamp };
}

/** Window an array into fixed-size chunks of `size` (last chunk may be smaller). */
function windowize<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function countRows(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { c: number } | undefined;
  return row ? Number(row.c) : 0;
}

/**
 * Open a read-only connection to the scratch DB with sqlite-vec loaded, so the
 * verification queries can read the kb_vec(vec0) virtual table. Mirrors the
 * extension load in VectorStore.init(). Read-only: opens with the same DB file
 * but never writes.
 */
function openReadConnWithVec(dbPath: string): DatabaseSync {
  // allowExtension is required to enableLoadExtension; the connection is only
  // used for SELECT COUNT(*) — no writes.
  const conn = new DatabaseSync(dbPath, { allowExtension: true });
  const sqliteVec = nodeRequire("sqlite-vec");
  conn.enableLoadExtension(true);
  sqliteVec.load(conn);
  return conn;
}

// ============================
// Main
// ============================

async function main(): Promise<void> {
  // ── Env preflight (do NOT print secret values) ──
  const required = ["TDAI_LLM_BASE_URL", "TDAI_LLM_API_KEY", "TDAI_LLM_MODEL", "OPENAI_API_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    process.stdout.write(`STOP: missing env vars: ${missing.join(", ")}\n`);
    process.exit(1);
  }

  process.stdout.write("=== KB MIGRATE (verification) ===\n");
  process.stdout.write(`scratch db: ${SCRATCH_DB}\n`);
  process.stdout.write(`source (READ-ONLY): ${DAYS.join(", ")} from ${LIVE_CONV_DIR}\n\n`);

  // ── Fresh slate: delete + recreate scratch dir ──
  if (fs.existsSync(SCRATCH_DIR)) {
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  // ── Store (dims=1536 REQUIRED → kb_vec vec0 created). init() loads sqlite-vec
  //    AND creates the KB schema (initKbSchema) — see sqlite.ts initSchema. ──
  const store = new VectorStore(SCRATCH_DB, DIMS, logger);
  const initResult = store.init({ provider: "openai", model: "text-embedding-3-small" });
  if (store.isDegraded()) {
    process.stdout.write(`STOP: store degraded after init: ${initResult.reason ?? "unknown"}\n`);
    process.exit(1);
  }
  if (!store.isKbReady()) {
    process.stdout.write("STOP: KB schema not ready (isKbReady=false) after init()\n");
    process.exit(1);
  }
  process.stdout.write("store: init OK, KB ready=true\n");

  // ── Embedding service (OpenAI, dims=1536). Chunk params mirror config.ts. ──
  const embeddingService = createEmbeddingService(
    {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY!,
      model: "text-embedding-3-small",
      dimensions: DIMS,
      maxInputChars: 8000,
      chunkSize: 2000, // config.ts default
      chunkOverlap: 200, // config.ts default
      maxChunksPerText: 50, // config.ts default
    },
    logger,
  );
  if (!embeddingService) {
    process.stdout.write("STOP: createEmbeddingService returned undefined\n");
    process.exit(1);
  }

  // ── LLM runner (Kimi/Moonshot, text-only) ──
  const llmRunner = new StandaloneLLMRunner({
    config: {
      baseUrl: process.env.TDAI_LLM_BASE_URL!,
      apiKey: process.env.TDAI_LLM_API_KEY!,
      model: process.env.TDAI_LLM_MODEL!,
      temperature: 1,
      maxTokens: 16000,
      timeoutMs: 180_000,
    },
    enableTools: false,
    logger,
  });

  // ── Build windows from the two days ──
  const allLines: L0Line[] = [];
  for (const day of DAYS) {
    const lines = readL0Day(day);
    process.stdout.write(`loaded ${lines.length} L0 lines from ${day}\n`);
    allLines.push(...lines);
  }
  const bySession = groupBySession(allLines);

  interface Window {
    sessionKey: string;
    sessionId: string;
    messages: ConversationMessage[];
  }
  const windows: Window[] = [];
  for (const [sessionKey, lines] of bySession) {
    const sessionId = lines[0]?.sessionId ?? "";
    for (const chunk of windowize(lines, WINDOW_SIZE)) {
      windows.push({
        sessionKey,
        sessionId,
        messages: chunk.map(toConvMessage),
      });
    }
  }

  process.stdout.write(
    `\nsessions=${bySession.size}, total messages=${allLines.length}, ` +
    `windows=${windows.length} (windowSize=${WINDOW_SIZE}) — NO cap/truncation applied\n\n`,
  );

  // ── Extract every window ──
  const totals = {
    entities: 0,
    facts: 0,
    events: 0,
    relations: 0,
    embedded: 0,
    okWindows: 0,
    failWindows: 0,
  };
  const failures: { idx: number; sessionKey: string; size: number }[] = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    process.stdout.write(
      `window ${i + 1}/${windows.length} [session=${w.sessionKey.slice(0, 12)} msgs=${w.messages.length}] ... `,
    );
    let res;
    try {
      res = await extractKbDelta({
        messages: w.messages,
        sessionKey: w.sessionKey,
        sessionId: w.sessionId,
        store,
        embeddingService,
        llmRunner,
        namespace: "default",
        logger: { ...logger, info: () => {}, warn: () => {} }, // quiet per-window apply log
      });
    } catch (err) {
      // extractKbDelta is fail-closed internally; an exception here is unexpected.
      process.stdout.write(`THREW: ${err instanceof Error ? err.message : String(err)}\n`);
      totals.failWindows++;
      failures.push({ idx: i + 1, sessionKey: w.sessionKey, size: w.messages.length });
      continue;
    }
    if (res.success) {
      totals.okWindows++;
      totals.entities += res.entitiesCount;
      totals.facts += res.factsCount;
      totals.events += res.eventsCount;
      totals.relations += res.relationsCount;
      totals.embedded += res.embeddedCount;
      process.stdout.write(
        `OK e=${res.entitiesCount} f=${res.factsCount} ev=${res.eventsCount} ` +
        `r=${res.relationsCount} emb=${res.embeddedCount}\n`,
      );
    } else {
      totals.failWindows++;
      failures.push({ idx: i + 1, sessionKey: w.sessionKey, size: w.messages.length });
      process.stdout.write("FAIL (success:false — cursor would hold; see [ERROR] above)\n");
    }
  }

  store.close?.();

  // ── Verify the persisted scratch DB with a SEPARATE read connection that has
  //    sqlite-vec loaded (required to query the kb_vec vec0 virtual table). ──
  const rdb = openReadConnWithVec(SCRATCH_DB);
  const totalEntities = countRows(rdb, "SELECT COUNT(*) AS c FROM entities");
  const headFacts = countRows(
    rdb,
    "SELECT COUNT(*) AS c FROM facts WHERE superseded_by IS NULL AND valid_to IS NULL",
  );
  const totalEvents = countRows(rdb, "SELECT COUNT(*) AS c FROM events");
  const totalRelations = countRows(rdb, "SELECT COUNT(*) AS c FROM relations");
  const kbVecRows = countRows(rdb, "SELECT COUNT(*) AS c FROM kb_vec");
  const kbFtsRows = countRows(rdb, "SELECT COUNT(*) AS c FROM kb_fts");

  const sampleRows = rdb
    .prepare(
      `SELECT e.name AS name, f.attribute AS attribute, f.value AS value
         FROM facts f JOIN entities e ON e.id = f.entity_id
        WHERE f.superseded_by IS NULL AND f.valid_to IS NULL
        ORDER BY f.valid_from DESC
        LIMIT 15`,
    )
    .all() as { name: string; attribute: string; value: string }[];
  rdb.close();

  // ── Report ──
  process.stdout.write("\n=== MIGRATION TOTALS (from extractKbDelta results) ===\n");
  process.stdout.write(`windows processed: ${windows.length}\n`);
  process.stdout.write(`  success: ${totals.okWindows}\n`);
  process.stdout.write(`  failure: ${totals.failWindows}\n`);
  process.stdout.write(
    `tallied: entities=${totals.entities} facts=${totals.facts} events=${totals.events} ` +
    `relations=${totals.relations} embedded=${totals.embedded}\n`,
  );

  process.stdout.write("\n=== SCRATCH DB STATE (read-only verification query) ===\n");
  process.stdout.write(`total entities:    ${totalEntities}\n`);
  process.stdout.write(`total HEAD facts:  ${headFacts}\n`);
  process.stdout.write(`total events:      ${totalEvents}\n`);
  process.stdout.write(`total relations:   ${totalRelations}\n`);
  process.stdout.write(`total kb_vec rows: ${kbVecRows}\n`);
  process.stdout.write(`total kb_fts rows: ${kbFtsRows}\n`);

  process.stdout.write("\n=== SAMPLE: 15 HEAD facts ===\n");
  if (sampleRows.length === 0) {
    process.stdout.write("(none)\n");
  } else {
    for (const r of sampleRows) {
      process.stdout.write(`  ${r.name} — ${r.attribute}: ${r.value}\n`);
    }
  }

  process.stdout.write("\n=== FAILED WINDOWS (success:false) ===\n");
  if (failures.length === 0) {
    process.stdout.write("(none)\n");
  } else {
    for (const f of failures) {
      process.stdout.write(`  window ${f.idx} session=${f.sessionKey.slice(0, 16)} size=${f.size}\n`);
    }
  }

  process.stdout.write("\nNO cap/truncation was applied to the data set (all windows processed).\n");
  process.stdout.write("DONE.\n");
}

main().catch((err) => {
  process.stdout.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
