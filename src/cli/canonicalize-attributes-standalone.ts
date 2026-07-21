#!/usr/bin/env node
/**
 * Standalone entry — Consolidation Cura #1 attribute-canonicalization backfill.
 *
 * Relabels historical fact attributes to their canonical form and collapses the
 * HEADs that then collide (see backfill/canonicalize-attributes.ts). Opens the
 * SQLite store directly (no embedding config needed — this pass never re-embeds;
 * the read path drops superseded losers on its own).
 *
 * SAFETY: dry-run by DEFAULT. `--apply` writes inside one transaction. BACK UP
 * vectors.db before `--apply`. Stop the live gateway first (a concurrent writer
 * would make the transaction fail with SQLITE_BUSY). An audit JSON of every
 * relabel is written next to the DB for precise rollback.
 */

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { backfillCanonicalizeAttributes } from "./backfill/canonicalize-attributes.js";
import { getEnv } from "../utils/env.js";
import { redactSecrets } from "../utils/redact-secrets.js";

const USAGE = `
Usage:
  node dist/src/cli/canonicalize-attributes-standalone.mjs --data-dir <dir> [--apply] [--audit <file>]

Options:
  --data-dir <dir>   Directory holding the SQLite store (vectors.db). Required
                     (or set TDAI_DATA_DIR). Never guessed.
  --apply            Actually write. WITHOUT it this is a DRY RUN (no writes).
                     BACK UP vectors.db and STOP the gateway before --apply.
  --audit <file>     Where to write the JSON audit of relabels. Defaults to
                     <data-dir>/canonicalize-attributes-audit.json.
`;

interface ParsedArgs {
  dataDir?: string;
  apply: boolean;
  auditFile?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir") out.dataDir = argv[++i];
    else if (arg.startsWith("--data-dir=")) out.dataDir = arg.slice("--data-dir=".length);
    else if (arg === "--audit") out.auditFile = argv[++i];
    else if (arg.startsWith("--audit=")) out.auditFile = arg.slice("--audit=".length);
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      process.stderr.write(`\n❌ Unknown argument: ${arg}\n${USAGE}`);
      process.exit(1);
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir ?? getEnv("TDAI_DATA_DIR");
  if (!dataDir || !dataDir.trim()) {
    process.stderr.write(`\n❌ --data-dir is required (or set TDAI_DATA_DIR).\n${USAGE}`);
    process.exit(1);
  }

  const dbPath = join(dataDir, "vectors.db");
  // Fail loudly on a wrong --data-dir instead of silently CREATING an empty
  // vectors.db (node:sqlite opens read-write-create by default) and reporting a
  // misleading "0 relabeled" no-op against an empty table.
  if (!existsSync(dbPath)) {
    process.stderr.write(`\n❌ No vectors.db at ${dbPath}. Check --data-dir.\n${USAGE}`);
    process.exit(1);
  }
  const auditFile = args.auditFile ?? join(dataDir, "canonicalize-attributes-audit.json");
  const nowIso = new Date().toISOString();

  const db = new DatabaseSync(dbPath);
  try {
    const res = backfillCanonicalizeAttributes(db, { apply: args.apply, nowIso });

    // Always write the audit (the planned or applied change list). Redact the
    // attribute strings: legacy rows written before attribute-redaction could
    // carry a secret-shaped attribute — defense-in-depth so the on-disk audit
    // never persists one.
    const redactedChanges = res.changes.map((c) => ({
      id: c.id,
      entity_id: c.entity_id,
      old: redactSecrets(c.old),
      canonical: redactSecrets(c.canonical),
    }));
    writeFileSync(
      auditFile,
      JSON.stringify(
        {
          version: 1,
          mapVersion: res.mapVersion,
          appliedAt: res.applied ? nowIso : null,
          dryRun: !res.applied,
          summary: {
            relabeled: res.relabeled,
            distinctAttrsChanged: res.distinctAttrsChanged,
            groupsResolved: res.groupsResolved,
            headsSuperseded: res.headsSuperseded,
          },
          changes: redactedChanges,
          // Precise rollback manifest: each closed row's prior state was
          // (valid_to=NULL, superseded_by=NULL, superseded_at=NULL).
          supersededHeads: res.supersededHeads,
        },
        null,
        2,
      ),
    );

    process.stderr.write(
      `\n${res.applied ? "✅ APPLIED" : "🔎 DRY RUN (no writes — pass --apply)"}\n` +
        `  rows relabeled:        ${res.relabeled}\n` +
        `  distinct attrs changed: ${res.distinctAttrsChanged}\n` +
        `  HEAD groups resolved:   ${res.groupsResolved}\n` +
        `  older HEADs superseded: ${res.headsSuperseded}\n` +
        `  audit written:          ${auditFile}\n` +
        (res.applied ? "" : "\n  ⚠️  BACK UP vectors.db and STOP the gateway before --apply.\n"),
    );
  } finally {
    db.close();
  }
}

main();
