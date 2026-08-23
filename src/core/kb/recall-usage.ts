/**
 * Did the agent actually USE the memory it was given?
 *
 * WHY THIS EXISTS
 * ---------------
 * Sinapsys has never known whether it is useful. Worse, the feedback loop it
 * does have is wrong: `reinforceRecalledOwners` strengthens the top associative
 * hits of EVERY recall (auto-recall.ts), so a memory that is injected and
 * ignored grows stronger forever. Retrieval was being treated as usefulness.
 *
 * THE MEASUREMENT PROBLEM
 * -----------------------
 * "Ask the model if the memory helped" is the obvious design and a bad one: the
 * model grades itself, cannot be checked, and has every incentive to say yes.
 * So this module measures something an outsider can verify.
 *
 * THE SIGNAL
 * ----------
 * A memory counts as USED when the agent's reply contains distinctive tokens
 * that came from the MEMORY and **not from the user's own prompt**.
 *
 * That last condition is the whole point. Without it the score is an echo: the
 * user writes "Argus", the memory mentions "Argus", the reply repeats "Argus",
 * and every memory looks useful. Subtracting the prompt's vocabulary leaves only
 * what the agent could not have got from the conversation itself — which is
 * exactly what memory is for.
 *
 * Deterministic, no LLM, no embeddings. A verdict nobody has to trust.
 */

/**
 * Minimum token length to count. Shorter tokens are almost always function
 * words or fragments and produce coincidental matches.
 */
const MIN_TOKEN_LENGTH = 4;

/** Distinctive tokens that must overlap before a memory counts as used. */
export const DEFAULT_MIN_MATCHES = 2;

/**
 * Tokens too common to carry evidence, in the languages this system sees.
 * Deliberately short: IDF-style weighting is not available here (building
 * corpus stats costs a full scan — see the cornerstone lesson), so the filter
 * stays cheap and the MIN_TOKEN_LENGTH rule does most of the work.
 */
const STOP = new Set([
  // Italian
  "che", "non", "per", "con", "come", "questo", "questa", "quello", "quella",
  "sono", "essere", "stato", "stata", "anche", "quando", "dove", "perche",
  "della", "dello", "delle", "degli", "nella", "nello", "alla", "allo",
  "molto", "tutto", "tutti", "tutte", "solo", "ancora", "adesso", "quindi",
  "fatto", "fare", "detto", "dire", "cosa", "senza", "sempre", "prima", "dopo",
  // English
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "was",
  "were", "been", "will", "would", "should", "could", "there", "their", "them",
  "then", "than", "when", "what", "which", "into", "your", "you", "not", "but",
  "all", "any", "can", "are", "its", "it's", "about", "also", "just", "only",
  // Technical noise that appears in nearly every turn here
  "file", "code", "test", "tests", "line", "lines", "error", "errors",
  "memoria", "memory", "sinapsys", "claude",
]);

/**
 * Split into lower-cased tokens, keeping `.` `/` `\` `-` `_` INSIDE a token so
 * identifiers survive whole (`vectors.db`, `src/core/kb/bug-working-set.ts`,
 * `MAX_PAIRWISE_BUG_EVENTS`), then trimming those characters off the EDGES.
 *
 * The trim is not cosmetic: without it `vectors.db` and `vectors.db.` (end of a
 * sentence) are different tokens, so a memory that WAS used scores zero. The
 * first version of this module had exactly that bug and the tests caught it.
 */
export function tokenize(text: string): string[] {
  return (text.match(/[\p{L}\p{N}_./\\-]+/gu) ?? [])
    .map((t) => t.toLowerCase().replace(/^[./\\_-]+/, "").replace(/[./\\_-]+$/, ""))
    .filter((t) => t.length >= MIN_TOKEN_LENGTH);
}

/**
 * Strip the injection format's own vocabulary: the leading `[fact]` / `[event]`
 * marker and the score annotations. That is how memory is PRINTED, not what it
 * knows — crediting it would be crediting the renderer.
 */
function stripInjectionMarkup(memoryText: string): string {
  return memoryText
    .replace(/^\s*[↳-]?\s*\[[^\]]+\]\s*/u, "")
    .replace(/\((?:relevance|active|associazione|rilevanza)[^)]*\)/gu, "");
}

/** Distinct, non-stop tokens of a text. */
function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    if (!STOP.has(t)) out.add(t);
  }
  return out;
}

export interface UsageJudgement {
  /** True when the reply shows evidence the memory was used. */
  used: boolean;
  /** The tokens that carried the evidence (sorted, for auditability). */
  matchedTokens: string[];
  /**
   * Tokens unique to the memory (absent from the prompt). When this is empty
   * the memory was UNJUDGEABLE — it said nothing the user had not already said,
   * so no reply could ever prove it was used. Reported, never counted as noise.
   */
  distinctiveTokens: string[];
}

export interface JudgeUsageParams {
  /** The memory line exactly as it was injected. */
  memoryText: string;
  /** What the user wrote this turn — its vocabulary is subtracted. */
  userText: string;
  /** What the agent replied, plus any tool input it produced. */
  assistantText: string;
  /** Distinctive tokens required for a positive verdict. */
  minMatches?: number;
}

/**
 * Judge one memory against one turn.
 *
 * Conservative by construction: everything unclear resolves to `used: false`
 * with the evidence attached, so an over-eager verdict can never inflate the
 * numbers Lorenzo is shown.
 */
export function judgeMemoryUsage(params: JudgeUsageParams): UsageJudgement {
  const minMatches = params.minMatches ?? DEFAULT_MIN_MATCHES;
  const memory = contentTokens(stripInjectionMarkup(params.memoryText));
  if (memory.size === 0) {
    return { used: false, matchedTokens: [], distinctiveTokens: [] };
  }

  // Subtract the user's vocabulary: what the prompt already contains cannot be
  // evidence that MEMORY was used.
  const prompt = contentTokens(params.userText);
  const distinctive = [...memory].filter((t) => !prompt.has(t)).sort();
  if (distinctive.length === 0) {
    return { used: false, matchedTokens: [], distinctiveTokens: [] };
  }

  const reply = contentTokens(params.assistantText);
  const matched = distinctive.filter((t) => reply.has(t));

  return {
    used: matched.length >= minMatches,
    matchedTokens: matched,
    distinctiveTokens: distinctive,
  };
}

export interface TurnVerdictInput {
  ownerId: string;
  memoryText: string;
}

export interface MemoryVerdict {
  ownerId: string;
  used: boolean;
  matchedTokens: string[];
  /** True when the memory added no vocabulary of its own — cannot be judged. */
  unjudgeable: boolean;
}

export interface TurnVerdict {
  injected: number;
  used: number;
  unjudgeable: number;
  perMemory: MemoryVerdict[];
}

/** Judge every memory injected in one turn. */
export function judgeTurn(
  memories: ReadonlyArray<TurnVerdictInput>,
  userText: string,
  assistantText: string,
  minMatches?: number,
): TurnVerdict {
  const perMemory: MemoryVerdict[] = memories.map((m) => {
    const j = judgeMemoryUsage({
      memoryText: m.memoryText,
      userText,
      assistantText,
      minMatches,
    });
    return {
      ownerId: m.ownerId,
      used: j.used,
      matchedTokens: j.matchedTokens,
      unjudgeable: j.distinctiveTokens.length === 0,
    };
  });
  return {
    injected: perMemory.length,
    used: perMemory.filter((m) => m.used).length,
    unjudgeable: perMemory.filter((m) => m.unjudgeable).length,
    perMemory,
  };
}
