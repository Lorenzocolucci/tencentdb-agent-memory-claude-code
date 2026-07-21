#!/usr/bin/env node
/**
 * Standalone entry — Consolidation Cura #2, Phase 2b: entity-merge RUNNER.
 *
 *   --generate  READ-ONLY. Detect near-duplicate clusters (same pipeline as the
 *               2a detector) and write an editable Markdown REVIEW REPORT.
 *   --apply     Read the (edited) report and MERGE. DRY-RUN by default (no write);
 *               add --commit to mutate. --commit takes a timestamped backup first
 *               and refuses to run if the DB is locked (stop the gateway).
 *   --auto-only Under --apply, restrict to AUTO clusters (the safe first live run).
 *
 * SAFETY: --generate never writes to vectors.db. --apply without --commit never
 * writes. --commit backs up first, merges each cluster in its own transaction
 * (entity-merge.mergeEntities — non-destructive, guarded), and rolls back on any
 * per-cluster violation. Deterministic; no LLM.
 */

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { getEnv } from "../utils/env.js";
import {
  findCandidatePairs,
  buildClusters,
  aggregateEntityVector,
  type RecEntity,
} from "../core/kb/entity-reconciliation.js";
import {
  renderReport,
  parseReport,
  toMergePlans,
  type EntityMeta,
} from "../core/kb/entity-merge-plan.js";
import { mergeEntities, ensureMergedIntoColumn, rekeyRelationsOnMerge, groupByUltimateCanonical, type MergePlan } from "../core/kb/entity-merge.js";

const DEFAULT_REPORT = "entity-reconciliation-report.md";

const USAGE = `
Usage:
  node dist/src/cli/reconcile-apply-standalone.mjs --data-dir <dir> --generate [--top-ask N] [--report <file>]
  node dist/src/cli/reconcile-apply-standalone.mjs --data-dir <dir> --apply [--auto-only] [--commit --gateway-stopped] [--report <file>]

Modes (exactly one):
  --generate           READ-ONLY: write an editable Markdown review report.
  --apply              Read the report and merge. DRY-RUN unless --commit is given.
  --backfill-relations Re-key relations for entities ALREADY merged (Cura #2c) —
                       fixes edges left dangling by merges applied before 2c.
                       DRY-RUN unless --commit is given.

Flags:
  --commit          Perform the real mutation (checkpoint+backup first).
  --gateway-stopped Required with --commit: you assert the gateway is stopped.
  --auto-only       Under --apply: only AUTO clusters (safe first live run).
  --top-ask N       Under --generate: how many ASK clusters to include (default 30).
  --report F        Report path (default <data-dir>/${DEFAULT_REPORT}).
`;

interface Args {
  dataDir?: string;
  reportFile?: string;
  generate: boolean;
  apply: boolean;
  backfillRelations: boolean;
  commit: boolean;
  autoOnly: boolean;
  gatewayStopped: boolean;
  topAsk: number;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { generate: false, apply: false, backfillRelations: false, commit: false, autoOnly: false, gatewayStopped: false, topAsk: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a.startsWith("--data-dir=")) out.dataDir = a.slice("--data-dir=".length);
    else if (a === "--report") out.reportFile = argv[++i];
    else if (a.startsWith("--report=")) out.reportFile = a.slice("--report=".length);
    else if (a === "--top-ask") out.topAsk = Number(argv[++i]);
    else if (a.startsWith("--top-ask=")) out.topAsk = Number(a.slice("--top-ask=".length));
    else if (a === "--generate") out.generate = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--backfill-relations") out.backfillRelations = true;
    else if (a === "--commit") out.commit = true;
    else if (a === "--auto-only") out.autoOnly = true;
    else if (a === "--gateway-stopped") out.gatewayStopped = true;
    else if (a === "--help" || a === "-h") { process.stdout.write(USAGE); process.exit(0); }
    else { process.stderr.write(`\n❌ Unknown argument: ${a}\n${USAGE}`); process.exit(1); }
  }
  return out;
}

/** node:sqlite BLOB → Float32Array (embedding is dims*4 little-endian floats). */
function toFloat32(blob: unknown): Float32Array | null {
  if (blob instanceof Uint8Array) {
    if (blob.byteLength % 4 !== 0) return null;
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  if (blob instanceof ArrayBuffer) return new Float32Array(blob);
  return null;
}

function hasColumn(db: DatabaseSync, table: string, col: string): boolean {
  // Defense-in-depth: PRAGMA cannot bind identifiers, so guard the table name
  // against a strict identifier shape before interpolating (all callers pass a
  // literal today, but never template an unvalidated identifier into SQL).
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`hasColumn: invalid table name ${table}`);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

interface LoadResult {
  entities: RecEntity[];
  meta: Map<string, EntityMeta>;
  withVector: number;
}

/**
 * Load entities (excluding already-merged satellites when the column exists),
 * aggregate their HEAD-fact vectors, and build the per-entity metadata map.
 * Same aggregation as the 2a detector (mean-pool of kb_vec fact vectors).
 */
function loadEntities(db: DatabaseSync): LoadResult {
  const filterMerged = hasColumn(db, "entities", "merged_into");
  const entSql = filterMerged
    ? "SELECT id, type, name, importance, created_time FROM entities WHERE merged_into IS NULL"
    : "SELECT id, type, name, importance, created_time FROM entities";
  const entRows = db.prepare(entSql).all() as Array<{
    id: string; type: string; name: string; importance: number; created_time: string;
  }>;

  // HEAD fact → entity, and HEAD fact-count per entity.
  const factToEntity = new Map<string, string>();
  const factCount = new Map<string, number>();
  for (const f of db
    .prepare("SELECT id, entity_id FROM facts WHERE superseded_by IS NULL AND valid_to IS NULL")
    .all() as Array<{ id: string; entity_id: string }>) {
    factToEntity.set(f.id, f.entity_id);
    factCount.set(f.entity_id, (factCount.get(f.entity_id) ?? 0) + 1);
  }

  // Aggregate fact vectors per entity (single kb_vec scan; fact owners only).
  const vecsByEntity = new Map<string, Float32Array[]>();
  for (const row of db
    .prepare("SELECT owner_id, owner_kind, embedding FROM kb_vec")
    .all() as Array<{ owner_id: string; owner_kind: string; embedding: unknown }>) {
    if (row.owner_kind !== "fact") continue;
    const entId = factToEntity.get(row.owner_id);
    if (!entId) continue;
    const v = toFloat32(row.embedding);
    if (!v) continue;
    const arr = vecsByEntity.get(entId);
    if (arr) arr.push(v);
    else vecsByEntity.set(entId, [v]);
  }

  const meta = new Map<string, EntityMeta>();
  const entities: RecEntity[] = entRows.map((e) => {
    meta.set(e.id, {
      name: e.name,
      type: e.type,
      factCount: factCount.get(e.id) ?? 0,
      importance: e.importance,
      createdTime: e.created_time,
    });
    return {
      id: e.id, type: e.type, name: e.name, importance: e.importance,
      vector: aggregateEntityVector(vecsByEntity.get(e.id) ?? []),
    };
  });
  const withVector = entities.filter((e) => e.vector).length;
  return { entities, meta, withVector };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Restrict a backup file (full DB with secrets) to owner-only, matching the report. */
function restrictPerms(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort: Windows ignores POSIX modes; never fail the backup over perms */
  }
}

function backupStamp(): string {
  // Millisecond precision so two same-second --commit runs never clobber a backup.
  return nowIso().replace(/[-:]/g, "").replace(/\./g, "").replace("T", "-").replace("Z", "");
}

/**
 * Re-derive clusters from the DB and assert every merge-plan id belongs to a
 * SINGLE detected near-duplicate cluster. Prevents a hand-edit that mistypes an
 * id (into another valid same-type entity) from silently merging strangers:
 * the report is not blindly trusted. Fail-loud on any id not in a detected cluster.
 */
function validatePlansAgainstDetection(db: DatabaseSync, plans: MergePlan[]): void {
  const { entities } = loadEntities(db);
  const { pairs } = findCandidatePairs(entities);
  const clusters = buildClusters(pairs);
  const memberSets = clusters.map((c) => new Set(c.members));
  for (const p of plans) {
    const ids = [p.canonicalId, ...p.satelliteIds];
    const covering = memberSets.find((s) => ids.every((id) => s.has(id)));
    if (!covering) {
      throw new Error(
        `Plan keep=${p.canonicalId} (+${p.satelliteIds.length}) is NOT a subset of any detected ` +
          `near-duplicate cluster — refusing (possible mistyped id in the report).`,
      );
    }
  }
}

// ── generate ─────────────────────────────────────────────────────────────────

function doGenerate(dbPath: string, reportFile: string, topAsk: number): void {
  const db = new DatabaseSync(dbPath, { allowExtension: true, readOnly: true });
  try {
    createRequire(import.meta.url)("sqlite-vec").load(db);
    const { entities, meta, withVector } = loadEntities(db);
    const { pairs } = findCandidatePairs(entities);
    const clusters = buildClusters(pairs);

    const md = renderReport({
      clusters,
      meta,
      topAsk,
      totals: { entities: entities.length, entitiesWithVector: withVector },
      generatedAt: nowIso(),
    });
    // The report embeds entity NAMES (which can be secret-looking labels like
    // "TWILIO_AUTH_TOKEN") — restrictive mode on POSIX; delete after applying.
    writeFileSync(reportFile, md, { mode: 0o600 });

    const auto = clusters.filter((c) => c.band === "auto");
    const ask = clusters.filter((c) => c.band === "ask");
    process.stderr.write(
      `\n🔎 Entity-reconciliation report (READ-ONLY)\n` +
        `  entities:        ${entities.length} (${withVector} with a vector)\n` +
        `  clusters:        ${clusters.length}  →  AUTO ${auto.length}, ASK ${ask.length} (top ${topAsk} shown)\n` +
        `  report written:  ${reportFile}  (contains entity names — delete after applying)\n\n` +
        `  Next: review the ASK clusters (set 'decision: OK' to merge), then:\n` +
        `    --apply --auto-only                         (dry-run of the auto clusters)\n` +
        `    --apply --auto-only --commit --gateway-stopped   (real merge; stop the gateway first)\n`,
    );
  } finally {
    db.close();
  }
}

// ── apply ──────────────────────────────────────────────────────────────────

function doApply(dbPath: string, reportFile: string, opts: { commit: boolean; autoOnly: boolean; gatewayStopped: boolean }): void {
  if (!existsSync(reportFile)) {
    process.stderr.write(`\n❌ No report at ${reportFile}. Run --generate first.\n`);
    process.exit(1);
  }
  const parsed = parseReport(readFileSync(reportFile, "utf8"));
  const plans = toMergePlans(parsed, { autoOnly: opts.autoOnly });

  const okCount = parsed.filter((c) => c.decision === "OK").length;
  process.stderr.write(
    `\n🧩 Apply plan (${opts.commit ? "COMMIT" : "DRY-RUN"}${opts.autoOnly ? ", auto-only" : ""})\n` +
      `  clusters in report:   ${parsed.length} (decision OK: ${okCount})\n` +
      `  merge plans selected: ${plans.length}\n`,
  );
  if (plans.length === 0) {
    process.stderr.write(`  Nothing to merge. (Set 'decision: OK' on ASK clusters, or drop --auto-only.)\n`);
    return;
  }

  // Open the DB (read-only for dry-run so we CANNOT accidentally mutate).
  const db = new DatabaseSync(dbPath, { allowExtension: true, readOnly: !opts.commit });
  try {
    createRequire(import.meta.url)("sqlite-vec").load(db);

    // The report is NOT blindly trusted: re-derive clusters and assert every plan
    // is a subset of one detected near-duplicate cluster (catches mistyped ids).
    validatePlansAgainstDetection(db, plans);
    process.stderr.write(`  membership check:     OK (all ${plans.length} plans within detected clusters)\n`);

    // Dry-run preview: how many facts re-key, how many attribute HEAD collisions.
    let totalRekey = 0;
    let totalCollisions = 0;
    for (const p of plans) {
      const ids = [p.canonicalId, ...p.satelliteIds];
      const placeholders = ids.map(() => "?").join(",");
      const heads = db
        .prepare(
          `SELECT entity_id, attribute, value FROM facts ` +
            `WHERE entity_id IN (${placeholders}) AND superseded_by IS NULL AND valid_to IS NULL`,
        )
        .all(...ids) as Array<{ entity_id: string; attribute: string; value: string }>;
      const rekey = heads.filter((h) => h.entity_id !== p.canonicalId).length;
      // Attributes that, once re-keyed onto the canonical, hold ≥2 distinct values
      // → the existing supersession will collapse them (the €18/€387 case).
      const byAttr = new Map<string, Set<string>>();
      for (const h of heads) {
        const s = byAttr.get(h.attribute) ?? new Set<string>();
        s.add(h.value.trim().toLowerCase());
        byAttr.set(h.attribute, s);
      }
      const collisions = [...byAttr.values()].filter((s) => s.size > 1).length;
      totalRekey += rekey;
      totalCollisions += collisions;
    }
    process.stderr.write(
      `  facts to re-key:      ${totalRekey}\n` +
        `  attribute collisions: ${totalCollisions} (→ supersessions the merge will resolve)\n`,
    );

    if (!opts.commit) {
      process.stderr.write(`\n  DRY-RUN only — nothing written. Re-run with --commit to apply.\n`);
      return;
    }

    // ── COMMIT path ──
    // The lock probe under WAL only catches an active WRITER, not an idle/reading
    // gateway, so require the operator to explicitly assert the gateway is down.
    if (!opts.gatewayStopped) {
      process.stderr.write(
        `\n❌ --commit requires --gateway-stopped (WAL makes the lock probe writer-only).\n` +
          `   Stop the gateway, then re-run with --commit --gateway-stopped.\n`,
      );
      process.exit(1);
    }
    // Fail fast (no 5s wait) if any lock contention appears mid-run.
    db.prepare("PRAGMA busy_timeout = 0").run();

    // Order matters (security review): lock-probe → checkpoint → backup → schema
    // mutation → merges, so NO write ever precedes the backup.
    // 1. Refuse to run if the DB is locked (gateway still up): a write probe.
    try {
      db.prepare("BEGIN IMMEDIATE").run();
      db.prepare("ROLLBACK").run();
    } catch {
      process.stderr.write(`\n❌ DB is locked — stop the gateway before --commit.\n`);
      process.exit(1);
    }

    // 2. Fold the WAL into the main file so the file copy is a COMPLETE snapshot
    //    (WAL mode keeps committed-but-uncheckpointed frames out of the .db file).
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();

    // 3. Backup BEFORE any mutation. NOTE: this copy is the FULL DB (secrets
    //    included) — prune old .bak-pre-reconcile-* files after verifying.
    const backup = `${dbPath}.bak-pre-reconcile-${backupStamp()}`;
    copyFileSync(dbPath, backup);
    restrictPerms(backup);
    process.stderr.write(`\n  backup: ${backup}  (full DB with secrets — prune old ones)\n`);

    // 4. Now the additive schema mutation (no-op when the column already exists).
    ensureMergedIntoColumn(db);

    const now = nowIso();
    let merged = 0, rekeyed = 0, resolved = 0, relRekeyed = 0, relFolded = 0, relSelfLoops = 0, failed = 0;
    for (const p of plans) {
      try {
        const r = mergeEntities(db, p, now);
        merged += r.satellitesMerged;
        rekeyed += r.factsRekeyed;
        resolved += r.headCollisionsResolved;
        relRekeyed += r.relationsRekeyed;
        relFolded += r.relationsFolded;
        relSelfLoops += r.relationsSelfLoopsDropped;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A lock appearing mid-run means the gateway came up — abort, don't
        // silently skip clusters against a live DB.
        if (/busy|locked/i.test(msg)) {
          process.stderr.write(`\n❌ DB became locked mid-run (gateway up?) — ABORTING after ${merged} merges. Restore the backup if needed.\n`);
          process.exit(1);
        }
        failed++;
        process.stderr.write(`  ⚠️  cluster keep=${p.canonicalId} FAILED: ${msg}\n`);
      }
    }
    process.stderr.write(
      `\n✅ Merge complete\n` +
        `  satellites merged:    ${merged}\n` +
        `  facts re-keyed:       ${rekeyed}\n` +
        `  collisions resolved:  ${resolved}\n` +
        `  relations re-keyed:   ${relRekeyed} (folded ${relFolded}, self-loops dropped ${relSelfLoops})\n` +
        `  clusters failed:      ${failed}\n` +
        `  Restart the gateway and verify recall.\n`,
    );
  } finally {
    db.close();
  }
}

// ── backfill relations (Cura #2c) ───────────────────────────────────────────

/**
 * Re-key relations for entities that were ALREADY merged (merged_into set) by a
 * merge that ran BEFORE Cura #2c re-keyed relations. Reuses the exact same tested
 * helper (rekeyRelationsOnMerge), grouped per canonical, in one transaction.
 * DRY-RUN by default; --commit backs up first and requires --gateway-stopped.
 */
function doBackfillRelations(dbPath: string, opts: { commit: boolean; gatewayStopped: boolean }): void {
  const db = new DatabaseSync(dbPath, { readOnly: !opts.commit });
  try {
    if (!hasColumn(db, "entities", "merged_into")) {
      process.stderr.write(`\n🔗 No merged_into column — no merges have run; nothing to backfill.\n`);
      return;
    }
    // Guard (defensive, LOW-5): a DB with merged_into but no relations table has
    // nothing to backfill — mirror rekeyRelationsOnMerge's tolerance.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='relations'").get()) {
      process.stderr.write(`\n🔗 No relations table — nothing to backfill.\n`);
      return;
    }
    // Group merged satellites by ULTIMATE canonical (pure, sorted, cycle-safe).
    const mergedRows = db
      .prepare("SELECT id, merged_into FROM entities WHERE merged_into IS NOT NULL ORDER BY id")
      .all() as Array<{ id: string; merged_into: string }>;
    const { byCanon, cyclic } = groupByUltimateCanonical(mergedRows);
    if (cyclic.length > 0) {
      process.stderr.write(`  ⚠️  ${cyclic.length} entities have a cyclic merged_into chain — skipped.\n`);
    }
    // satellite → ultimate canonical, for the read-only dry-run count.
    const canonOfSat = new Map<string, string>();
    for (const [canon, sats] of byCanon) for (const s of sats) canonOfSat.set(s, canon);

    // Dry-run count (read-only): DISTINCT relations touching a merged satellite.
    let touching = 0, selfLoops = 0;
    for (const rel of db.prepare("SELECT src_entity_id s, dst_entity_id d FROM relations").all() as Array<{ s: string; d: string }>) {
      const sm = canonOfSat.has(rel.s), dm = canonOfSat.has(rel.d);
      if (!sm && !dm) continue;
      touching++;
      if ((sm ? canonOfSat.get(rel.s) : rel.s) === (dm ? canonOfSat.get(rel.d) : rel.d)) selfLoops++;
    }
    process.stderr.write(
      `\n🔗 Relation backfill (${opts.commit ? "COMMIT" : "DRY-RUN"})\n` +
        `  merged canonicals:    ${byCanon.size}\n` +
        `  relations to fix:     ${touching} distinct (${selfLoops} become self-loops → drop)\n`,
    );
    if (touching === 0) { process.stderr.write(`  Nothing to backfill.\n`); return; }

    if (!opts.commit) {
      process.stderr.write(`\n  DRY-RUN only — nothing written. Re-run with --commit --gateway-stopped.\n`);
      return;
    }

    // ── COMMIT path (same safety order as --apply) ──
    if (!opts.gatewayStopped) {
      process.stderr.write(`\n❌ --commit requires --gateway-stopped.\n`);
      process.exit(1);
    }
    db.prepare("PRAGMA busy_timeout = 0").run();
    try {
      db.prepare("BEGIN IMMEDIATE").run();
      db.prepare("ROLLBACK").run();
    } catch {
      process.stderr.write(`\n❌ DB is locked — stop the gateway before --commit.\n`);
      process.exit(1);
    }
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
    const backup = `${dbPath}.bak-pre-relbackfill-${backupStamp()}`;
    copyFileSync(dbPath, backup);
    restrictPerms(backup);
    process.stderr.write(`\n  backup: ${backup}  (full DB with secrets — prune old ones)\n`);

    let rk = 0, fl = 0, sl = 0, skipped = 0;
    const canonExists = db.prepare("SELECT 1 FROM entities WHERE id = ? AND merged_into IS NULL");
    db.prepare("BEGIN IMMEDIATE").run();
    try {
      for (const [canon, sats] of byCanon) {
        // Defense-in-depth: never re-key relations onto a canonical that a corrupt
        // merged_into value points at but that doesn't exist (or is itself merged).
        if (!canonExists.get(canon)) {
          process.stderr.write(`  ⚠️  skip: canonical ${canon} missing or itself merged — ${sats.length} satellites left as-is\n`);
          skipped++;
          continue;
        }
        const r = rekeyRelationsOnMerge(db, canon, sats);
        rk += r.relationsRekeyed;
        fl += r.relationsFolded;
        sl += r.relationsSelfLoopsDropped;
      }
      db.prepare("COMMIT").run();
    } catch (err) {
      db.prepare("ROLLBACK").run();
      throw err;
    }
    if (skipped > 0) process.stderr.write(`  canonicals skipped:   ${skipped}\n`);
    process.stderr.write(
      `\n✅ Relation backfill complete (counts are per-pass; a cross-canonical edge is counted in each endpoint's pass)\n` +
        `  relations re-keyed:   ${rk}\n` +
        `  support folded:       ${fl}\n` +
        `  self-loops dropped:   ${sl}\n` +
        `  Restart the gateway and verify recall.\n`,
    );
  } finally {
    db.close();
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir ?? getEnv("TDAI_DATA_DIR");
  if (!dataDir || !dataDir.trim()) {
    process.stderr.write(`\n❌ --data-dir is required (or set TDAI_DATA_DIR).\n${USAGE}`);
    process.exit(1);
  }
  const modeCount = [args.generate, args.apply, args.backfillRelations].filter(Boolean).length;
  if (modeCount !== 1) {
    process.stderr.write(`\n❌ Choose exactly one of --generate, --apply, --backfill-relations.\n${USAGE}`);
    process.exit(1);
  }
  if (!Number.isInteger(args.topAsk) || args.topAsk < 0) {
    process.stderr.write(`\n❌ --top-ask must be a non-negative integer (got ${args.topAsk}).\n`);
    process.exit(1);
  }
  const dbPath = join(dataDir, "vectors.db");
  if (!existsSync(dbPath)) {
    process.stderr.write(`\n❌ No vectors.db at ${dbPath}. Check --data-dir.\n`);
    process.exit(1);
  }
  const reportFile = args.reportFile ?? join(dataDir, DEFAULT_REPORT);

  if (args.generate) doGenerate(dbPath, reportFile, args.topAsk);
  else if (args.apply) doApply(dbPath, reportFile, { commit: args.commit, autoOnly: args.autoOnly, gatewayStopped: args.gatewayStopped });
  else doBackfillRelations(dbPath, { commit: args.commit, gatewayStopped: args.gatewayStopped });
}

main();
