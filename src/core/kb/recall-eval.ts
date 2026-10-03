/**
 * Offline recall evaluation against the recall ledger — the pure pieces.
 *
 * The ledger (recall-ledger.ts) holds every memory recall put in front of the agent
 * since 23/08 with a deterministic USED / noise verdict (recall-usage.ts). That is a
 * ground truth nobody has to trust: for a past prompt we know which of the memories
 * shown were used and which were ignored. tools/recall-eval.mts replays those prompts
 * through the current recall path and scores the result here:
 *
 *   - recall of USED owners: of the memories the agent historically used for this
 *     prompt, how many does the path return now;
 *   - precision vs labeled owners: of the returned memories that carry a historical
 *     verdict, how many were used (unlabeled returns are unknown, not wrong);
 *   - silent rate, lines per turn, cross-project lines, latency.
 *
 * Everything here is deterministic and free of I/O so the scoring itself is tested.
 */

/** Prefixes of user "prompts" produced by the harness, not typed by a person. */
const MACHINE_PREFIXES = [
  "<task-notification>",
  "another claude session sent a message",
  "<command-",
  "<local-command",
  "<system-reminder>",
  "caveat:",
  "[request interrupted",
  "this session is being continued",
  "base directory for this skill",
];

/** True when a user "prompt" was produced by the harness (same rule as build-replay-set). */
export function isMachinePrompt(text: string): boolean {
  const head = text.trimStart().toLowerCase();
  if (MACHINE_PREFIXES.some((p) => head.startsWith(p))) return true;
  if (head.startsWith("<") && /^<[a-z-]+[ >]/.test(head)) return true;
  return false;
}

/** 32-bit FNV-1a of a string (stable across runs and platforms). */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic train / holdout assignment of a query key (a fraction `holdout` goes to
 * holdout). Salted differently from the sampling order: with the same hash, a capped
 * sample (the lowest hashes) would land entirely in holdout.
 */
export function splitOf(key: string, seed: number, holdout: number): "train" | "holdout" {
  return fnv1a(`split:${seed}:${key}`) / 0x1_0000_0000 < holdout ? "holdout" : "train";
}

/**
 * At most `perProject` items per project, chosen by a seeded hash order (not by
 * position, so a burst of similar prompts in one session is not over-represented).
 * Projects with fewer than `minPerProject` items are dropped. Returns a new array
 * ordered by project then hash.
 */
export function stratifiedSample<T>(
  items: readonly T[],
  projectOf: (t: T) => string,
  keyOf: (t: T) => string,
  opts: { perProject: number; minPerProject: number; seed: number },
): T[] {
  const byProject = new Map<string, T[]>();
  for (const it of items) {
    const p = projectOf(it);
    const list = byProject.get(p) ?? [];
    list.push(it);
    byProject.set(p, list);
  }
  const out: T[] = [];
  for (const p of [...byProject.keys()].sort()) {
    const list = byProject.get(p)!;
    if (list.length < opts.minPerProject) continue;
    const ranked = list
      .map((t) => ({ t, h: fnv1a(`${opts.seed}:${keyOf(t)}`) }))
      .sort((a, b) => a.h - b.h)
      .slice(0, opts.perProject)
      .map((x) => x.t);
    out.push(...ranked);
  }
  return out;
}

/** One historically-judged prompt: what was shown then, and which of it was used. */
export interface LabeledQuery {
  key: string;
  project: string;
  query: string;
  /** Earliest recall time of this prompt (ms): memories created later did not exist yet. */
  atMs: number;
  /** "kind:id" → true when the agent used it, false when it was judged noise. */
  labels: Map<string, boolean>;
  /** The agent's replies on the turns this prompt was sent (for the counterfactual judge). */
  replies?: string[];
  /** Claude Code conversation ids the prompt was sent in. */
  conversationIds?: string[];
}

export interface QueryScore {
  returned: number;
  /** Returned owners that carry a historical verdict. */
  labeledReturned: number;
  /** Returned owners that were historically used. */
  usedReturned: number;
  /** Owners historically used for this prompt. */
  used: number;
  /**
   * Used owners that recall is ALLOWED to show here: not labeled with another project
   * (0 cross-project lines is a hard rail, so another project's memory can never count).
   */
  usedEligible: number;
  usedEligibleReturned: number;
  /**
   * Returned owners (labeled or not) that the usage judge marks as used against the
   * prompt and the reply the agent actually gave. The ledger's labels ARE this judge's
   * verdicts on what legacy showed, so this extends the same verdict to memories legacy
   * never showed. Undefined when no reply is available.
   */
  judgedUsed?: number;
  crossProject: number;
  ms: number;
}

/** Score one replayed prompt against its labels. `returned` are "kind:id" keys. */
export function scoreQuery(
  returned: readonly string[],
  labels: ReadonlyMap<string, boolean>,
  extra: { crossProject: number; ms: number; eligibleUsed?: ReadonlySet<string>; judgedUsed?: number },
): QueryScore {
  const uniq = [...new Set(returned)];
  let labeledReturned = 0;
  let usedReturned = 0;
  for (const k of uniq) {
    const v = labels.get(k);
    if (v === undefined) continue;
    labeledReturned++;
    if (v) usedReturned++;
  }
  let used = 0;
  let usedEligible = 0;
  for (const [k, v] of labels) {
    if (!v) continue;
    used++;
    if (!extra.eligibleUsed || extra.eligibleUsed.has(k)) usedEligible++;
  }
  const usedEligibleReturned = uniq.filter((k) => labels.get(k) === true && (!extra.eligibleUsed || extra.eligibleUsed.has(k))).length;
  return {
    returned: uniq.length, labeledReturned, usedReturned, used, usedEligible, usedEligibleReturned,
    crossProject: extra.crossProject, ms: extra.ms,
    ...(extra.judgedUsed !== undefined ? { judgedUsed: extra.judgedUsed } : {}),
  };
}

export interface EvalSummary {
  queries: number;
  /** Σ usedReturned / Σ used (micro). */
  recallUsed: number;
  /** Σ usedEligibleReturned / Σ usedEligible: recall of the used owners recall may show here. */
  recallEligible: number;
  /** Prompts with ≥1 historically used owner that get at least one of them back. */
  turnRecall: number;
  /** Σ usedReturned / Σ labeledReturned (micro); null when nothing labeled was returned. */
  precision: number | null;
  /** Σ judgedUsed / Σ returned over prompts with a reply (counterfactual judge); null when none. */
  judgedPrecision: number | null;
  silentPct: number;
  linesPerTurn: number;
  crossProjectLines: number;
  p50Ms: number;
  p95Ms: number;
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

/** Aggregate per-prompt scores. */
export function summarize(scores: readonly QueryScore[]): EvalSummary {
  const sum = (f: (s: QueryScore) => number): number => scores.reduce((a, s) => a + f(s), 0);
  const used = sum((s) => s.used);
  const labeled = sum((s) => s.labeledReturned);
  const withUsed = scores.filter((s) => s.used > 0);
  const n = scores.length;
  const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;
  return {
    queries: n,
    recallUsed: used > 0 ? r4(sum((s) => s.usedReturned) / used) : 0,
    recallEligible: sum((s) => s.usedEligible) > 0 ? r4(sum((s) => s.usedEligibleReturned) / sum((s) => s.usedEligible)) : 0,
    turnRecall: withUsed.length > 0 ? r4(withUsed.filter((s) => s.usedReturned > 0).length / withUsed.length) : 0,
    precision: labeled > 0 ? r4(sum((s) => s.usedReturned) / labeled) : null,
    judgedPrecision: (() => {
      const judged = scores.filter((s) => s.judgedUsed !== undefined);
      const returned = judged.reduce((a, s) => a + s.returned, 0);
      return returned > 0 ? r4(judged.reduce((a, s) => a + (s.judgedUsed ?? 0), 0) / returned) : null;
    })(),
    silentPct: n > 0 ? Math.round((1000 * scores.filter((s) => s.returned === 0).length) / n) / 10 : 0,
    linesPerTurn: n > 0 ? Math.round((100 * sum((s) => s.returned)) / n) / 100 : 0,
    crossProjectLines: sum((s) => s.crossProject),
    p50Ms: Math.round(pct(scores.map((s) => s.ms), 0.5)),
    p95Ms: Math.round(pct(scores.map((s) => s.ms), 0.95)),
  };
}

/**
 * Point-in-time chronic noise: owners injected at least `minInjections` times BEFORE
 * `atMs`, all judged noise. Built once from the ledger so a replayed prompt is not
 * filtered with verdicts that came after it (that would leak the labels).
 */
export class ChronicNoiseTimeline {
  private readonly byOwner = new Map<string, Array<{ at: number; used: boolean }>>();

  constructor(rows: Iterable<{ key: string; atMs: number; used: boolean }>) {
    for (const r of rows) {
      const list = this.byOwner.get(r.key) ?? [];
      list.push({ at: r.atMs, used: r.used });
      this.byOwner.set(r.key, list);
    }
    for (const list of this.byOwner.values()) list.sort((a, b) => a.at - b.at);
  }

  keysAt(atMs: number, minInjections: number): Set<string> {
    const out = new Set<string>();
    for (const [key, list] of this.byOwner) {
      let n = 0;
      let used = false;
      for (const r of list) {
        if (r.at >= atMs) break;
        n++;
        if (r.used) {
          used = true;
          break;
        }
      }
      if (!used && n >= minInjections) out.add(key);
    }
    return out;
  }
}
