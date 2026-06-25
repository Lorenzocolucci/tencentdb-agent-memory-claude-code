/**
 * backfill-chat-export — CLI to ingest a claude.ai chat export into Sinapsys memory.
 *
 * SINGLE WRITER WARNING:
 *   The live gateway holds vectors.db open (WAL mode). Running this tool while the
 *   gateway is running WILL cause SQLITE_BUSY errors and partial writes.
 *   YOU MUST STOP THE GATEWAY before running this tool in real mode.
 *   Stop command: node dist/src/gateway/cli.mjs stop
 *   Or kill the process: taskkill /F /PID <gateway-pid>  (Windows)
 *
 * MODES:
 *   DRY-RUN (default, --dry-run flag):
 *     Processes the FIRST 1 conversation only. Prints field names, counts,
 *     redaction stats, and embedding dimensions WITHOUT writing to vectors.db.
 *     Uses a throwaway temp DB to verify the store can be opened.
 *
 *   REAL (--real flag):
 *     Streams ALL conversations. Writes to vectors.db. Requires gateway STOPPED.
 *     Idempotent: re-running skips already-ingested message UUIDs (ledger.db).
 *
 * USAGE:
 *   # Dry-run (safe, default):
 *   node --experimental-sqlite dist/src/cli/backfill/backfill-chat-export.mjs \
 *     --export /path/to/conversations.json \
 *     --data-dir ~/.memory-tencentdb/memory-tdai
 *
 *   # Real ingestion (gateway must be STOPPED):
 *   node --experimental-sqlite dist/src/cli/backfill/backfill-chat-export.mjs \
 *     --export /path/to/conversations.json \
 *     --data-dir ~/.memory-tencentdb/memory-tdai \
 *     --real
 *
 *   # Or via tsx (no build needed, for development):
 *   npx tsx src/cli/backfill/backfill-chat-export.ts --export ... --data-dir ... [--real]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../core/store/sqlite.js";
import { streamConversations, isConversationEmpty } from "./chat-export-streamer.js";
import { ImportLedger } from "./import-ledger.js";
import { ingestConversation, type IngestStats } from "./message-ingestor.js";

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(): {
  exportPath: string;
  dataDir: string;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);

  const exportIdx = args.indexOf("--export");
  const dataDirIdx = args.indexOf("--data-dir");
  const isReal = args.includes("--real");

  if (exportIdx === -1 || !args[exportIdx + 1]) {
    fatal("Missing required argument: --export <path-to-conversations.json>");
  }
  if (dataDirIdx === -1 || !args[dataDirIdx + 1]) {
    fatal("Missing required argument: --data-dir <memory-tdai-data-directory>");
  }

  return {
    exportPath: args[exportIdx + 1]!,
    dataDir: args[dataDirIdx + 1]!,
    dryRun: !isReal,
  };
}

function fatal(msg: string): never {
  process.stderr.write(`[backfill] ERROR: ${msg}\n`);
  process.exit(1);
}

// ── Gateway lock check ────────────────────────────────────────────────────────

/**
 * Best-effort check: if the WAL-SHM file exists and is actively held open,
 * we WARN (can't reliably detect open file handles on all OSes without lsof).
 * The real guard is the SQLite busy_timeout: if another process holds a write
 * lock we'll get SQLITE_BUSY on the first transaction.
 */
function warnIfGatewayMayBeRunning(dataDir: string): void {
  const walPath = path.join(dataDir, "vectors.db-wal");
  const shmPath = path.join(dataDir, "vectors.db-shm");
  if (fs.existsSync(walPath) || fs.existsSync(shmPath)) {
    process.stderr.write(
      "[backfill] WARNING: vectors.db WAL/SHM files found — the gateway may be running.\n" +
      "[backfill] Stop the gateway before running in --real mode to avoid SQLITE_BUSY errors.\n",
    );
  }
}

// ── Stats aggregation ─────────────────────────────────────────────────────────

function addStats(acc: IngestStats, s: IngestStats): IngestStats {
  return {
    messagesTotal: acc.messagesTotal + s.messagesTotal,
    messagesSkippedDuplicate: acc.messagesSkippedDuplicate + s.messagesSkippedDuplicate,
    messagesSkippedEmpty: acc.messagesSkippedEmpty + s.messagesSkippedEmpty,
    messagesIngested: acc.messagesIngested + s.messagesIngested,
    messagesFailed: acc.messagesFailed + s.messagesFailed,
    redactionApplied: acc.redactionApplied + s.redactionApplied,
    embeddingDims: s.embeddingDims,
  };
}

function zeroStats(): IngestStats {
  return {
    messagesTotal: 0,
    messagesSkippedDuplicate: 0,
    messagesSkippedEmpty: 0,
    messagesIngested: 0,
    messagesFailed: 0,
    redactionApplied: 0,
    embeddingDims: 0,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { exportPath, dataDir, dryRun } = parseArgs();

  // Validate export file
  if (!fs.existsSync(exportPath)) {
    fatal(`Export file not found: ${exportPath}`);
  }
  const exportSize = fs.statSync(exportPath).size;

  // Validate data dir
  if (!fs.existsSync(dataDir)) {
    fatal(`Data directory not found: ${dataDir}`);
  }

  const vectorsDbPath = path.join(dataDir, "vectors.db");

  process.stdout.write(
    `[backfill] Mode:      ${dryRun ? "DRY-RUN (first 3 non-empty conversations, no writes)" : "REAL (all conversations, writes to vectors.db)"}\n` +
    `[backfill] Export:    ${exportPath} (${(exportSize / 1024 / 1024).toFixed(1)} MB)\n` +
    `[backfill] Data dir:  ${dataDir}\n` +
    `[backfill] DB path:   ${dryRun ? "(temp DB — path printed after store opens)" : vectorsDbPath}\n`,
  );

  if (!dryRun) {
    warnIfGatewayMayBeRunning(dataDir);
  }

  // ── Open store ──────────────────────────────────────────────────────────────
  // Dry-run: use a throwaway temp DB so vectors.db is never touched.
  // Real: open the live vectors.db.
  const dimensions = 0; // no embedding service in this CLI (see note below)
  let dbPath: string;
  let tmpDir: string | undefined;

  if (dryRun) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-backfill-dry-"));
    dbPath = path.join(tmpDir, "vectors-dry.db");
  } else {
    dbPath = vectorsDbPath;
  }

  const store = new VectorStore(dbPath, dimensions);
  const initResult = store.init();

  if (store.isDegraded()) {
    fatal("VectorStore entered degraded mode — cannot proceed.");
  }

  process.stdout.write(
    `[backfill] Store:     opened at ${dbPath} (degraded=${store.isDegraded()}, needsReindex=${initResult.needsReindex})\n`,
  );

  // ── Open ledger ─────────────────────────────────────────────────────────────
  const ledgerPath = dryRun
    ? path.join(tmpDir!, "ledger-dry.db")
    : path.join(dataDir, "backfill-ledger.db");

  const ledger = new ImportLedger(ledgerPath);

  // ── Stream and ingest ────────────────────────────────────────────────────────
  const startTime = Date.now();
  let conversationsProcessed = 0;
  let totals = zeroStats();

  // Dry-run: sample the first DRY_RUN_SAMPLE_SIZE non-empty conversations
  const DRY_RUN_SAMPLE_SIZE = 3;
  let dryRunSampled = 0;
  let dryRunSkippedEmpty = 0;

  try {
    for await (const conv of streamConversations(exportPath)) {
      // Dry-run: skip fully-empty conversations so the preview is meaningful
      if (dryRun) {
        if (isConversationEmpty(conv)) {
          dryRunSkippedEmpty++;
          continue;
        }
      }

      const stats = await ingestConversation(conv, {
        store,
        ledger,
        embeddingService: undefined, // NOTE: embedding requires a running API key;
        // omitted here. Run `tdai-memory-reindex` after the backfill to generate
        // embeddings from the FTS-indexed content. The store's updateL0Embedding
        // path is exercised fully when reindexAll() is called.
        dryRun,
      });

      totals = addStats(totals, stats);
      conversationsProcessed++;

      // Dry-run: print each sampled conversation and stop after DRY_RUN_SAMPLE_SIZE
      if (dryRun) {
        dryRunSampled++;
        process.stdout.write(
          `\n[backfill] DRY-RUN sample ${dryRunSampled}/${DRY_RUN_SAMPLE_SIZE} — conversation ${conv.uuid}:\n` +
          `  Field names present:   uuid, name, created_at, chat_messages[{uuid,sender,text,created_at,content[]}]\n` +
          `  Messages found:        ${stats.messagesTotal}\n` +
          `  Would ingest:          ${stats.messagesIngested}\n` +
          `  Skipped (empty body):  ${stats.messagesSkippedEmpty}\n` +
          `  Redaction applied:     ${stats.redactionApplied} message(s) had secrets scrubbed\n` +
          `  Embedding dims:        ${stats.embeddingDims} (0 = no embedding, FTS-only; run reindex after)\n` +
          `  L0 record id prefix:   l0_chatimport_<sha1(conv-uuid|msg-uuid)[:12]>\n` +
          `  session_key pattern:   chatimport_<conversation-uuid>\n`,
        );
        if (dryRunSampled >= DRY_RUN_SAMPLE_SIZE) {
          process.stdout.write(
            `\n[backfill] DRY-RUN note: skipped ${dryRunSkippedEmpty} fully-empty conversation(s) before finding ${dryRunSampled} non-empty sample(s).\n`,
          );
          break;
        }
        continue;
      }

      // Real mode: progress every 50 conversations
      if (conversationsProcessed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.write(
          `[backfill] Progress: ${conversationsProcessed} conversations | ` +
          `${totals.messagesIngested} ingested | ` +
          `${totals.messagesSkippedDuplicate} skipped (dup) | ` +
          `${totals.messagesSkippedEmpty} skipped (empty) | ` +
          `${totals.messagesFailed} failed | ${elapsed}s\n`,
        );
      }
    }
  } finally {
    store.close();
    ledger.close();

    // Clean up throwaway temp dir
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  process.stdout.write(
    `\n[backfill] DONE (${elapsed}s)\n` +
    `  Conversations:           ${conversationsProcessed}\n` +
    `  Messages total:          ${totals.messagesTotal}\n` +
    `  Ingested:                ${totals.messagesIngested}\n` +
    `  Skipped (duplicate):     ${totals.messagesSkippedDuplicate}\n` +
    `  Skipped (empty body):    ${totals.messagesSkippedEmpty}\n` +
    `  Failed (non-fatal):      ${totals.messagesFailed}\n` +
    `  Redaction applied:       ${totals.redactionApplied} messages had secrets scrubbed\n`,
  );

  if (dryRun) {
    process.stdout.write(
      "\n[backfill] This was a DRY-RUN. To run real ingestion:\n" +
      "  1. Stop the gateway (gateway must NOT be running)\n" +
      `  2. Re-run with --real flag\n` +
      "  3. After ingestion, run `tdai-memory-reindex` to generate embeddings\n",
    );
  } else {
    process.stdout.write(
      "\n[backfill] Next step: run `tdai-memory-reindex` to generate vector embeddings\n" +
      "  for the FTS-indexed content (requires embedding API key in gateway config).\n",
    );
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch((err) => {
  process.stderr.write(
    `[backfill] FATAL: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
