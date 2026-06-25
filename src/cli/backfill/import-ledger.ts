/**
 * ImportLedger — SQLite-backed idempotency store for the backfill CLI.
 *
 * Tracks which chat message UUIDs have already been ingested into vectors.db
 * so that re-running the backfill does NOT produce duplicate L0 records.
 *
 * Design:
 * - Separate SQLite file (ledger.db) — never touches the live vectors.db
 * - Synchronous API (DatabaseSync) to match the sqlite.ts pattern
 * - Single table: ingested_messages(uuid TEXT PRIMARY KEY)
 * - INSERT OR IGNORE for idempotent markIngested()
 */

import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";

const require = createRequire(import.meta.url);

function openSqlite(dbPath: string): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");
  return db;
}

export class ImportLedger {
  private db: DatabaseSync;
  private stmtHas: StatementSync;
  private stmtMark: StatementSync;

  constructor(ledgerPath: string) {
    this.db = openSqlite(ledgerPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ingested_messages (
        uuid TEXT PRIMARY KEY NOT NULL
      )
    `);
    this.stmtHas = this.db.prepare(
      "SELECT 1 FROM ingested_messages WHERE uuid = ?",
    );
    this.stmtMark = this.db.prepare(
      "INSERT OR IGNORE INTO ingested_messages (uuid) VALUES (?)",
    );
  }

  /** True when this message uuid was previously ingested. */
  hasIngested(uuid: string): boolean {
    const row = this.stmtHas.get(uuid) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  /** Record a message uuid as ingested (idempotent). */
  markIngested(uuid: string): void {
    this.stmtMark.run(uuid);
  }

  /** Flush WAL and close the database. */
  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.close();
    } catch {
      // best-effort
    }
  }
}
