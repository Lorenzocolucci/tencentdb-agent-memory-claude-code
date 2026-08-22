/**
 * Remove exact duplicate L0 rows created by a failed recovery run.
 *
 * WHY
 * ---
 * On 2026-08-22 the first `recover-sessions` run had a chunk time out
 * CLIENT-side after the gateway had already written it. The tool, correctly
 * refusing to lose data, did not advance the cursor — and the re-run wrote the
 * same 49 rows a second time. Duplicates are not harmless here: repetition is
 * the signal the consolidation boost ranks on, so a duplicate reads as
 * "this recurred" and quietly inflates a memory's importance.
 *
 * SAFETY
 * ------
 * - dry-run by default; `--commit` is required;
 * - every row it will remove is exported to a JSON file FIRST, so the deletion
 *   is reversible without touching a 2.7 GB backup;
 * - keeps the EARLIEST row of each duplicate group (the original), removes the
 *   later copies;
 * - deletes through the store's own `deleteL0`, which drops the row from
 *   l0_conversations, l0_vec and l0_fts in one transaction — a hand-written
 *   DELETE would leave the search index pointing at rows that no longer exist;
 * - refuses to run while the gateway holds the database (SQLite is
 *   single-writer): stop it first.
 *
 * USAGE
 *   npx tsx tools/dedupe-l0.mts --since 2026-08-22T17:10        # dry-run
 *   npx tsx tools/dedupe-l0.mts --since 2026-08-22T17:10 --commit
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../src/core/store/sqlite.js";

const DB_DIR = join(
  process.env.USERPROFILE ?? "",
  ".claude",
  "plugins",
  "data",
  "tdai-memory-tdai-local",
);
const DB_PATH = join(DB_DIR, "vectors.db");
const DIMENSIONS = 1024;

interface Row {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
}

function parseArgs(argv: string[]) {
  const commit = argv.includes("--commit");
  const i = argv.indexOf("--since");
  const since = i >= 0 ? argv[i + 1] : "";
  if (!since) throw new Error("serve --since <ISO> per limitare la finestra");
  return { commit, since };
}

/** Refuse to write while the gateway owns the database. */
function assertGatewayStopped(): void {
  const statePath = join(DB_DIR, "state.json");
  if (!existsSync(statePath)) return;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { pid?: number };
    const pid = state.pid;
    if (!pid || pid <= 0) return;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") return; // dead → fine
    }
    throw new Error(
      `il gateway è ancora attivo (pid ${pid}). Fermalo prima:\n` +
        `  powershell -File C:\\Users\\lo\\tdai-gateway\\stop-gateway.ps1`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("il gateway")) throw err;
  }
}

/** Later copies of rows identical in (session_key, role, message_text). */
function findDuplicates(since: string): Row[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp
           FROM l0_conversations
          WHERE recorded_at > ?
          ORDER BY recorded_at ASC, rowid ASC`,
      )
      .all(since) as unknown as Row[];

    const seen = new Set<string>();
    const doomed: Row[] = [];
    for (const r of rows) {
      const key = `${r.session_key}\u0000${r.role}\u0000${r.message_text}`;
      if (seen.has(key)) doomed.push(r);
      else seen.add(key);
    }
    return doomed;
  } finally {
    db.close();
  }
}

function main(): void {
  const { commit, since } = parseArgs(process.argv.slice(2));
  console.log(`Database: ${DB_PATH}`);
  console.log(`Finestra: recorded_at > ${since}`);
  console.log(`Modalità: ${commit ? "SCRITTURA (--commit)" : "PROVA A VUOTO (dry-run)"}\n`);

  const doomed = findDuplicates(since);
  console.log(`Righe duplicate da rimuovere: ${doomed.length}`);
  if (doomed.length === 0) return;

  const byKey = new Map<string, number>();
  for (const r of doomed) byKey.set(r.session_key, (byKey.get(r.session_key) ?? 0) + 1);
  for (const [k, n] of byKey) console.log(`   ${k}: ${n}`);

  const exportPath = join(DB_DIR, `l0-dedupe-removed-${since.replace(/[^0-9]/g, "")}.json`);
  writeFileSync(exportPath, JSON.stringify(doomed, null, 1), { mode: 0o600 });
  console.log(`\nCopia di sicurezza delle righe: ${exportPath}`);

  if (!commit) {
    console.log("\nProva a vuoto. Rilancia con --commit per rimuoverle davvero.");
    return;
  }

  assertGatewayStopped();

  // Pass a logger: without one the store swallows the reason a delete failed,
  // which is the exact silence this whole session is about.
  const store = new VectorStore(DB_PATH, DIMENSIONS, {
    debug: () => {},
    info: (m: string) => console.log(`  [store] ${m}`),
    warn: (m: string) => console.log(`  [store][WARN] ${m}`),
    error: (m: string) => console.log(`  [store][ERR] ${m}`),
  } as never);
  // init() loads sqlite-vec and prepares the statements. WITHOUT it every
  // deleteL0 fails with "Cannot read properties of undefined (reading 'run')"
  // and — being fault-tolerant — reports false instead of throwing. No
  // providerInfo is passed, so the vector tables are never dropped/recreated.
  const initResult = store.init();
  if (store.isDegraded()) {
    throw new Error(`store degradato, non tocco nulla: ${initResult.reason ?? "motivo ignoto"}`);
  }

  let removed = 0;
  let failed = 0;
  try {
    for (const r of doomed) {
      if (store.deleteL0(r.record_id)) removed++;
      else failed++;
    }
  } finally {
    store.close?.();
  }
  console.log(`\nRimosse: ${removed}   fallite: ${failed}`);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const left = findDuplicatesCount(db, since);
    console.log(`Duplicati residui nella finestra: ${left}`);
  } finally {
    db.close();
  }
}

function findDuplicatesCount(db: DatabaseSync, since: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) - COUNT(DISTINCT session_key || char(0) || role || char(0) || message_text) AS dup
         FROM l0_conversations WHERE recorded_at > ?`,
    )
    .get(since) as { dup: number };
  return row?.dup ?? 0;
}

main();
