/**
 * Project identity: the names a project uses for ITSELF, learned from its own memories.
 *
 * Recall scope is by where a conversation happened. Work on one product is often done
 * from another project's folder (Sinapsys fixed from a Sofia-AI session), so a scope by
 * place alone hides it. A memory from project Q is still about project P when it names
 * one of P's identity entities.
 *
 * Identity entities of P = `project`-type entities that
 *   - appear in at least MIN_SHARE of P's events (P talks about them a lot), and
 *   - are mentioned at least MIN_LIFT times more often inside P than in the rest of
 *     the memory (they are P's, not a shared library a big project mentions a lot),
 * plus the entity named exactly like P. No per-project configuration: works for any
 * project once it has a few memories. Measured live 05/10/2026: tencentdb-agent-memory
 * → Sinapsys; Sofia-AI → Sofia, Sofia AI; Tutor-Agent → TutorAI, Tutoragent-backend.
 */

import type { DatabaseSync } from "node:sqlite";

const MIN_MENTIONS = 3;
const MIN_SHARE = 0.03;
/** How many times more often P mentions it than the rest of the (project-tagged) memory. */
const MIN_LIFT = 4;
const MAX_IDENTITIES = 5;
const CACHE_MS = 30 * 60 * 1000;

/** Identities of EVERY project, computed together by one aggregate (~65 ms live, 05/10). */
let table: { byProject: Map<string, Set<string>>; atMs: number } | undefined;

/** For tests: forget the cached identities. */
export function clearProjectIdentityCache(): void {
  table = undefined;
}

/** Entity ids that identify `project` (recomputed every CACHE_MS). Empty on any error. */
export function projectIdentityIds(db: DatabaseSync, project: string, nowMs = Date.now()): Set<string> {
  const p = project.trim();
  if (p === "") return new Set();
  if (!table || nowMs - table.atMs >= CACHE_MS) {
    let byProject = new Map<string, Set<string>>();
    try {
      byProject = computeAll(db);
    } catch {
      /* best-effort: no identity means plain scope by place */
    }
    table = { byProject, atMs: nowMs };
  }
  return table.byProject.get(p) ?? new Set();
}

function computeAll(db: DatabaseSync): Map<string, Set<string>> {
  // Only project-tagged events count, on both sides: untagged chat imports talk about
  // every product and would make every identity look shared.
  const rows = db
    .prepare(
      `SELECT j.value AS eid, e.project AS p, COUNT(*) AS n
         FROM events e, json_each(e.entities_json) j
        WHERE e.project <> ''
        GROUP BY j.value, e.project`,
    )
    .all() as Array<{ eid: string; p: string; n: number }>;
  const eventsBy = new Map(
    (db.prepare("SELECT project AS p, COUNT(*) AS n FROM events WHERE project <> '' GROUP BY project").all() as Array<{ p: string; n: number }>)
      .map((r) => [r.p, r.n]),
  );
  const allTagged = [...eventsBy.values()].reduce((a, b) => a + b, 0);
  const mentions = new Map<string, number>();
  for (const r of rows) mentions.set(r.eid, (mentions.get(r.eid) ?? 0) + r.n);

  // One pass over project-type entities (a lookup per project scanned the table 175×: 1.2 s).
  const projectEntities = db
    .prepare("SELECT id, canonical_key AS k FROM entities WHERE type = 'project' AND merged_into IS NULL")
    .all() as Array<{ id: string; k: string }>;
  const isProjectEntity = new Set(projectEntities.map((e) => e.id));
  const byKey = new Map(projectEntities.map((e) => [e.k, e.id]));
  const byProject = new Map<string, Array<{ eid: string; n: number }>>();
  for (const r of rows) {
    const total = eventsBy.get(r.p) ?? 0;
    if (r.n < MIN_MENTIONS || total === 0 || r.n / total < MIN_SHARE) continue;
    const shareOut = ((mentions.get(r.eid) ?? r.n) - r.n) / Math.max(1, allTagged - total);
    if (r.n / total / Math.max(shareOut, 1e-6) < MIN_LIFT) continue;
    if (!isProjectEntity.has(r.eid)) continue;
    const list = byProject.get(r.p) ?? [];
    list.push({ eid: r.eid, n: r.n });
    byProject.set(r.p, list);
  }
  const out = new Map<string, Set<string>>();
  for (const p of eventsBy.keys()) {
    const ids = new Set(
      (byProject.get(p) ?? []).sort((a, b) => b.n - a.n).slice(0, MAX_IDENTITIES).map((c) => c.eid),
    );
    const self = byKey.get(`project:${p.toLowerCase()}`);
    if (self) ids.add(self);
    out.set(p, ids);
  }
  return out;
}

/**
 * Keys (`kind:id`) of the owners that name one of `identity`: an event through its
 * entities, a fact through its entity or the entities of the event it came from.
 */
export function ownersNamingIdentity(
  db: DatabaseSync,
  owners: ReadonlyArray<{ owner_id: string; owner_kind: string }>,
  identity: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  if (identity.size === 0 || owners.length === 0) return out;
  const names = (json: string | null | undefined): boolean => {
    try {
      const list = JSON.parse(json ?? "[]") as unknown;
      return Array.isArray(list) && list.some((x) => typeof x === "string" && identity.has(x));
    } catch {
      return false;
    }
  };
  const ev = db.prepare("SELECT entities_json AS j FROM events WHERE id = ?");
  const fact = db.prepare(
    "SELECT f.entity_id AS eid, e.entities_json AS j FROM facts f LEFT JOIN events e ON e.id = f.source_event_id WHERE f.id = ?",
  );
  for (const o of owners) {
    if (o.owner_kind === "event") {
      const r = ev.get(o.owner_id) as { j: string } | undefined;
      if (r && names(r.j)) out.add(`event:${o.owner_id}`);
    } else if (o.owner_kind === "fact") {
      const r = fact.get(o.owner_id) as { eid: string | null; j: string | null } | undefined;
      if (r && ((r.eid && identity.has(r.eid)) || names(r.j))) out.add(`fact:${o.owner_id}`);
    }
  }
  return out;
}
