/**
 * Project of an untagged session, inferred from what its memories talk about.
 *
 * Measured live 05/10/2026: 10.829 of 28.388 events (38%) have no project — imported
 * claude.ai chats and early sessions. "No project" meant "user-level, shown in every
 * project", so a Sofia call-handling rule ("se il caller è un known_client…") was
 * injected into a Sinapsys session.
 *
 * A single event says too little, a whole conversation says a lot. Each entity votes
 * for the project it clearly belongs to (≥ MIN_ENTITY_SHARE of its project-tagged
 * mentions, ≥ MIN_ENTITY_LIFT × that project's base rate); a session gets the winning
 * project when the votes are strong (≥ MIN_VOTES) and clear (≥ MIN_MARGIN × runner-up).
 * Live: 178 of 658 untagged sessions decided (6.537 events), 15/15 right on a random
 * sample, ~150 ms per rebuild. No per-project configuration: any project with tagged
 * memories teaches its own vocabulary.
 */

import type { DatabaseSync } from "node:sqlite";

const MIN_ENTITY_MENTIONS = 3;
const MIN_ENTITY_SHARE = 0.6;
const MIN_ENTITY_LIFT = 2;
const MIN_VOTES = 2;
const MIN_MARGIN = 3;
const CACHE_MS = 30 * 60 * 1000;

let table: { bySession: Map<string, string>; atMs: number } | undefined;

/** For tests: forget the cached inference. */
export function clearSessionProjectCache(): void {
  table = undefined;
}

/** Inferred project of an untagged session, or "" when the evidence is weak. */
export function inferredSessionProject(db: DatabaseSync, sessionKey: string | null | undefined, nowMs = Date.now()): string {
  if (!sessionKey) return "";
  if (!table || nowMs - table.atMs >= CACHE_MS) {
    let bySession = new Map<string, string>();
    try {
      bySession = inferAll(db);
    } catch {
      /* best-effort: no inference means the old "user-level" behaviour */
    }
    table = { bySession, atMs: nowMs };
  }
  return table.bySession.get(sessionKey) ?? "";
}

/** The project each entity clearly belongs to, learned from project-tagged events. */
function entityOwners(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT j.value AS eid, e.project AS p, COUNT(*) AS n
         FROM events e, json_each(e.entities_json) j
        WHERE TRIM(e.project) <> ''
        GROUP BY j.value, e.project`,
    )
    .all() as Array<{ eid: string; p: string; n: number }>;
  const perEntity = new Map<string, Array<{ p: string; n: number }>>();
  for (const r of rows) {
    const list = perEntity.get(r.eid) ?? [];
    list.push({ p: r.p, n: r.n });
    perEntity.set(r.eid, list);
  }
  const projectTotals = new Map<string, number>();
  for (const r of rows) projectTotals.set(r.p, (projectTotals.get(r.p) ?? 0) + r.n);
  const all = [...projectTotals.values()].reduce((a, b) => a + b, 0);
  const out = new Map<string, string>();
  for (const [eid, list] of perEntity) {
    const total = list.reduce((a, b) => a + b.n, 0);
    if (total < MIN_ENTITY_MENTIONS) continue;
    const top = list.reduce((a, b) => (b.n > a.n ? b : a));
    const share = top.n / total;
    const base = (projectTotals.get(top.p) ?? 0) / Math.max(1, all);
    if (share >= MIN_ENTITY_SHARE && share / Math.max(base, 1e-6) >= MIN_ENTITY_LIFT) out.set(eid, top.p);
  }
  return out;
}

function inferAll(db: DatabaseSync): Map<string, string> {
  const owners = entityOwners(db);
  const votes = new Map<string, Map<string, number>>();
  const rows = db
    .prepare(`SELECT session_key AS k, entities_json AS j FROM events WHERE TRIM(project) = ''`)
    .all() as Array<{ k: string; j: string }>;
  for (const r of rows) {
    let ids: unknown;
    try {
      ids = JSON.parse(r.j);
    } catch {
      continue;
    }
    if (!Array.isArray(ids)) continue;
    for (const eid of ids) {
      const p = typeof eid === "string" ? owners.get(eid) : undefined;
      if (!p) continue;
      const v = votes.get(r.k) ?? new Map<string, number>();
      v.set(p, (v.get(p) ?? 0) + 1);
      votes.set(r.k, v);
    }
  }
  const out = new Map<string, string>();
  for (const [k, v] of votes) {
    const sorted = [...v].sort((a, b) => b[1] - a[1]);
    const [p, top] = sorted[0]!;
    const second = sorted[1]?.[1] ?? 0;
    if (top >= MIN_VOTES && top >= MIN_MARGIN * second) out.set(k, p);
  }
  return out;
}
