/**
 * Entity merge PLAN — Consolidation Cura #2, Phase 2b runner support (pure).
 *
 * WHAT: turn detected clusters (from entity-reconciliation.buildClusters) into a
 * human-editable Markdown REVIEW REPORT, and parse that (possibly edited) report
 * back into concrete merge plans. This is the Grounded-Trust seam: Lorenzo reads
 * the report, keeps/edits/rejects, and only then does the runner mutate.
 *
 * WHY separate + pure: the standalone runner stays thin and side-effectful (DB +
 * files); ALL the report format + decision logic lives here, fully unit-testable
 * with no DB.
 *
 * EDIT MODEL (single mechanism, no ambiguity):
 *   - Each cluster has a `decision: OK | NO` line (NO = don't merge; safe default
 *     for ASK clusters).
 *   - Each member line is tagged `keep` (the canonical — exactly one), `merge`
 *     (fold into the canonical), or `exclude` (a stranger — leave it out).
 *   AUTO clusters (score ≥ auto threshold) are pre-decided OK; a first live run
 *   can apply ONLY those via `autoOnly`.
 */

import type { EntityCluster } from "./entity-reconciliation.js";
import { pickCanonical, type MergePlan, type CanonicalCandidate } from "./entity-merge.js";

export interface EntityMeta {
  name: string;
  type: string;
  /** HEAD facts owned by this entity (drives canonical pick + review signal). */
  factCount: number;
  importance: number;
  /** ISO created_time (tie-breaker in canonical pick). */
  createdTime: string;
}

export type Decision = "OK" | "NO";
export type MemberTag = "keep" | "merge" | "exclude";

export interface ParsedCluster {
  clusterId: string;
  band: "auto" | "ask";
  decision: Decision;
  canonicalId: string;
  /** members tagged `merge` (to fold into canonical). */
  satelliteIds: string[];
  /** members tagged `exclude` (left out of the merge). */
  excludedIds: string[];
}

// ── canonical pick ──────────────────────────────────────────────────────────

/** Pick the canonical (keep) member of a cluster via the shared deterministic rule. */
export function pickKeep(members: string[], meta: Map<string, EntityMeta>): string {
  const candidates: CanonicalCandidate[] = members.map((id) => {
    const m = meta.get(id);
    return {
      id,
      importance: m?.importance ?? 0,
      factCount: m?.factCount ?? 0,
      createdTime: m?.createdTime ?? "",
    };
  });
  return pickCanonical(candidates);
}

// ── render ──────────────────────────────────────────────────────────────────

export interface RenderInput {
  clusters: EntityCluster[];
  meta: Map<string, EntityMeta>;
  /** How many ASK clusters to include (biggest first). Auto clusters are all included. */
  topAsk: number;
  totals: { entities: number; entitiesWithVector: number };
  generatedAt: string;
}

function memberLine(tag: MemberTag, id: string, meta: Map<string, EntityMeta>): string {
  const m = meta.get(id);
  const facts = m?.factCount ?? 0;
  const imp = m?.importance ?? 0;
  const name = JSON.stringify(m?.name ?? id);
  // Pad the tag so columns line up for a human reader; the parser trims.
  return `  ${tag.padEnd(7)} ${id}  facts=${facts} imp=${imp}  ${name}`;
}

function renderCluster(c: EntityCluster, meta: Map<string, EntityMeta>): string {
  const keep = pickKeep(c.members, meta);
  const band = c.band === "auto" ? "AUTO" : "ASK";
  const others = c.members
    .filter((id) => id !== keep)
    .sort((a, b) => (meta.get(b)?.factCount ?? 0) - (meta.get(a)?.factCount ?? 0) || (a < b ? -1 : 1));
  const lines: string[] = [];
  lines.push(
    `### cluster=${c.members[0]} type=${c.type} n=${c.size} score=${c.minScore.toFixed(2)}-${c.maxScore.toFixed(2)} [${band}]`,
  );
  lines.push(`decision: OK`);
  lines.push(memberLine("keep", keep, meta));
  for (const id of others) lines.push(memberLine("merge", id, meta));
  return lines.join("\n");
}

/** Render the full editable Markdown report. Deterministic given inputs. */
export function renderReport(input: RenderInput): string {
  const { clusters, meta, topAsk, totals, generatedAt } = input;
  const auto = clusters.filter((c) => c.band === "auto");
  const ask = clusters
    .filter((c) => c.band === "ask")
    .sort((a, b) => b.size - a.size || b.maxScore - a.maxScore || (a.members[0] < b.members[0] ? -1 : 1));
  const askShown = ask.slice(0, Math.max(0, topAsk));
  const autoEntities = auto.reduce((s, c) => s + c.size, 0);
  const askEntities = ask.reduce((s, c) => s + c.size, 0);

  const out: string[] = [];
  out.push(`# Entity Reconciliation — Review Report`);
  out.push(`# generated: ${generatedAt}`);
  out.push(`#`);
  out.push(`# HOW TO EDIT (ASK clusters only — AUTO apply as-is):`);
  out.push(`#   decision: OK  → merge the 'merge' members into the 'keep' member`);
  out.push(`#   decision: NO  → do not merge this cluster (default; safe)`);
  out.push(`#   per member line, set the tag:`);
  out.push(`#     keep    → the surviving canonical entity (exactly ONE per cluster)`);
  out.push(`#     merge   → fold this entity into 'keep'`);
  out.push(`#     exclude → a stranger; leave it separate (your "togli membro")`);
  out.push(`#   To keep a DIFFERENT entity, move the 'keep' tag to its line.`);
  out.push(`#   Do NOT change AUTO clusters. Lines starting with '#' are ignored.`);
  out.push(``);
  out.push(`## Summary`);
  out.push(`# entities: ${totals.entities} (with vector: ${totals.entitiesWithVector})`);
  out.push(`# AUTO clusters (apply as-is): ${auto.length} (${autoEntities} entities)`);
  out.push(`# ASK clusters (your decision): ${ask.length} (${askEntities} entities) — showing top ${askShown.length}`);
  out.push(``);
  out.push(`## AUTO clusters (${auto.length}) — applied automatically; listed for transparency`);
  out.push(``);
  for (const c of auto) {
    out.push(renderCluster(c, meta));
    out.push(``);
  }
  out.push(`## ASK clusters — top ${askShown.length} of ${ask.length} (set decision: OK to merge)`);
  out.push(``);
  for (const c of askShown) {
    // ASK clusters default to NO (safe): only merge what Lorenzo approves.
    out.push(renderCluster(c, meta).replace("decision: OK", "decision: NO"));
    out.push(``);
  }
  return out.join("\n");
}

// ── parse ───────────────────────────────────────────────────────────────────

const HEADER_RE = /^###\s+cluster=(\S+)\s+.*\[(AUTO|ASK)\]\s*$/;
const DECISION_RE = /^decision:\s*(OK|NO)\s*$/i;
const MEMBER_RE = /^(keep|merge|exclude)\s+(\S+)\b/;

/**
 * Parse an (edited) Markdown report into ParsedCluster[]. Tolerant of blank
 * lines and '#' comments. Fail-loud on structurally invalid clusters (a decided
 * cluster with ≠1 keep, or OK with zero merge members) — never silently drops.
 * Uses String.match (not RegExp.exec) to dodge the child_process.exec lint.
 */
export function parseReport(markdown: string): ParsedCluster[] {
  const lines = markdown.split(/\r?\n/);
  const clusters: ParsedCluster[] = [];

  let cur: {
    clusterId: string;
    band: "auto" | "ask";
    decision: Decision;
    keeps: string[];
    merges: string[];
    excludes: string[];
  } | null = null;

  const flush = () => {
    if (!cur) return;
    if (cur.decision === "OK") {
      if (cur.keeps.length !== 1) {
        throw new Error(
          `Cluster ${cur.clusterId}: decision OK requires exactly one 'keep' (found ${cur.keeps.length}).`,
        );
      }
      if (cur.merges.length === 0) {
        throw new Error(`Cluster ${cur.clusterId}: decision OK but no 'merge' members — nothing to merge.`);
      }
      if (cur.merges.includes(cur.keeps[0])) {
        throw new Error(`Cluster ${cur.clusterId}: the 'keep' entity also tagged 'merge'.`);
      }
      clusters.push({
        clusterId: cur.clusterId,
        band: cur.band,
        decision: "OK",
        canonicalId: cur.keeps[0],
        satelliteIds: [...new Set(cur.merges)],
        excludedIds: [...new Set(cur.excludes)],
      });
    } else {
      clusters.push({
        clusterId: cur.clusterId,
        band: cur.band,
        decision: "NO",
        canonicalId: cur.keeps[0] ?? "",
        satelliteIds: [],
        excludedIds: [...new Set(cur.excludes)],
      });
    }
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    // Cluster header FIRST (it starts with '###', which the comment/section
    // skips below would otherwise swallow).
    const h = line.match(HEADER_RE);
    if (h) {
      flush();
      cur = {
        clusterId: h[1],
        band: h[2] === "AUTO" ? "auto" : "ask",
        decision: "NO",
        keeps: [],
        merges: [],
        excludes: [],
      };
      continue;
    }
    // Comments / section headers (## ...) — ignored.
    if (line.startsWith("#")) continue;
    if (!cur) continue;

    const d = line.match(DECISION_RE);
    if (d) {
      cur.decision = d[1].toUpperCase() === "OK" ? "OK" : "NO";
      continue;
    }
    const m = line.match(MEMBER_RE);
    if (m) {
      const tag = m[1] as MemberTag;
      const id = m[2];
      if (tag === "keep") cur.keeps.push(id);
      else if (tag === "merge") cur.merges.push(id);
      else cur.excludes.push(id);
    }
  }
  flush();
  return clusters;
}

/**
 * Turn parsed clusters into concrete MergePlans. Only OK clusters produce a plan.
 * `autoOnly` restricts to AUTO clusters (the safe first live run). Deterministic.
 */
export function toMergePlans(parsed: ParsedCluster[], opts: { autoOnly: boolean }): MergePlan[] {
  return parsed
    .filter((c) => c.decision === "OK")
    .filter((c) => (opts.autoOnly ? c.band === "auto" : true))
    .filter((c) => c.satelliteIds.length > 0)
    .map((c) => ({ canonicalId: c.canonicalId, satelliteIds: c.satelliteIds }));
}
