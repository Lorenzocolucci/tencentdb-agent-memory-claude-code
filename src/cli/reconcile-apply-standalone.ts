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
import { writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
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
import { mergeEntities, ensureMergedIntoColumn } from "../core/kb/entity-merge.js";

const DEFAULT_REPORT = "entity-reconciliation-report.md";

const USAGE = `
Usage:
  node dist/src/cli/reconcile-apply-standalone.mjs --data-dir <dir> --generate [--top-ask N] [--report <file>]
  node dist/src/cli/reconcile-apply-standalone.mjs --data-dir <dir> --apply [--auto-only] [--commit] [--report <file>]

Modes:
  --generate   READ-ONLY: write an editable Markdown review report.
  --apply      Read the report and merge. DRY-RUN unless --commit is given.
  --commit     Perform the real merge (backup first; requires the gateway stopped).
  --auto-only  Under --apply: only AUTO clusters (safe first live run).
  --top-ask N  Under --generate: how many ASK clusters to include (default 30).
  --report F   Report path (default <data-dir>/${DEFAULT_REPORT}).
`;

interface Args {
  dataDir?: string;
  reportFile?: string;
  generate: boolean;
  apply: boolean;
  commit: boolean;
  autoOnly: boolean;
  topAsk: number;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { generate: false, apply: false, commit: false, autoOnly: false, topAsk: 30 };
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
    else if (a === "--commit") out.commit = true;
    else if (a === "--auto-only") out.autoOnly = true;
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

function backupStamp(): string {
  return nowIso().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
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
    writeFileSync(reportFile, md);

    const auto = clusters.filter((c) => c.band === "auto");
    const ask = clusters.filter((c) => c.band === "ask");
    process.stderr.write(
      `\n🔎 Entity-reconciliation report (READ-ONLY)\n` +
        `  entities:        ${entities.length} (${withVector} with a vector)\n` +
        `  clusters:        ${clusters.length}  →  AUTO ${auto.length}, ASK ${ask.length} (top ${topAsk} shown)\n` +
        `  report written:  ${reportFile}\n\n` +
        `  Next: review the ASK clusters (set 'decision: OK' to merge), then:\n` +
        `    --apply --auto-only            (dry-run of the 140 auto clusters)\n` +
        `    --apply --auto-only --commit   (real merge; stop the gateway first)\n`,
    );
  } finally {
    db.close();
  }
}

// ── apply ──────────────────────────────────────────────────────────────────

function doApply(dbPath: string, reportFile: string, opts: { commit: boolean; autoOnly: boolean }): void {
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
    ensureMergedIntoColumn(db);
    // Refuse to run if the DB is locked (gateway still up): a write probe.
    try {
      db.prepare("BEGIN IMMEDIATE").run();
      db.prepare("ROLLBACK").run();
    } catch {
      process.stderr.write(`\n❌ DB is locked — stop the gateway before --commit.\n`);
      process.exit(1);
    }

    // Backup BEFORE any mutation.
    const backup = `${dbPath}.bak-pre-reconcile-${backupStamp()}`;
    copyFileSync(dbPath, backup);
    process.stderr.write(`\n  backup: ${backup}\n`);

    const now = nowIso();
    let merged = 0, rekeyed = 0, resolved = 0, failed = 0;
    for (const p of plans) {
      try {
        const r = mergeEntities(db, p, now);
        merged += r.satellitesMerged;
        rekeyed += r.factsRekeyed;
        resolved += r.headCollisionsResolved;
      } catch (err) {
        failed++;
        process.stderr.write(`  ⚠️  cluster keep=${p.canonicalId} FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    process.stderr.write(
      `\n✅ Merge complete\n` +
        `  satellites merged:    ${merged}\n` +
        `  facts re-keyed:       ${rekeyed}\n` +
        `  collisions resolved:  ${resolved}\n` +
        `  clusters failed:      ${failed}\n` +
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
  if (args.generate === args.apply) {
    process.stderr.write(`\n❌ Choose exactly one of --generate or --apply.\n${USAGE}`);
    process.exit(1);
  }
  const dbPath = join(dataDir, "vectors.db");
  if (!existsSync(dbPath)) {
    process.stderr.write(`\n❌ No vectors.db at ${dbPath}. Check --data-dir.\n`);
    process.exit(1);
  }
  const reportFile = args.reportFile ?? join(dataDir, DEFAULT_REPORT);

  if (args.generate) doGenerate(dbPath, reportFile, args.topAsk);
  else doApply(dbPath, reportFile, { commit: args.commit, autoOnly: args.autoOnly });
}

main();
