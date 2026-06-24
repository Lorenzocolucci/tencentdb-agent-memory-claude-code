/**
 * kb-backfill-live.mts — ONE-TIME historical backfill of the LIVE KB.
 *
 * Reads ALL L0 conversation days (READ-ONLY) and writes entities/facts/events
 * into the LIVE vectors.db kb_* tables via the real entity-centric write path
 * (extractKbDelta → parseKbDelta → applyKbDelta). ADDITIVE ONLY: it opens the
 * existing live DB and INSERTs into kb_* — it NEVER deletes/recreates anything
 * and never touches l0_/l1_ tables. Idempotent (deterministic ids + supersession).
 *
 * PRECONDITION: the gateway MUST be stopped (exclusive DB access). The script
 * refuses to run if port 8421 is listening.
 *
 * Run: node_modules/.bin/tsx tools/kb-backfill-live.mts
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);

import { VectorStore } from "../src/core/store/sqlite.js";
import { createEmbeddingService } from "../src/core/store/embedding.js";
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";
import { extractKbDelta } from "../src/core/kb/kb-extractor.js";
import type { ConversationMessage } from "../src/core/conversation/l0-recorder.js";
import type { Logger } from "../src/core/types.js";

const LIVE_DATA_DIR = "C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local";
const LIVE_DB = path.join(LIVE_DATA_DIR, "vectors.db");
const LIVE_CONV_DIR = path.join(LIVE_DATA_DIR, "conversations");
const WINDOW_SIZE = 10;
const DIMS = 1536;
const GATEWAY_PORT = 8421;

interface L0Line {
  sessionKey: string;
  sessionId: string;
  recordedAt: string;
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (m: string) => process.stdout.write(`  [warn] ${m}\n`),
  error: (m: string) => process.stdout.write(`  [ERROR] ${m}\n`),
};

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(1500, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function readL0Day(file: string): L0Line[] {
  const raw = fs.readFileSync(path.join(LIVE_CONV_DIR, file), "utf8"); // READ-ONLY
  const out: L0Line[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as L0Line;
      if (typeof o.sessionKey === "string" && typeof o.content === "string") out.push(o);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function toConvMessage(l: L0Line): ConversationMessage {
  return { id: l.id, role: l.role, content: l.content, timestamp: l.timestamp };
}

function windowize<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function countRows(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { c: number } | undefined;
  return row ? Number(row.c) : 0;
}

function openReadConnWithVec(dbPath: string): DatabaseSync {
  const conn = new DatabaseSync(dbPath, { allowExtension: true });
  const sqliteVec = nodeRequire("sqlite-vec");
  conn.enableLoadExtension(true);
  sqliteVec.load(conn);
  return conn;
}

async function main(): Promise<void> {
  const required = ["TDAI_LLM_BASE_URL", "TDAI_LLM_API_KEY", "TDAI_LLM_MODEL", "OPENAI_API_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    process.stdout.write(`STOP: missing env vars: ${missing.join(", ")}\n`);
    process.exit(1);
  }

  // ── Safety: refuse to run if the gateway is up (would contend on the live DB) ──
  if (await portListening(GATEWAY_PORT)) {
    process.stdout.write(
      `STOP: gateway is LISTENING on ${GATEWAY_PORT}. Stop it first (stop-gateway.ps1) for exclusive DB access.\n`,
    );
    process.exit(1);
  }

  process.stdout.write("=== KB BACKFILL (LIVE, additive) ===\n");
  process.stdout.write(`live db: ${LIVE_DB}\n`);

  // ── All conversation days, ascending (chronological for natural supersession) ──
  const days = fs
    .readdirSync(LIVE_CONV_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  process.stdout.write(`days: ${days.length} (${days[0]} … ${days[days.length - 1]})\n\n`);

  // ── Open the LIVE store. init() loads sqlite-vec + creates kb_* IF NOT EXISTS
  //    (already created by the gateway boot). ADDITIVE — no delete. ──
  const store = new VectorStore(LIVE_DB, DIMS, logger);
  const initResult = store.init({ provider: "openai", model: "text-embedding-3-small" });
  if (store.isDegraded()) {
    process.stdout.write(`STOP: store degraded after init: ${initResult.reason ?? "unknown"}\n`);
    process.exit(1);
  }
  if (!store.isKbReady()) {
    process.stdout.write("STOP: KB schema not ready (isKbReady=false)\n");
    process.exit(1);
  }
  process.stdout.write("store: init OK, KB ready=true\n");

  // ── RESUME support: events use a non-deterministic ulid id, so re-applying a
  //    window DUPLICATES its events. To make the backfill idempotent/resumable,
  //    load the source_message_ids of every event already written and SKIP any
  //    window whose messages are already represented. A separate read connection
  //    (events is a normal table — no vec extension needed). ──
  const processedMsgIds = new Set<string>();
  {
    const rconn = new DatabaseSync(LIVE_DB, { readOnly: true });
    const rows = rconn.prepare("SELECT source_message_ids_json AS j FROM events").all() as { j: string }[];
    for (const r of rows) {
      try {
        for (const id of JSON.parse(r.j) as string[]) processedMsgIds.add(id);
      } catch {
        /* skip malformed */
      }
    }
    rconn.close();
  }
  process.stdout.write(`resume: ${processedMsgIds.size} source message id(s) already in events\n`);

  const embeddingService = createEmbeddingService(
    {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY!,
      model: "text-embedding-3-small",
      dimensions: DIMS,
      maxInputChars: 8000,
      chunkSize: 2000,
      chunkOverlap: 200,
      maxChunksPerText: 50,
    },
    logger,
  );
  if (!embeddingService) {
    process.stdout.write("STOP: createEmbeddingService returned undefined\n");
    process.exit(1);
  }

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

  // ── Build windows: per day (ascending) → per session → time-ordered chunks ──
  interface Window {
    sessionKey: string;
    sessionId: string;
    messages: ConversationMessage[];
  }
  const windows: Window[] = [];
  let totalMessages = 0;
  for (const day of days) {
    const lines = readL0Day(day);
    totalMessages += lines.length;
    const bySession = new Map<string, L0Line[]>();
    for (const l of lines) {
      const arr = bySession.get(l.sessionKey);
      if (arr) arr.push(l);
      else bySession.set(l.sessionKey, [l]);
    }
    for (const arr of bySession.values()) {
      arr.sort((a, b) => a.timestamp - b.timestamp);
      const sessionId = arr[0]?.sessionId ?? "";
      const sessionKey = arr[0]?.sessionKey ?? "";
      for (const chunk of windowize(arr, WINDOW_SIZE)) {
        windows.push({ sessionKey, sessionId, messages: chunk.map(toConvMessage) });
      }
    }
  }
  process.stdout.write(
    `total messages=${totalMessages}, windows=${windows.length} (windowSize=${WINDOW_SIZE})\n\n`,
  );

  const totals = { entities: 0, facts: 0, events: 0, relations: 0, embedded: 0, ok: 0, fail: 0, skipped: 0 };
  const t0 = Date.now();
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    // RESUME: skip windows already represented in events (any message id present).
    if (w.messages.some((m) => processedMsgIds.has(m.id))) {
      totals.skipped++;
      continue;
    }
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
        logger: { ...logger, info: () => {}, warn: () => {} },
      });
    } catch (err) {
      totals.fail++;
      process.stdout.write(
        `window ${i + 1}/${windows.length} [${w.sessionKey.slice(0, 12)}] THREW: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    if (res.success) {
      totals.ok++;
      totals.entities += res.entitiesCount;
      totals.facts += res.factsCount;
      totals.events += res.eventsCount;
      totals.relations += res.relationsCount;
      totals.embedded += res.embeddedCount;
      if (res.factsCount + res.eventsCount > 0) {
        process.stdout.write(
          `window ${i + 1}/${windows.length} [${w.sessionKey.slice(0, 12)}] OK ` +
          `e=${res.entitiesCount} f=${res.factsCount} ev=${res.eventsCount} emb=${res.embeddedCount}\n`,
        );
      }
    } else {
      totals.fail++;
      process.stdout.write(`window ${i + 1}/${windows.length} [${w.sessionKey.slice(0, 12)}] FAIL (cursor-hold)\n`);
    }
  }
  store.close?.();
  const elapsed = Math.round((Date.now() - t0) / 1000);

  // ── Verify the LIVE DB kb_* state (read-only) ──
  const rdb = openReadConnWithVec(LIVE_DB);
  const ent = countRows(rdb, "SELECT COUNT(*) AS c FROM entities");
  const headFacts = countRows(rdb, "SELECT COUNT(*) AS c FROM facts WHERE superseded_by IS NULL AND valid_to IS NULL");
  const ev = countRows(rdb, "SELECT COUNT(*) AS c FROM events");
  const rel = countRows(rdb, "SELECT COUNT(*) AS c FROM relations");
  const kbVec = countRows(rdb, "SELECT COUNT(*) AS c FROM kb_vec");
  const kbFts = countRows(rdb, "SELECT COUNT(*) AS c FROM kb_fts");
  // sanity: confirm l1 untouched
  const l1 = (() => {
    try {
      return countRows(rdb, "SELECT COUNT(*) AS c FROM l1_records");
    } catch {
      return -1;
    }
  })();
  rdb.close();

  process.stdout.write(`\n=== BACKFILL DONE (${elapsed}s) ===\n`);
  process.stdout.write(`windows: ${windows.length} | ok=${totals.ok} fail=${totals.fail} skipped(resume)=${totals.skipped}\n`);
  process.stdout.write(
    `tallied: entities=${totals.entities} facts=${totals.facts} events=${totals.events} relations=${totals.relations} embedded=${totals.embedded}\n`,
  );
  process.stdout.write("\n=== LIVE DB kb_* STATE ===\n");
  process.stdout.write(`entities=${ent} headFacts=${headFacts} events=${ev} relations=${rel} kb_vec=${kbVec} kb_fts=${kbFts}\n`);
  process.stdout.write(`(sanity) l1_records rows (must be unchanged, >0): ${l1}\n`);
  process.stdout.write("DONE.\n");
}

main().catch((err) => {
  process.stdout.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
