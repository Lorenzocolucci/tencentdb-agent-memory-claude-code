/**
 * vec-compact.mts — migrate kb_vec / l0_vec from the partition-key vec0 layout to the
 * compact layout (plan item 6.2). See src/core/store/vec-compact*.ts for the why.
 *
 *   npx tsx tools/vec-compact.mts [--db <path>]                      dry-run (default, read-only)
 *   npx tsx tools/vec-compact.mts --commit --db <path>               build + verify + swap
 *   npx tsx tools/vec-compact.mts --rollback --db <path> --suffix S  put the legacy tables back
 *   npx tsx tools/vec-compact.mts --cleanup --db <path> --suffix S   DROP parked legacy tables + VACUUM
 *
 * Options: --suffix YYYYMMDD (default today)  --sample 500  --batch 1000
 *          --knn-check N (compare top-10 of N random queries old vs new, slow on big tables)
 *          --pages (exact dbstat bytes in the dry-run; reads the whole file)
 *          --reset-staging (drop a half-built `<t>_new` before building)
 *          --tables kb_vec,l0_vec
 *
 * --commit / --rollback / --cleanup refuse to run while the gateway answers on 127.0.0.1:8421
 * and require an explicit --db. Old tables are NEVER dropped by --commit.
 * Run with: node --max-old-space-size=3072 --import tsx tools/vec-compact.mts ...
 */
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  VEC_SPECS,
  isLegacyVecSql,
  tableExists,
  vecDims,
  vecTableSql,
  type VecTableSpec,
} from "../src/core/store/vec-compact.js";
import {
  buildStaging,
  cleanupTable,
  compactBackupName,
  dropStaging,
  knnEquivalence,
  oldName,
  rollbackTable,
  swapTable,
  tableStats,
  verifyTables,
  type TableStats,
} from "../src/core/store/vec-compact-migrate.js";

const req = createRequire(import.meta.url);
const LIVE_DEFAULT = "C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local/vectors.db";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const out = (m: string): void => void process.stdout.write(`${m}\n`);

function today(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function portUp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(1200, () => { s.destroy(); resolve(false); });
  });
}

function open(path: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(path, { allowExtension: true, readOnly });
  db.enableLoadExtension(true);
  req("sqlite-vec").load(db);
  if (!readOnly) db.prepare("PRAGMA busy_timeout = 10000").run();
  return db;
}

const mb = (n: number | null): string => (n === null ? "n/a" : `${(n / 1048576).toFixed(0)} MB`);

function printStats(s: TableStats): void {
  if (s.layout === "absent") { out(`  ${s.table}: not present`); return; }
  out(
    `  ${s.table}: layout=${s.layout} dims=${s.dims} rows=${s.rows} chunks=${s.chunks} chunk_size=${s.chunkSize} ` +
    `fill=${s.fillRatio === null ? "n/a" : (s.fillRatio * 100).toFixed(1) + "%"} vector-payload≈${mb(s.estVectorBytes)}` +
    (s.pageBytes !== null ? ` dbstat-pages=${mb(s.pageBytes)}` : ""),
  );
}

function randomQueries(db: DatabaseSync, spec: VecTableSpec, n: number, ids: string[]): Float32Array[] {
  const stmt = db.prepare(`SELECT embedding FROM ${spec.table} WHERE chunk_id = ?`);
  const picked: Float32Array[] = [];
  for (let i = 0; i < n && ids.length > 0; i++) {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const row = stmt.get(id) as { embedding: Uint8Array } | undefined;
    if (row) picked.push(new Float32Array(Uint8Array.from(row.embedding).buffer));
  }
  return picked;
}

async function guardOffline(db: string | undefined, what: string): Promise<string> {
  if (!db) { out(`STOP: ${what} needs an explicit --db <path> (no default on purpose).`); process.exit(2); }
  // A gateway's data dir holds gateway.lock / state.json. A scratch copy elsewhere
  // can be migrated while the live gateway keeps running.
  const dir = dirname(resolve(db));
  const isGatewayDir = existsSync(join(dir, "gateway.lock")) || existsSync(join(dir, "state.json"));
  if (isGatewayDir && (await portUp(8421))) { out("STOP: this DB belongs to a gateway data dir and something answers on 127.0.0.1:8421 (gateway up). Stop it first — exclusive access needed."); process.exit(1); }
  return db;
}

function commands(dbPath: string, suffix: string, specs: VecTableSpec[]): void {
  const t = specs.map((s) => s.table).join(",");
  out("\nROLLBACK (gateway stopped; vectors written after the migration stay in the parked compact tables):");
  out(`  node --max-old-space-size=3072 --import tsx tools/vec-compact.mts --rollback --db "${dbPath}" --suffix ${suffix} --tables ${t}`);
  out("\nCLEANUP when satisfied (NOT run by this tool; DROPs the old tables and VACUUMs — irreversible):");
  out(`  node --max-old-space-size=3072 --import tsx tools/vec-compact.mts --cleanup --db "${dbPath}" --suffix ${suffix} --tables ${t}`);
}

async function main(): Promise<void> {
  const only = (arg("tables") ?? "kb_vec,l0_vec").split(",");
  const specs = VEC_SPECS.filter((s) => only.includes(s.table));
  const suffix = arg("suffix") ?? today();
  const sample = Number(arg("sample") ?? 500);
  const batch = Number(arg("batch") ?? 1000);
  const knnN = Number(arg("knn-check") ?? 0);

  // ── rollback ──────────────────────────────────────────────────────────
  if (flag("rollback")) {
    const dbPath = await guardOffline(arg("db"), "--rollback");
    const db = open(dbPath, false);
    for (const spec of specs) {
      rollbackTable(db, spec, suffix);
      out(`${spec.table}: legacy table restored (compact parked as ${compactBackupName(spec, suffix)})`);
    }
    db.close();
    return;
  }

  // ── cleanup ───────────────────────────────────────────────────────────
  if (flag("cleanup")) {
    const dbPath = await guardOffline(arg("db"), "--cleanup");
    const db = open(dbPath, false);
    let dropped = 0;
    for (const spec of specs) {
      const ok = cleanupTable(db, spec, suffix);
      out(`${spec.table}: ${ok ? `dropped ${oldName(spec, suffix)}` : `${oldName(spec, suffix)} not found`}`);
      if (ok) dropped++;
    }
    if (dropped > 0) {
      out("VACUUM (needs free disk ≈ DB size; can take minutes)...");
      const t0 = Date.now();
      db.prepare("VACUUM").run();
      out(`VACUUM done in ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    db.close();
    return;
  }

  // ── dry-run (default) ─────────────────────────────────────────────────
  if (!flag("commit")) {
    const dbPath = arg("db") ?? LIVE_DEFAULT;
    out(`DRY-RUN (read-only) on ${dbPath}`);
    const db = open(dbPath, true);
    for (const spec of specs) {
      const s = tableStats(db, spec, { pages: flag("pages") });
      printStats(s);
      if (s.layout === "legacy") {
        const projected = Math.ceil(s.rows / 256);
        out(`    would: build ${spec.table}_new (compact, chunk_size=256, no partition key) + ${spec.table}_new_owner,`);
        out(`           copy ${s.rows} rows, verify counts + ${sample} random rows byte-identical,`);
        out(`           swap: ${spec.table} -> ${oldName(spec, suffix)}, new -> ${spec.table}. Projected chunks ≈ ${projected} (from ${s.chunks}).`);
      } else if (s.layout === "compact") {
        out("    already compact — nothing to do");
      }
    }
    db.close();
    out("\nNo changes made. Re-run with --commit --db <path> (gateway stopped) to migrate.");
    commands(dbPath, suffix, specs);
    return;
  }

  // ── commit ────────────────────────────────────────────────────────────
  const dbPath = await guardOffline(arg("db"), "--commit");
  const log = (m: string): void => out(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const db = open(dbPath, false);
  for (const spec of specs) {
    const ddl = vecTableSql(db, spec.table);
    if (!ddl) { log(`${spec.table}: not present, skipped`); continue; }
    if (!isLegacyVecSql(ddl)) { log(`${spec.table}: already compact, skipped`); continue; }
    if (tableExists(db, oldName(spec, suffix))) { log(`STOP: ${oldName(spec, suffix)} already exists — pick another --suffix or clean up first`); process.exit(2); }
    if (flag("reset-staging")) dropStaging(db, spec);

    const before = tableStats(db, spec);
    printStats(before);
    const t0 = Date.now();
    const built = buildStaging(db, spec, { batchSize: batch, log });
    log(`${spec.table}: copy done in ${Math.round((Date.now() - t0) / 1000)}s — copied=${built.copied} resumed-skipped=${built.skippedExisting} old=${built.oldRows} new=${built.newRows} owner=${built.ownerRows} chunks ${before.chunks} -> ${built.chunksAfter}`);

    const v = verifyTables(db, spec, spec.table, `${spec.table}_new`, built.chunkIds, {
      sampleSize: sample,
      ownerTable: `${spec.table}_new_owner`,
    });
    if (!v.ok) {
      log(`${spec.table}: VERIFY FAILED (nothing swapped). First problems:\n  ${v.problems.slice(0, 10).join("\n  ")}`);
      log("Fix the cause, then re-run with --reset-staging.");
      process.exit(3);
    }
    log(`${spec.table}: verify OK — counts equal, ${v.sampled} sampled rows byte-identical`);

    if (knnN > 0) {
      const qs = randomQueries(db, spec, knnN, built.chunkIds);
      const k = knnEquivalence(db, spec.table, `${spec.table}_new`, qs, 10);
      log(`${spec.table}: knn-check ${k.queries} queries identical=${k.identical} tie-only=${k.tieOnly} different=${k.different} (old ${Math.round(k.msA)}ms, new ${Math.round(k.msB)}ms)`);
      if (k.different > 0) { log("KNN differs — NOT swapping."); process.exit(3); }
    }

    swapTable(db, spec, suffix);
    log(`${spec.table}: swapped. Legacy table kept as ${oldName(spec, suffix)}.`);
  }
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
  db.close();

  // Independent post-swap check on a FRESH connection (vec0 must resolve the renamed shadows).
  const fresh = open(dbPath, true);
  let bad = false;
  for (const spec of specs) {
    if (!tableExists(fresh, oldName(spec, suffix))) continue;
    const ids = (fresh.prepare(`SELECT chunk_id FROM ${oldName(spec, suffix)}`).all() as Array<{ chunk_id: string }>).map((r) => r.chunk_id);
    const v = verifyTables(fresh, spec, oldName(spec, suffix), spec.table, ids, { sampleSize: Math.min(sample, 200), ownerTable: `${spec.table}_owner` });
    const s = tableStats(fresh, spec);
    log(`${spec.table}: post-swap fresh-connection check ${v.ok ? "OK" : "FAILED " + v.problems.slice(0, 3).join("; ")} (layout=${s.layout} rows=${s.rows} chunks=${s.chunks} dims=${vecDims(vecTableSql(fresh, spec.table))})`);
    if (!v.ok || s.layout !== "compact") bad = true;
  }
  fresh.close();
  commands(dbPath, suffix, specs);
  out("\nThe file does not shrink until the old tables are dropped and the DB is VACUUMed (cleanup command above).");
  out("Restart the gateway to pick up the compact layout (the code detects it at init).");
  if (bad) { out("POST-SWAP CHECK FAILED — run the rollback command above."); process.exit(4); }
}

main().catch((e) => { process.stdout.write(`FATAL: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
