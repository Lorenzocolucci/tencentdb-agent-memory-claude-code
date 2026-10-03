/**
 * One-time backfill of the recall hot-path indexes (Sinapsys fix plan 2.1 + 2.2):
 *   - entities_fts   (whole-word entity lookup, replaces the per-recall full scan)
 *   - event_entities (event <-> entity join, replaces the LIKE '%id%' scans)
 *
 * PRECONDITION for --commit: the gateway is STOPPED (exclusive access).
 *
 * WHAT IT WRITES (and nothing else)
 *   - CREATE of: entities_fts, event_entities, kb_index_state, and six sync TRIGGERS
 *     (trg_kb_entities_fts_{ai,au,ad} on `entities`, trg_kb_event_entities_{ai,au,ad}
 *     on `events`). CREATE TRIGGER changes the schema of the existing tables but never
 *     touches their rows.
 *   - INSERT into entities_fts / event_entities / kb_index_state.
 *   It never UPDATEs or DELETEs a row of an existing table.
 *
 * IDEMPOTENT + RESUMABLE: batches are committed one by one with a cursor stored in
 * kb_index_state; re-running continues where it stopped, and a finished run is a no-op.
 *
 * USAGE
 *   npx tsx tools/kb-index-backfill.mts                       # --dry-run (default)
 *   npx tsx tools/kb-index-backfill.mts --commit              # writes
 *   npx tsx tools/kb-index-backfill.mts --db <path> [--commit]
 *   (default DB: $TDAI_DB_PATH or %USERPROFILE%\.claude\plugins\data\tdai-memory-tdai-local\vectors.db)
 *
 * ROLLBACK (printed again at the end of every run) — drops only objects this tool creates:
 *   DROP TRIGGER IF EXISTS trg_kb_entities_fts_ai; ... (all six) ...
 *   DROP TABLE IF EXISTS entities_fts; DROP TABLE IF EXISTS event_entities;
 *   DROP TABLE IF EXISTS kb_index_state;
 * After a rollback the code falls back to the legacy scans automatically (no ready flag).
 */

import net from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureKbIndexSchema, runKbIndexBackfill } from "../src/core/kb/kb-index.js";

const DEFAULT_DB = join(
  process.env.USERPROFILE ?? "",
  ".claude", "plugins", "data", "tdai-memory-tdai-local", "vectors.db",
);

const ROLLBACK_SQL = [
  "DROP TRIGGER IF EXISTS trg_kb_entities_fts_ai;",
  "DROP TRIGGER IF EXISTS trg_kb_entities_fts_au;",
  "DROP TRIGGER IF EXISTS trg_kb_entities_fts_ad;",
  "DROP TRIGGER IF EXISTS trg_kb_event_entities_ai;",
  "DROP TRIGGER IF EXISTS trg_kb_event_entities_au;",
  "DROP TRIGGER IF EXISTS trg_kb_event_entities_ad;",
  "DROP TABLE IF EXISTS entities_fts;",
  "DROP TABLE IF EXISTS event_entities;",
  "DROP TABLE IF EXISTS kb_index_state;",
];

interface Args {
  commit: boolean;
  db: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { commit: false, db: process.env.TDAI_DB_PATH ?? DEFAULT_DB };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--commit") args.commit = true;
    else if (a === "--dry-run") args.commit = false;
    else if (a === "--db") args.db = argv[++i] ?? args.db;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function portUp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = ?").get(name);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/** Exact number of (event_id, entity_id) rows the backfill will end with. */
function countExpectedEventEntities(db: DatabaseSync): number {
  let total = 0;
  for (const row of db.prepare("SELECT entities_json FROM events").iterate() as IterableIterator<{ entities_json: string }>) {
    try {
      const parsed: unknown = JSON.parse(row.entities_json);
      if (Array.isArray(parsed)) total += new Set(parsed.filter((e): e is string => typeof e === "string")).size;
    } catch { /* malformed json contributes nothing, same as the backfill */ }
  }
  return total;
}

function report(db: DatabaseSync): { expectedFts: number; expectedEe: number } {
  const entities = scalar(db, "SELECT COUNT(*) AS n FROM entities");
  const merged = hasColumn(db, "entities", "merged_into")
    ? scalar(db, "SELECT COUNT(*) AS n FROM entities WHERE merged_into IS NOT NULL")
    : 0;
  const events = scalar(db, "SELECT COUNT(*) AS n FROM events");
  const expectedFts = entities - merged;
  const expectedEe = countExpectedEventEntities(db);
  console.log("Current source tables:");
  console.log(`  entities: ${entities} (merged-away: ${merged})   events: ${events}`);
  console.log("Rows the backfill will write:");
  console.log(`  entities_fts   : ${expectedFts}  (non-merged entities)`);
  console.log(`  event_entities : ${expectedEe}  (distinct event/entity pairs)`);
  const haveFts = tableExists(db, "entities_fts") ? scalar(db, "SELECT COUNT(*) AS n FROM entities_fts") : null;
  const haveEe = tableExists(db, "event_entities") ? scalar(db, "SELECT COUNT(*) AS n FROM event_entities") : null;
  console.log("Already present:");
  console.log(`  entities_fts   : ${haveFts ?? "table absent"}`);
  console.log(`  event_entities : ${haveEe ?? "table absent"}`);
  if (tableExists(db, "kb_index_state")) {
    const st = db.prepare("SELECT name, value FROM kb_index_state ORDER BY name").all() as Array<{ name: string; value: string }>;
    console.log(`  kb_index_state : ${st.map((r) => `${r.name}=${r.value}`).join(", ") || "(empty)"}`);
  } else {
    console.log("  kb_index_state : table absent");
  }
  return { expectedFts, expectedEe };
}

function printRollback(): void {
  console.log("\nROLLBACK (run in sqlite3 against the same DB, gateway stopped):");
  for (const line of ROLLBACK_SQL) console.log(`  ${line}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`DB: ${args.db}`);
  console.log(`Mode: ${args.commit ? "COMMIT (writes)" : "DRY-RUN (read-only)"}\n`);

  if (!args.commit) {
    const db = new DatabaseSync(args.db, { readOnly: true });
    report(db);
    db.close();
    console.log("\nDry-run only: nothing was written. Re-run with --commit (gateway stopped) to apply.");
    printRollback();
    return;
  }

  // The gateway guard applies to the LIVE database only (a --db copy can be written freely).
  const isLive = resolve(args.db).toLowerCase() === resolve(DEFAULT_DB).toLowerCase();
  if (isLive && (await portUp(8421))) {
    console.log("STOP: the gateway is up on 127.0.0.1:8421. Stop it first (exclusive access needed).");
    process.exitCode = 2;
    return;
  }
  const db = new DatabaseSync(args.db);
  db.prepare("PRAGMA busy_timeout = 5000").run();
  try {
    const { expectedFts, expectedEe } = report(db);
    console.log("\nCreating tables/triggers (idempotent)...");
    ensureKbIndexSchema(db);
    let lastLog = 0;
    const t0 = Date.now();
    const result = await runKbIndexBackfill(db, {
      logger: { info: (m) => console.log(m) },
      yieldFn: async () => {
        if (Date.now() - lastLog > 5000) {
          lastLog = Date.now();
          const fts = scalar(db, "SELECT COUNT(*) AS n FROM entities_fts");
          const ee = scalar(db, "SELECT COUNT(*) AS n FROM event_entities");
          console.log(`  ... entities_fts=${fts}/${expectedFts} event_entities=${ee}/${expectedEe} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    });
    const gotFts = scalar(db, "SELECT COUNT(*) AS n FROM entities_fts");
    const gotEe = scalar(db, "SELECT COUNT(*) AS n FROM event_entities");
    console.log("\nRESULT");
    console.log(`  done=${result.done}  batches=${result.batches}  longest batch=${result.maxBatchMs.toFixed(0)}ms (work ${result.maxWorkMs.toFixed(0)}ms, commit ${result.maxCommitMs.toFixed(0)}ms)`);
    console.log(`  entities_fts   : ${gotFts} (expected ${expectedFts})  ${gotFts === expectedFts ? "OK" : "MISMATCH"}`);
    console.log(`  event_entities : ${gotEe} (expected ${expectedEe})  ${gotEe === expectedEe ? "OK" : "MISMATCH"}`);
    if (!result.done || gotFts !== expectedFts || gotEe !== expectedEe) {
      console.log("\nNOT OK: counts do not match. Do not restart the gateway on this state; run the ROLLBACK below or re-run this tool.");
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
  printRollback();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
