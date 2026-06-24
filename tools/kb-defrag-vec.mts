/**
 * kb-defrag-vec.mts — reclaim sqlite-vec vec0 dead space (one-time maintenance).
 *
 * vec0 virtual tables never release chunk storage on DELETE, and VACUUM cannot
 * compact them. Repeated wipe/reinsert churn left kb_vec/l1_vec/l0_vec massively
 * bloated (GBs for hundreds of rows). This DEFRAGS each table by copying its
 * live vectors into a FRESH table (drop -> recreate from the exact CREATE sql ->
 * re-insert the already-computed embedding blobs — NO re-embedding) then VACUUMs
 * so the freed pages shrink the file.
 *
 * PRECONDITION: gateway stopped (exclusive). Safe: only vec tables (derived /
 * regenerable) are touched; entities/facts/events/l1_records/l0_conversations
 * are NOT touched. Run: node_modules/.bin/tsx tools/kb-defrag-vec.mts
 */
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";

const req = createRequire(import.meta.url);
const DB = "C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local/vectors.db";

const TABLES = [
  { name: "kb_vec", cols: ["chunk_id", "owner_id", "owner_kind", "embedding", "updated_time"] },
  { name: "l1_vec", cols: ["chunk_id", "record_id", "embedding", "updated_time"] },
  { name: "l0_vec", cols: ["chunk_id", "record_id", "embedding", "recorded_at"] },
];

function portUp(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(1200, () => { s.destroy(); res(false); });
  });
}

function run(db: DatabaseSync, sql: string): void {
  db.prepare(sql).run();
}

async function main() {
  if (await portUp(8421)) {
    console.log("STOP: gateway is up on 8421. Stop it first (exclusive access needed).");
    process.exit(1);
  }
  const db = new DatabaseSync(DB, { allowExtension: true });
  db.enableLoadExtension(true);
  req("sqlite-vec").load(db);

  for (const t of TABLES) {
    const createSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(t.name) as { sql?: string } | undefined)?.sql;
    if (!createSql) { console.log(`${t.name}: not found, skip`); continue; }
    const before = (db.prepare(`SELECT COUNT(*) c FROM ${t.name}`).get() as { c: number }).c;
    const rows = db.prepare(`SELECT ${t.cols.join(",")} FROM ${t.name}`).all() as Record<string, unknown>[];

    run(db, `DROP TABLE ${t.name}`);
    // Inject a small chunk_size so vec0 allocates ~chunk_size*dim*4 bytes per
    // PARTITION instead of the 1024-vector default (6.29 MB/partition). With a
    // near-unique partition key that default was the real bloat. Must be ÷8.
    const newCreate = createSql.replace(/\)\s*$/, ", chunk_size=8)");
    run(db, newCreate);
    const ins = db.prepare(`INSERT INTO ${t.name}(${t.cols.join(",")}) VALUES (${t.cols.map(() => "?").join(",")})`);
    let n = 0;
    for (const r of rows) { ins.run(...t.cols.map((c) => r[c] as never)); n++; }
    const after = (db.prepare(`SELECT COUNT(*) c FROM ${t.name}`).get() as { c: number }).c;
    const ok = before === n && n === after;
    console.log(`${t.name}: before=${before} reinserted=${n} after=${after} ${ok ? "OK" : "!! MISMATCH"}`);
    if (!ok) { console.log("ABORT (no VACUUM) — counts mismatch, investigate."); db.close(); process.exit(2); }
  }

  console.log("VACUUM (reclaim freed pages)...");
  const v = Date.now();
  run(db, "VACUUM");
  console.log(`VACUUM done in ${Math.round((Date.now() - v) / 1000)}s`);
  db.close();
  console.log("DONE.");
}
main().catch((e) => { console.log("FATAL:", e instanceof Error ? e.stack : e); process.exit(1); });
