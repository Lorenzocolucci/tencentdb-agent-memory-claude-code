/**
 * Injection statistics from the recall ledger (Phase 3.12) — the numbers the
 * "silent unless useful" targets are written in:
 *
 *   - per tier (fact/event × query/associative): injected, judgeable, used, used %
 *   - memory lines per turn and % of turns with NO memory (silent-turn markers)
 *   - cross-project lines: injected memories whose project is known and differs from
 *     the project the session belongs to (session_projects registry)
 *
 * A "turn" is one recall: ledger rows written together share (session_key, ts).
 * Read-only; never throws (an empty/failed read yields zeros).
 */

import type { DatabaseSync } from "node:sqlite";
import { ownerProjects } from "./selective-store.js";
import { projectsConflict } from "./selective-recall.js";

export interface TierStats {
  kind: string;
  associative: boolean;
  injected: number;
  /** Judged and judgeable: the denominator of the used rate. */
  judgeable: number;
  used: number;
  /** used / judgeable, null when nothing is judgeable. */
  usedRate: number | null;
}

export interface InjectionStats {
  tiers: TierStats[];
  /** Turns that injected at least one memory. */
  turnsInjected: number;
  /** Turns on which recall deliberately injected nothing (since silent-turn markers exist). */
  turnsSilent: number;
  /** Memory lines injected in total. */
  lines: number;
  /** lines / (turnsInjected + turnsSilent); null with no turns. */
  linesPerTurn: number | null;
  /** turnsSilent / all turns, in percent; null with no turns. */
  silentTurnsPct: number | null;
  /** Injected memories that belong to another project than their session's. */
  crossProjectLines: number;
}

export interface InjectionStatsParams {
  sessionKey?: string;
  /** ISO lower bound on injection time. */
  sinceTs?: string;
}

const EMPTY: InjectionStats = {
  tiers: [], turnsInjected: 0, turnsSilent: 0, lines: 0,
  linesPerTurn: null, silentTurnsPct: null, crossProjectLines: 0,
};

export function readInjectionStats(db: DatabaseSync, params: InjectionStatsParams = {}): InjectionStats {
  try {
    const where: string[] = [];
    const args: string[] = [];
    if (params.sessionKey) { where.push("session_key = ?"); args.push(params.sessionKey); }
    if (params.sinceTs) { where.push("ts >= ?"); args.push(params.sinceTs); }
    const and = where.length > 0 ? ` AND ${where.join(" AND ")}` : "";

    const tierRows = db
      .prepare(
        `SELECT owner_kind AS kind, associative AS assoc, COUNT(*) AS injected,
                SUM(CASE WHEN judged = 1 AND unjudgeable = 0 THEN 1 ELSE 0 END) AS judgeable,
                COALESCE(SUM(used), 0) AS used
           FROM recall_ledger WHERE owner_kind != 'turn'${and}
          GROUP BY owner_kind, associative ORDER BY owner_kind, associative`,
      )
      .all(...args) as Array<{ kind: string; assoc: number; injected: number; judgeable: number; used: number }>;
    const tiers: TierStats[] = tierRows.map((r) => ({
      kind: r.kind,
      associative: r.assoc === 1,
      injected: r.injected,
      judgeable: r.judgeable,
      used: r.used,
      usedRate: r.judgeable > 0 ? r.used / r.judgeable : null,
    }));

    const turnsInjected = (db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM recall_ledger WHERE owner_kind != 'turn'${and} GROUP BY session_key, ts)`)
      .get(...args) as { n: number }).n;
    const turnsSilent = (db
      .prepare(`SELECT COUNT(*) AS n FROM recall_ledger WHERE owner_kind = 'turn'${and}`)
      .get(...args) as { n: number }).n;
    const lines = tiers.reduce((n, t) => n + t.injected, 0);
    const turns = turnsInjected + turnsSilent;

    return {
      tiers, turnsInjected, turnsSilent, lines,
      linesPerTurn: turns > 0 ? lines / turns : null,
      silentTurnsPct: turns > 0 ? (100 * turnsSilent) / turns : null,
      crossProjectLines: countCrossProjectLines(db, and, args),
    };
  } catch {
    return EMPTY;
  }
}

/** Injected rows whose owner's project conflicts with the project of the row's session. */
function countCrossProjectLines(db: DatabaseSync, and: string, args: string[]): number {
  const rows = db
    .prepare(
      `SELECT l.owner_id AS id, l.owner_kind AS kind, sp.project AS session_project, COUNT(*) AS n
         FROM recall_ledger l JOIN session_projects sp ON sp.session_key = l.session_key
        WHERE l.owner_kind IN ('fact','event')${and.replaceAll("session_key", "l.session_key").replaceAll("ts >=", "l.ts >=")}
        GROUP BY l.owner_id, l.owner_kind, sp.project`,
    )
    .all(...args) as Array<{ id: string; kind: string; session_project: string; n: number }>;
  if (rows.length === 0) return 0;
  const projects = ownerProjects(db, rows.map((r) => ({ owner_id: r.id, owner_kind: r.kind })));
  let cross = 0;
  for (const r of rows) {
    const info = projects.get(`${r.kind}:${r.id}`);
    if (info && !info.userLevel && projectsConflict(info.project, r.session_project)) cross += r.n;
  }
  return cross;
}
