/**
 * The recall ledger — what memory actually PUT in front of the agent, and
 * whether the agent then used it.
 *
 * One row per memory injected into a turn. Written at recall time (unjudged),
 * settled at capture time by recall-usage.ts. Two numbers come out of it that
 * Sinapsys has never had:
 *
 *   - how much it pushes per turn;
 *   - how much of that ever shows up in the work.
 *
 * DB access lives here so the store stays a thin delegator and the logic is
 * testable against an in-memory database. Never throws on the recall path: a
 * bookkeeping failure must not cost a turn.
 */

import type { DatabaseSync } from "node:sqlite";
import { ulidLike } from "./kb-queries.js";
import { judgeTurn, type TurnVerdict } from "./recall-usage.js";

const TAG = "[recall-ledger]";

/** Bound on rows written per turn — recall injects a handful, not hundreds. */
export const MAX_LEDGER_ROWS_PER_TURN = 25;

/**
 * Only judge rows from the recent past. A capture can arrive long after the
 * recall that produced it (a session left open overnight); judging a two-day-old
 * injection against today's reply would be noise, so those are retired unjudged.
 */
export const JUDGE_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface LedgerInjection {
  ownerId: string;
  ownerKind: string;
  score: number;
  associative: boolean;
  memoryText: string;
}

export interface RecordInjectionsParams {
  sessionKey: string;
  sessionId?: string;
  namespace?: string;
  now: string;
  injections: ReadonlyArray<LedgerInjection>;
}

/** Insert the unjudged rows for one turn. Returns how many were written. */
export function recordInjections(db: DatabaseSync, params: RecordInjectionsParams): number {
  const rows = params.injections.slice(0, MAX_LEDGER_ROWS_PER_TURN);
  if (rows.length === 0) return 0;
  try {
    const stmt = db.prepare(
      `INSERT INTO recall_ledger
         (id, ts, session_key, session_id, owner_id, owner_kind, score, associative, memory_text, namespace)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let written = 0;
    for (const r of rows) {
      if (!r.ownerId) continue;
      stmt.run(
        ulidLike("rl"),
        params.now,
        params.sessionKey,
        params.sessionId ?? "",
        r.ownerId,
        r.ownerKind,
        r.score,
        r.associative ? 1 : 0,
        r.memoryText.slice(0, 2000),
        params.namespace ?? "default",
      );
      written++;
    }
    return written;
  } catch {
    // Bookkeeping must never break recall.
    return 0;
  }
}

export interface JudgePendingParams {
  sessionKey: string;
  userText: string;
  assistantText: string;
  now: string;
  /** Rows older than this many ms are retired unjudged (default JUDGE_WINDOW_MS). */
  windowMs?: number;
}

export interface JudgePendingResult extends TurnVerdict {
  /** Rows retired because they were older than the window. */
  expired: number;
}

/**
 * Settle every pending row for a session against the turn that just happened.
 * Wrapped in one transaction so a crash cannot leave half a turn scored.
 */
export function judgePending(
  db: DatabaseSync,
  params: JudgePendingParams,
  logger?: { warn?(msg: string): void },
): JudgePendingResult {
  const empty: JudgePendingResult = {
    injected: 0, used: 0, unjudgeable: 0, perMemory: [], expired: 0,
  };
  try {
    const pending = db
      .prepare(
        `SELECT id, owner_id, memory_text, ts FROM recall_ledger
          WHERE session_key = ? AND judged = 0 ORDER BY ts ASC`,
      )
      .all(params.sessionKey) as Array<{
        id: string;
        owner_id: string;
        memory_text: string;
        ts: string;
      }>;
    if (pending.length === 0) return empty;

    const cutoff = Date.parse(params.now) - (params.windowMs ?? JUDGE_WINDOW_MS);
    const fresh: typeof pending = [];
    const expiredIds: string[] = [];
    for (const row of pending) {
      const t = Date.parse(row.ts);
      if (Number.isFinite(t) && t < cutoff) expiredIds.push(row.id);
      else fresh.push(row);
    }

    const verdict = judgeTurn(
      fresh.map((r) => ({ ownerId: r.owner_id, memoryText: r.memory_text })),
      params.userText,
      params.assistantText,
    );

    const byOwner = new Map(verdict.perMemory.map((m) => [m.ownerId, m]));
    const update = db.prepare(
      `UPDATE recall_ledger
          SET judged = 1, used = ?, unjudgeable = ?, matched_json = ?, judged_at = ?
        WHERE id = ?`,
    );
    // Expired rows leave the queue without ever being counted against memory.
    const retire = db.prepare(
      `UPDATE recall_ledger SET judged = 1, unjudgeable = 1, judged_at = ? WHERE id = ?`,
    );
    const begin = db.prepare("BEGIN");
    const commit = db.prepare("COMMIT");
    const rollback = db.prepare("ROLLBACK");

    begin.run();
    try {
      for (const row of fresh) {
        const m = byOwner.get(row.owner_id);
        update.run(
          m?.used ? 1 : 0,
          m?.unjudgeable ? 1 : 0,
          JSON.stringify(m?.matchedTokens ?? []),
          params.now,
          row.id,
        );
      }
      for (const id of expiredIds) retire.run(params.now, id);
      commit.run();
    } catch (err) {
      try {
        rollback.run();
      } catch {
        /* ignore */
      }
      throw err;
    }

    return { ...verdict, expired: expiredIds.length };
  } catch (err) {
    logger?.warn?.(
      `${TAG} judgePending failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return empty;
  }
}

export interface VerdictRow {
  ownerId: string;
  ownerKind: string;
  injections: number;
  uses: number;
  lastText: string;
}

export interface RecallVerdict {
  /** Rows judged so far — the only ones that can carry a conclusion. */
  judged: number;
  used: number;
  unjudgeable: number;
  /** Injected but still awaiting a turn to be judged against. */
  pending: number;
  /** Injected, judged, judgeable, and never used: the noise. */
  noise: number;
  /** Share of judgeable injections that were used; null when nothing is judgeable. */
  usefulness: number | null;
  /** The memories that earn their place, best first. */
  topUsed: VerdictRow[];
  /** The memories that keep being injected and never land, worst first. */
  topNoise: VerdictRow[];
}

export interface ReadVerdictParams {
  sessionKey?: string;
  /** ISO lower bound on injection time. */
  sinceTs?: string;
  limit?: number;
}

/** Aggregate the ledger into a verdict. Read-only; never throws. */
export function readVerdict(db: DatabaseSync, params: ReadVerdictParams = {}): RecallVerdict {
  const empty: RecallVerdict = {
    judged: 0, used: 0, unjudgeable: 0, pending: 0, noise: 0,
    usefulness: null, topUsed: [], topNoise: [],
  };
  try {
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.sessionKey) { where.push("session_key = ?"); args.push(params.sessionKey); }
    if (params.sinceTs) { where.push("ts >= ?"); args.push(params.sinceTs); }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const totals = db
      .prepare(
        `SELECT
           COALESCE(SUM(judged), 0) AS judged,
           COALESCE(SUM(used), 0) AS used,
           COALESCE(SUM(unjudgeable), 0) AS unjudgeable,
           COALESCE(SUM(CASE WHEN judged = 0 THEN 1 ELSE 0 END), 0) AS pending
         FROM recall_ledger ${clause}`,
      )
      .get(...(args as never[])) as {
        judged: number; used: number; unjudgeable: number; pending: number;
      };

    const judged = totals?.judged ?? 0;
    const used = totals?.used ?? 0;
    const unjudgeable = totals?.unjudgeable ?? 0;
    const pending = totals?.pending ?? 0;
    // Only judgeable rows can support a conclusion: a memory that merely
    // repeated the user's own words was never given a chance to be useful.
    const judgeable = judged - unjudgeable;
    const noise = Math.max(0, judgeable - used);

    const limit = params.limit ?? 5;
    const group = (order: string) =>
      db
        .prepare(
          `SELECT owner_id, owner_kind, COUNT(*) AS injections,
                  COALESCE(SUM(used), 0) AS uses, MAX(memory_text) AS last_text
             FROM recall_ledger ${clause}
            GROUP BY owner_id, owner_kind
           HAVING SUM(judged) > 0 AND SUM(unjudgeable) < COUNT(*)
            ORDER BY ${order}
            LIMIT ?`,
        )
        .all(...([...args, limit] as never[])) as Array<{
          owner_id: string; owner_kind: string;
          injections: number; uses: number; last_text: string;
        }>;

    const toRow = (r: {
      owner_id: string; owner_kind: string; injections: number; uses: number; last_text: string;
    }): VerdictRow => ({
      ownerId: r.owner_id,
      ownerKind: r.owner_kind,
      injections: r.injections,
      uses: r.uses ?? 0,
      lastText: r.last_text ?? "",
    });

    return {
      judged, used, unjudgeable, pending, noise,
      usefulness: judgeable > 0 ? used / judgeable : null,
      topUsed: group("uses DESC, injections DESC").filter((r) => (r.uses ?? 0) > 0).map(toRow),
      topNoise: group("(injections - uses) DESC, injections DESC")
        .filter((r) => (r.uses ?? 0) === 0)
        .map(toRow),
    };
  } catch {
    return empty;
  }
}
