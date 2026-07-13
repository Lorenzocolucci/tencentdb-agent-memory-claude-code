/**
 * behavioral-law-detector — Percorso A brain (Slice A1): pure, deterministic,
 * NO LLM, NO DB, NO side effects.
 *
 * Detects when a user message states an EXPLICIT behavioral directive/law about
 * how the agent should act ("aspetta la mia risposta", "non compiacere mai",
 * "d'ora in poi verifica prima"). Unlike bugs (Mistake Notebook) or tendencies
 * (Percorso B), a law is authoritative on FIRST statement — no cross-session
 * recurrence needed. So this is NOT clustering: it is a HIGH-RECALL candidate
 * gate over a single message.
 *
 * Design honesty: the marker set is crude on purpose. Its job is high recall +
 * cheap rejection of obvious status notes (a negation like "non ho toccato" must
 * NOT fire). An optional LLM pass (Slice A3) refines the exact rule text and
 * prunes false positives. This layer only decides "is this plausibly a law, and
 * of what kind?" — pure & total, never throws.
 */

export type DirectiveKind = "prohibition" | "prescription" | "correction";

export interface DirectiveCandidate {
  /** correction > prohibition > prescription (by authority/severity). */
  kind: DirectiveKind;
  /** The raw rule text (trimmed). Clean normalization is Slice A3's job. */
  text: string;
  /** 0–1 crude confidence from summed marker weights (LLM refines later). */
  strength: number;
  /** Which markers fired — for transparency and tests. */
  markers: string[];
}

/**
 * Words that, right after "non", mean the phrase is a STATUS note, not a
 * directive ("non ho toccato", "non è spento", "non ci sono"). Auxiliaries,
 * copulas, clitics, articles, prepositions — never the target of a behavioral law.
 */
const NON_STOPWORDS = new Set([
  "ho", "hai", "ha", "hanno", "abbiamo", "avete", "avevo", "avevi", "aveva", "avevano",
  "è", "e'", "sono", "sei", "siamo", "siete", "era", "eri", "erano", "fu", "sarà", "sara",
  "ci", "c'", "mi", "ti", "si", "vi", "lo", "la", "li", "le", "ne", "gli",
  "un", "uno", "una", "il", "i", "di", "del", "della", "che", "più", "piu",
  "ancora", "solo", "molto", "tanto", "so", "vedo", "credo", "penso",
]);

/** Prescriptive markers (weight): the message tells the agent to DO/BE something. */
const PRESCRIPTION_MARKERS: Array<[RegExp, string, number]> = [
  [/\bd['’ ]?ora in poi\b/i, "d'ora in poi", 0.4],
  [/\bda (ora|adesso) in poi\b/i, "da ora in poi", 0.4],
  [/\bfrom now on\b/i, "from now on", 0.5],
  [/\bsempre\b/i, "sempre", 0.35],
  [/\balways\b/i, "always", 0.35],
  [/\b(devi|dovrai|dovresti)\b/i, "devi", 0.35],
  [/\byou must\b/i, "you must", 0.35],
  [/\bmake sure\b/i, "make sure", 0.35],
  [/\bvoglio che (tu )?/i, "voglio che", 0.35],
  [/\bricord(a|ati|atevi|ate)\b/i, "ricorda", 0.3],
  // Common behavioral imperatives (Italian) directed at the agent.
  [/\b(aspetta|verifica|controlla|fermati|assicurati|evita|procedi|chiedi(mi)?)\b/i, "imperative", 0.35],
];

/** Correction cues: the user is telling the agent it did something wrong. */
const CORRECTION_MARKERS: Array<[RegExp, string, number]> = [
  [/\bsbagliat[oaie]\b/i, "sbagliato", 0.5],
  [/\bnon va bene\b/i, "non va bene", 0.5],
  [/\bnon è (quello|cosa|come)\b/i, "non è quello", 0.5],
  [/\bti (avevo|ho) (detto|corretto)\b/i, "ti avevo detto", 0.5],
  [/\bsmettila di\b/i, "smettila", 0.5],
  [/\bun['’ ]altra volta\b/i, "un'altra volta", 0.4],
];

/** Standalone prohibition markers (besides the "non + verb" scan below). */
const PROHIBITION_MARKERS: Array<[RegExp, string, number]> = [
  [/\bmai\b/i, "mai", 0.4],
  [/\bnever\b/i, "never", 0.5],
  [/\b(don['’]t|do not)\b/i, "don't", 0.5],
];

/** True when "non" is immediately followed by a directive target (a verb), not a status word. */
function hasProhibitiveNon(lower: string): boolean {
  for (const m of lower.matchAll(/\bnon\s+([a-zàèéìòù']+)/gi)) {
    const next = m[1];
    if (next && !NON_STOPWORDS.has(next)) return true;
  }
  return false;
}

/**
 * Detect whether `text` states an explicit behavioral directive, and of what
 * kind. Returns null when nothing plausible fired.
 */
export function detectDirective(text: string): DirectiveCandidate | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();

  const markers: string[] = [];
  let strength = 0;
  const add = (label: string, weight: number): void => {
    if (!markers.includes(label)) {
      markers.push(label);
      strength += weight;
    }
  };

  let hasCorrection = false;
  for (const [re, label, w] of CORRECTION_MARKERS) {
    if (re.test(lower)) { add(label, w); hasCorrection = true; }
  }

  let hasProhibition = false;
  for (const [re, label, w] of PROHIBITION_MARKERS) {
    if (re.test(lower)) { add(label, w); hasProhibition = true; }
  }
  if (hasProhibitiveNon(lower)) { add("non+verb", 0.4); hasProhibition = true; }

  let hasPrescription = false;
  for (const [re, label, w] of PRESCRIPTION_MARKERS) {
    if (re.test(lower)) { add(label, w); hasPrescription = true; }
  }

  if (!hasCorrection && !hasProhibition && !hasPrescription) return null;

  const kind: DirectiveKind = hasCorrection
    ? "correction"
    : hasProhibition
      ? "prohibition"
      : "prescription";

  return { kind, text: trimmed, strength: Math.min(1, strength), markers };
}
