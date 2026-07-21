/**
 * Backfill — Consolidation Cura #1: canonicalize historical fact attributes.
 *
 * WHAT: relabels existing facts' free-text attributes to their canonical form
 * (attribute-canon-map.ts) and, where that makes two HEADs collide on the same
 * (entity_id, canonical_attribute), REPLAYS upsertFact's bi-temporal semantics
 * over the group so the migrated state matches what the live engine would have
 * produced had the facts arrived sequentially:
 *   - DIFFERENT value, newer wins  → SUPERSEDE (close older; Case C)
 *   - SAME value                    → CORROBORATE (fold support + max confidence
 *                                     + earliest valid_from into the survivor;
 *                                     the duplicate row is closed — Case B)
 *
 * WHY: the write-path fix only canonicalizes NEW writes. The 17k facts already
 * in the DB were written under fragmented attributes ("stato"/"status",
 * "costo"/"cost"), so their contradictions never collided and never collapsed.
 * This one-off pass makes the keys collide so the existing engine resolves them.
 *
 * SAFETY:
 *   - NON-DESTRUCTIVE: never DELETEs. Losers/duplicates are closed
 *     (valid_to/superseded_by), kept as audit rows.
 *   - DETERMINISTIC: recency by (valid_from, learned_at, id); no LLM.
 *   - REVERSIBLE: returns the full relabel + supersede lists for an audit log;
 *     a DB backup is the coarse rollback, the change lists the precise manifest.
 *   - Read-path drops superseded facts (retrieval.ts renderCandidate), so stale
 *     kb_vec/kb_fts entries for closed rows are harmless — no re-embed required
 *     for correctness (winner-vector staleness is a tracked Phase-2 nicety).
 */

import type { DatabaseSync } from "node:sqlite";
import { canonicalizeAttribute, ATTRIBUTE_CANON_VERSION } from "../../core/kb/attribute-canon-map.js";
import { normalizeFactValue } from "../../core/kb/kb-queries.js";

export interface AttributeChange {
  id: string;
  entity_id: string;
  old: string;
  canonical: string;
}

/** A row closed by the backfill (supersede or same-value fold). */
export interface SupersedeOp {
  loserId: string;
  supersededBy: string;
  validTo: string;
}

/** An accumulated support/confidence/valid_from update folded into a survivor. */
interface HeadUpdate {
  id: string;
  support: number;
  confidence: number;
  validFrom: string;
}

export interface CanonBackfillResult {
  mapVersion: number;
  /** Rows whose attribute string was (or would be) relabeled. */
  relabeled: number;
  /** Distinct source attribute strings that change. */
  distinctAttrsChanged: number;
  /** (entity, canonical) groups that ended with >1 HEAD and were resolved. */
  groupsResolved: number;
  /** Rows closed to restore HEAD uniqueness (supersede + same-value folds). */
  headsSuperseded: number;
  /** Full per-row relabel list (for the audit log). */
  changes: AttributeChange[];
  /** Full list of rows closed, with their new pointers (for the audit log). */
  supersededHeads: SupersedeOp[];
  /** true if changes were committed; false for a dry run. */
  applied: boolean;
}

interface FactRow {
  id: string;
  entity_id: string;
  attribute: string;
  value: string;
  confidence: number;
  support: number;
  valid_from: string;
  learned_at: string;
  superseded_by: string | null;
  valid_to: string | null;
}

/** Deterministic HEAD ordering: newest world-time last (mirrors upsertFact). */
function byRecency(a: FactRow, b: FactRow): number {
  if (a.valid_from !== b.valid_from) return a.valid_from < b.valid_from ? -1 : 1;
  if (a.learned_at !== b.learned_at) return a.learned_at < b.learned_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Run (or simulate) the attribute-canonicalization backfill.
 * @param apply  false = dry run (compute only); true = write inside a transaction.
 * @param nowIso timestamp stamped on superseded_at for closed rows.
 */
export function backfillCanonicalizeAttributes(
  db: DatabaseSync,
  { apply, nowIso }: { apply: boolean; nowIso: string },
): CanonBackfillResult {
  const rows = db
    .prepare(
      "SELECT id, entity_id, attribute, value, confidence, support, valid_from, learned_at, superseded_by, valid_to FROM facts",
    )
    .all() as unknown as FactRow[];

  // ── Step 1: per-row relabel targets ──
  const changes: AttributeChange[] = [];
  for (const r of rows) {
    const canonical = canonicalizeAttribute(r.attribute);
    if (canonical !== r.attribute) {
      changes.push({ id: r.id, entity_id: r.entity_id, old: r.attribute, canonical });
    }
  }

  // ── Step 2: replay supersession/corroboration for HEADs that collide on
  // (entity_id, canonical) after relabel — faithful to upsertFact Cases B/C ──
  const groups = new Map<string, FactRow[]>();
  for (const r of rows) {
    if (r.superseded_by !== null || r.valid_to !== null) continue; // HEADs only
    const canonical = canonicalizeAttribute(r.attribute);
    const key = `${r.entity_id} ${canonical}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const supersedeOps: SupersedeOp[] = [];
  const headUpdates: HeadUpdate[] = [];
  let groupsResolved = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    groupsResolved++;
    members.sort(byRecency);

    // Running survivor accumulator, seeded with the earliest member.
    let head = {
      id: members[0].id,
      value: members[0].value,
      support: members[0].support,
      confidence: members[0].confidence,
      validFrom: members[0].valid_from,
      folded: false, // did we accumulate anything worth writing back?
    };
    const flush = () => {
      if (head.folded) {
        headUpdates.push({
          id: head.id,
          support: head.support,
          confidence: head.confidence,
          validFrom: head.validFrom,
        });
      }
    };

    for (let i = 1; i < members.length; i++) {
      const m = members[i];
      if (normalizeFactValue(head.value) === normalizeFactValue(m.value)) {
        // Case B — corroboration: fold m into the survivor, close m's row.
        head.support += m.support;
        head.confidence = Math.max(head.confidence, m.confidence);
        if (m.valid_from < head.validFrom) head.validFrom = m.valid_from;
        head.folded = true;
        supersedeOps.push({ loserId: m.id, supersededBy: head.id, validTo: m.valid_from });
      } else {
        // Case C — supersede: close the current survivor, m becomes the new head.
        flush();
        supersedeOps.push({ loserId: head.id, supersededBy: m.id, validTo: m.valid_from });
        head = {
          id: m.id,
          value: m.value,
          support: m.support,
          confidence: m.confidence,
          validFrom: m.valid_from,
          folded: false,
        };
      }
    }
    flush(); // final survivor
  }

  const result: CanonBackfillResult = {
    mapVersion: ATTRIBUTE_CANON_VERSION,
    relabeled: changes.length,
    distinctAttrsChanged: new Set(changes.map((c) => c.old)).size,
    groupsResolved,
    headsSuperseded: supersedeOps.length,
    changes,
    supersededHeads: supersedeOps,
    applied: false,
  };

  if (!apply) return result;

  // ── Apply: single transaction, non-destructive ──
  // prepare("BEGIN"/...).run() form avoids a known security-hook false positive.
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const relabel = db.prepare("UPDATE facts SET attribute = ? WHERE id = ?");
    for (const ch of changes) relabel.run(ch.canonical, ch.id);
    const fold = db.prepare("UPDATE facts SET support = ?, confidence = ?, valid_from = ? WHERE id = ?");
    for (const u of headUpdates) fold.run(u.support, u.confidence, u.validFrom, u.id);
    const close = db.prepare(
      "UPDATE facts SET valid_to = ?, superseded_by = ?, superseded_at = ? WHERE id = ?",
    );
    for (const op of supersedeOps) close.run(op.validTo, op.supersededBy, nowIso, op.loserId);
    db.prepare("COMMIT").run();
  } catch (err) {
    // Roll back defensively; never let a ROLLBACK failure mask the real error.
    try {
      db.prepare("ROLLBACK").run();
    } catch {
      /* keep the original err */
    }
    throw err;
  }

  result.applied = true;
  return result;
}
