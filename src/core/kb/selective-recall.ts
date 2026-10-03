/**
 * Selective recall (Phase 3, "silent unless useful") — the pure building blocks.
 *
 * Measured on the live ledger: 6% of injected memories were used, 1.5% on the day of
 * the audit. Associative bare facts were 66% of the volume and 2.7% used. The cure is
 * not to remove the associative engine but to make it SELECTIVE: a memory is shown only
 * when the prompt names something distinctive it is about, associative items must be
 * strongly converged on, and a turn with nothing relevant gets nothing.
 *
 * Everything here is deterministic and free of I/O (the store-backed pieces take the
 * store as a parameter) so each rule is unit-testable on its own.
 */

import type { SelectiveRecallConfig } from "../../config.js";

/** Minimum length of a word that may count as evidence (matches the usage judge). */
export const MIN_EVIDENCE_TOKEN_LENGTH = 4;

/**
 * Words that carry no topic: conversational filler, auxiliaries, generic verbs, in the
 * two languages the prompts are written in. Deliberately NOT technical vocabulary — a
 * word like "gateway" is evidence in a coding project; the hub-entity rule handles
 * the words that are too common to discriminate.
 */
const FILLER = new Set([
  // Italian
  "ciao", "grazie", "prego", "favore", "piacere", "procedi", "procediamo", "continua", "continuare", "avanti", "adesso",
  "ancora", "allora", "quindi", "perche", "perché", "quando", "dove", "come", "cosa", "cose", "quale",
  "quali", "quanto", "quanti", "questo", "questa", "questi", "queste", "quello", "quella", "quelli",
  "sono", "siamo", "stato", "stata", "essere", "avere", "fare", "fatto", "fatti", "faccio", "fammi",
  "dimmi", "dire", "detto", "vedi", "vedere", "guarda", "controlla", "verifica", "verificare", "puoi",
  "puoi", "posso", "possiamo", "voglio", "vorrei", "devo", "dobbiamo", "bisogna", "serve", "servono",
  "anche", "altro", "altra", "altri", "altre", "tutto", "tutti", "tutte", "tutta", "molto", "poco",
  "solo", "sempre", "mai", "prima", "dopo", "poi", "senza", "della", "dello", "delle", "degli", "dall",
  "nella", "nello", "nelle", "negli", "alla", "allo", "alle", "agli", "sulla", "sullo", "sulle",
  "sugli", "con", "per", "tra", "fra", "che", "non", "più", "meno", "bene", "male", "ok", "okay",
  "dalla", "dallo", "dalle", "degli", "ogni", "stesso", "stessa", "ecco", "invece", "oppure", "però",
  "pero", "dato", "dati", "ultimo", "ultima", "nuovo", "nuova", "nuovi", "vero", "vera", "giusto",
  "meglio", "subito", "intanto", "comunque", "proprio", "fino", "dentro", "fuori", "ancora", "cosi",
  "così", "qualcosa", "niente", "nulla", "tanto", "tanti", "sapere", "sai", "sapevo", "pensa",
  "pensi", "credo", "penso", "magari", "parte", "parti", "modo", "volta", "volte", "punto", "ora",
  // English
  "this", "that", "these", "those", "with", "from", "have", "has", "had", "been", "were", "was",
  "will", "would", "should", "could", "there", "their", "them", "then", "than", "when", "what",
  "which", "while", "into", "your", "yours", "about", "also", "just", "only", "very", "much", "more",
  "some", "such", "each", "every", "other", "another", "please", "thanks", "thank", "okay", "yeah",
  "sure", "continue", "proceed", "check", "look", "make", "does", "done", "doing", "want", "need",
  "like", "know", "think", "going", "still", "again", "here", "where", "after", "before", "over",
  "same", "they", "were", "being", "because", "using", "used", "uses", "work", "works", "working",
]);

/** Fold diacritics and lower-case: "Perché" and "perche" are the same word. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** Whole words of a text, folded, as a set (for exact word-membership checks). */
export function wordSet(text: string): Set<string> {
  return new Set(fold(text).match(/[\p{L}\p{N}_]+/gu) ?? []);
}

/**
 * The words of a prompt that can be evidence of topic: whole words, at least 4 chars,
 * not filler, de-duplicated, in order of appearance, capped (long pasted prompts would
 * otherwise turn every memory into a match).
 */
export function distinctiveTokens(text: string, max = 14): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of fold(text).match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (w.length < MIN_EVIDENCE_TOKEN_LENGTH || FILLER.has(w) || /^\d+$/.test(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** How many of `tokens` occur as whole words in `text`. */
export function matchedTokenCount(tokens: readonly string[], text: string): number {
  if (tokens.length === 0) return 0;
  const words = wordSet(text);
  let n = 0;
  for (const t of tokens) if (words.has(t)) n++;
  return n;
}

/** A rare token (few documents mention it) is worth this many points of evidence; a common one, 1. */
export const RARE_TOKEN_POINTS = 2;
/** Evidence needed for a lexical match to count at all: one rare word, or two common ones. */
export const MIN_EVIDENCE_POINTS = 2;

/**
 * Evidence points of a text for a prompt: each distinctive prompt word found as a whole
 * word in the text is worth 1 point, or RARE_TOKEN_POINTS when few documents mention it
 * (it names something). Generic Italian/English words that survive the filler list
 * ("problemi", "prossimo", "direttamente") can only add up to the minimum together.
 */
export function evidencePoints(
  tokens: readonly string[],
  text: string,
  rare: ReadonlySet<string>,
  veryCommon?: ReadonlySet<string>,
  stemLength = 0,
): number {
  if (tokens.length === 0) return 0;
  const match = tokenMatcher(text, stemLength);
  let points = 0;
  for (const t of tokens) if (match(t)) points += tokenPoints(t, rare, veryCommon);
  return points;
}

/**
 * Whole-word membership in `text`, plus — with a stem length N > 0 — a prompt word longer
 * than N matches any text word sharing its first N letters ("idempotency" ~ "idempotenza",
 * "deploy" ~ "deployed"): prompts and memories mix Italian and English.
 */
function tokenMatcher(text: string, stemLength: number): (token: string) => boolean {
  const words = wordSet(text);
  if (stemLength <= 0) return (t) => words.has(t);
  const stems = new Set<string>();
  for (const w of words) if (w.length >= stemLength) stems.add(w.slice(0, stemLength));
  return (t) => words.has(t) || (t.length > stemLength && stems.has(t.slice(0, stemLength)));
}

/**
 * The FTS5 query of the selective path: the OR of the quoted prompt words and, with a
 * stem length N > 0, a prefix term for each word longer than N (same rule as the points).
 */
export function selectiveFtsQuery(tokens: readonly string[], stemLength: number): string | null {
  const terms: string[] = [];
  for (const raw of tokens) {
    const t = raw.replaceAll('"', "");
    if (!t) continue;
    terms.push(`"${t}"`);
    if (stemLength > 0 && t.length > stemLength) terms.push(`"${t.slice(0, stemLength)}"*`);
  }
  return terms.length > 0 ? terms.join(" OR ") : null;
}

/**
 * A word thousands of KB documents mention is worth half a point: it is in every
 * project's history ("deploy", "test", "agent"), so sharing it is weak evidence.
 */
export const VERY_COMMON_TOKEN_POINTS = 0.5;

function tokenPoints(t: string, rare: ReadonlySet<string>, veryCommon?: ReadonlySet<string>): number {
  if (rare.has(t)) return RARE_TOKEN_POINTS;
  return veryCommon?.has(t) ? VERY_COMMON_TOKEN_POINTS : 1;
}

/** Total points a prompt could earn (all its distinctive words matched). */
export function totalPoints(tokens: readonly string[], rare: ReadonlySet<string>, veryCommon?: ReadonlySet<string>): number {
  return tokens.reduce((n, t) => n + tokenPoints(t, rare, veryCommon), 0);
}

export interface RelevanceEvidence {
  /** Raw cosine of a vector hit (0-1), if the candidate came from the vector source. */
  cosine?: number;
  /** BM25-derived 0-1 score of an FTS hit, if any. */
  ftsScore?: number;
  /** The candidate's entity was matched by a whole word of the prompt. */
  entityMatch: boolean;
  /** Evidence points the candidate's text earns for the prompt (see evidencePoints). */
  points: number;
  /** Points the prompt could earn at most. */
  maxPoints: number;
  /** What the ledger says a memory of this kind is worth (see candidateClass). Default: "default". */
  cls?: CandidateClass;
}

/**
 * Classes of candidate whose evidence bar differs, from the recall ledger (2026-10-03,
 * 44k judged injections): a same-project EVENT from the last days was used ~60% of the
 * times it was shown, older same-project events ~20%, bare facts 5-10%, facts of no
 * known project ~1%.
 *   - "recent-project-event": an event of the current project inside the recent window;
 *   - "unknown-project": a memory with no project label that is not about the user
 *     (chat imports, untagged events) — usually another project's work, unlabeled;
 *   - "default": everything else.
 */
export type CandidateClass = "default" | "recent-project-event" | "unknown-project";

export function candidateClass(
  c: { kind: string; ts?: string; project: string; userLevel: boolean },
  currentProject: string | undefined,
  nowMs: number,
  recentEventDays: number,
): CandidateClass {
  const current = normalizeProject(currentProject);
  if (current === "") return "default";
  const own = normalizeProject(c.project);
  if (own === "") return c.userLevel ? "default" : "unknown-project";
  if (c.kind !== "event" || recentEventDays <= 0 || own !== current) return "default";
  const t = c.ts ? Date.parse(c.ts) : NaN;
  return Number.isFinite(t) && t <= nowMs && nowMs - t <= recentEventDays * 86_400_000 ? "recent-project-event" : "default";
}

/** Evidence points each class needs (the two class-specific bars are optional: absent = the default bar). */
export interface EvidenceGate {
  minPoints: number;
  anchoredMinPoints: number;
  recentEventMinPoints?: number;
  unknownProjectMinPoints?: number;
}

/** A recent project event that earned its points clears τ on its own: the points gate is its bar. */
const RECENT_EVENT_LEXICAL_BASE = 1;

/**
 * A REAL 0-1 relevance for one candidate — the score the gate compares to τ.
 *
 * Replaces the old calibration in which every lexical rank-0 hit scored the constant
 * 0.50 whatever it matched. Evidence, strongest first:
 *   - a vector hit: its cosine, as is;
 *   - lexical evidence, only when the text earns MIN_EVIDENCE_POINTS: the BM25 score of
 *     the FTS hit scaled by how much of the prompt's evidence the memory covers; an
 *     entity named by a whole word of the prompt lifts it slightly, never above what the
 *     covered vocabulary supports (naming an entity is not evidence about one of its
 *     80 unrelated facts).
 * A candidate with too little shared evidence and no vector hit scores 0.
 */
export function relevanceScore(
  e: RelevanceEvidence,
  gate: EvidenceGate = { minPoints: MIN_EVIDENCE_POINTS, anchoredMinPoints: MIN_EVIDENCE_POINTS },
): number {
  const cls = e.cls ?? "default";
  // Unknown project: lexical evidence or an anchor only — a bare cosine is not enough
  // to show a memory that is, more often than not, another project's.
  const vector = e.cosine != null && cls !== "unknown-project" ? clamp01(e.cosine) : 0;
  const needed = neededPoints(e.entityMatch, cls, gate);
  const noEvidence = e.points < needed || (cls === "recent-project-event" && e.points <= 0);
  if (noEvidence || e.maxPoints <= 0) return vectorOnlyRelevance(vector, e.maxPoints);
  const coverage = Math.min(1, e.points / Math.min(e.maxPoints, 2 * needed));
  // No BM25 score (the candidate came from the entity-name source): an anchored memory that
  // already earned its evidence points is as strong as a good FTS hit; an un-anchored one is not.
  const lexicalBase =
    cls === "recent-project-event"
      ? RECENT_EVENT_LEXICAL_BASE
      : e.ftsScore != null ? clamp01(e.ftsScore) : e.entityMatch ? 0.8 : 0.5;
  let lexical = lexicalBase * (0.5 + 0.5 * coverage);
  if (e.entityMatch) lexical = Math.min(1, lexical + 0.1 * coverage);
  return Math.max(vector, clamp01(lexical));
}

/**
 * A cosine with no lexical evidence behind it. Measured live (2026-10-03): Qwen3-4B
 * puts one-word prompts at ~0.81-0.83 against unrelated memories ("Riprova" pulled
 * "... — Procedi"), so the raw cosine alone is only trusted for a prompt with enough
 * distinctive words AND a cosine above that band.
 */
function neededPoints(anchored: boolean, cls: CandidateClass, gate: EvidenceGate): number {
  if (cls === "recent-project-event" && gate.recentEventMinPoints != null) return gate.recentEventMinPoints;
  if (anchored) return gate.anchoredMinPoints;
  if (cls === "unknown-project" && gate.unknownProjectMinPoints != null) return gate.unknownProjectMinPoints;
  return gate.minPoints;
}

export const VECTOR_ONLY_MIN_COSINE = 0.86;
export const VECTOR_ONLY_MIN_PROMPT_POINTS = 3;

function vectorOnlyRelevance(vector: number, maxPoints: number): number {
  if (maxPoints < VECTOR_ONLY_MIN_PROMPT_POINTS) return 0;
  return vector >= VECTOR_ONLY_MIN_COSINE ? vector : 0;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function normalizeProject(p: string | null | undefined): string {
  return typeof p === "string" ? p.normalize("NFKC").trim().toLowerCase() : "";
}

/**
 * True when two project labels say the memory belongs to a different project: both
 * are non-empty and they differ. An EMPTY label is user-level memory (chat imports,
 * untagged events) and never conflicts. A generic label ("web", "src", a worktree
 * name) is NOT treated as unknown: it cannot be proven to be the same project, and
 * the cost of dropping a borderline memory is nil next to showing another project's
 * (measured on the live replay: every such label was another repo's memory or an
 * unattributable worktree).
 */
export function projectsConflict(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeProject(a);
  const y = normalizeProject(b);
  return x !== "" && y !== "" && x !== y;
}

/** "Subject — text": every injected line names what it is about (unless it already does). */
export function withSubject(subject: string | undefined, text: string): string {
  const name = (subject ?? "").trim();
  if (!name) return text;
  if (fold(text).includes(fold(name))) return text;
  return `${name} — ${text}`;
}

export interface AssociativeCandidate {
  activation: number;
  /** How many distinct seeds this item was reached from (undefined = unknown, not filtered). */
  seedCount?: number;
}

/**
 * Cut the associative tail down to what is convincing: normalize activations to 0-1
 * against the strongest in the batch, drop what is below the floor or reached from too
 * few seeds, keep the strongest `maxAssociative`. Pure; returns new objects.
 */
export function selectAssociative<T extends AssociativeCandidate>(
  items: readonly T[],
  cfg: Pick<SelectiveRecallConfig, "maxAssociative" | "minAssociativeActivation" | "minAssociativeSeeds">,
): Array<T & { normalizedActivation: number }> {
  const top = items.reduce((m, i) => Math.max(m, i.activation), 0);
  if (top <= 0) return [];
  return items
    .map((i) => ({ ...i, normalizedActivation: i.activation / top }))
    .filter((i) => i.normalizedActivation >= cfg.minAssociativeActivation)
    .filter((i) => i.seedCount === undefined || i.seedCount >= cfg.minAssociativeSeeds)
    .sort((a, b) => b.normalizedActivation - a.normalizedActivation)
    .slice(0, cfg.maxAssociative);
}

/** Owner key shared by the ledger, the de-dup log and the chronic-noise set. */
export function ownerKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Per-session memory of what was injected in the last N turns, so the same owner is
 * not pushed again and again (one memory was injected 1,515 times). In-memory, keyed
 * by the Claude Code session id, bounded in sessions.
 */
export class RecentInjectionLog {
  private readonly sessions = new Map<string, Array<Set<string>>>();

  constructor(
    private readonly turns: number,
    private readonly maxSessions = 200,
  ) {}

  /** Owner keys injected in the session's last `turns` turns. */
  recent(sessionId: string): Set<string> {
    const out = new Set<string>();
    for (const turn of this.sessions.get(sessionId) ?? []) for (const k of turn) out.add(k);
    return out;
  }

  /** Record the owner keys injected on this turn (an empty turn still ages the window). */
  commit(sessionId: string, keys: Iterable<string>): void {
    const window = this.sessions.get(sessionId) ?? [];
    window.push(new Set(keys));
    while (window.length > this.turns) window.shift();
    this.sessions.delete(sessionId); // re-insert: Map order = recency, oldest session evicted first
    this.sessions.set(sessionId, window);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}

/** Anything that can report the chronic-noise owner keys (the SQLite store). */
export interface ChronicNoiseSource {
  chronicNoiseOwnerKeys?: (minInjections: number) => string[];
}

/**
 * The set of "kind:id" owners the ledger shows were injected at least N times and
 * never used. Read from the ledger at most once per `cacheMs` per store, so the hot
 * path pays nothing on most turns. Fail-open: an unreadable ledger means no exclusion.
 */
export class ChronicNoiseCache {
  private readonly byStore = new WeakMap<object, { at: number; keys: Set<string> }>();

  keys(store: ChronicNoiseSource, cfg: Pick<SelectiveRecallConfig, "chronicNoiseMinInjections" | "chronicNoiseCacheMs">, nowMs = Date.now()): Set<string> {
    const hit = this.byStore.get(store);
    if (hit && nowMs - hit.at < cfg.chronicNoiseCacheMs) return hit.keys;
    let keys = new Set<string>();
    try {
      if (typeof store.chronicNoiseOwnerKeys === "function") {
        keys = new Set(store.chronicNoiseOwnerKeys(cfg.chronicNoiseMinInjections));
      }
    } catch {
      /* fail-open: no exclusion this window */
    }
    this.byStore.set(store, { at: nowMs, keys });
    return keys;
  }
}

/**
 * Resolve the selective settings from a recall config. `null` = the legacy behaviour
 * (hand-built configs without the block, or `selective.enabled = false`).
 */
export function resolveSelective(recall: { selective?: SelectiveRecallConfig } | undefined): SelectiveRecallConfig | null {
  const s = recall?.selective;
  return s && s.enabled ? s : null;
}
