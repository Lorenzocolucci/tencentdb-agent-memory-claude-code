/**
 * LongMemEval → Sinapsys seed (Format A) converter.
 *
 * WHAT:  turns one LongMemEval question's haystack into the `{ sessions: [...] }`
 *        Format A that the gateway `/seed` endpoint (and the seed runtime) accepts.
 * WHY:   Sinapsys ingests conversations as timestamped rounds; LongMemEval ships
 *        flat per-session turn lists with a single per-session date. We must
 *        preserve the REAL session dates (temporal-reasoning questions depend on
 *        them) and pair turns into rounds so L1 extraction sees user/assistant
 *        exchanges the way it does in production.
 *
 * This module is pure (no I/O, no mutation of inputs) so it can be unit-tested
 * against real oracle records without a gateway or LLM.
 */
export type Role = "user" | "assistant";

export interface LmeTurn {
  role: Role;
  content: string;
  has_answer?: boolean;
}

export interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LmeTurn[][];
  answer_session_ids: string[];
}

export interface SeedMessage {
  role: Role;
  content: string;
  timestamp: number; // epoch ms
}

export interface SeedSession {
  sessionKey: string;
  sessionId: string;
  conversations: SeedMessage[][]; // 2D: rounds of messages
}

export interface SeedFormatA {
  sessions: SeedSession[];
}

/** Per-turn timestamp offset (ms) inside a session — keeps strict ordering
 *  without crossing into the next session's date. */
const TURN_STEP_MS = 1000;

/**
 * Parse a LongMemEval date like `"2023/04/10 (Mon) 17:50"` into epoch ms (UTC).
 * The `(Mon)` weekday token is decorative and ignored. Throws on unparseable
 * input so a malformed date surfaces loudly instead of silently becoming NaN.
 */
export function parseHaystackDate(s: string): number {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s*\([^)]*\)\s*(\d{1,2}):(\d{2})\s*$/.exec(s.trim());
  if (!m) {
    throw new Error(`Unparseable LongMemEval date: ${JSON.stringify(s)}`);
  }
  const [, y, mo, d, hh, mm] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), 0, 0);
  if (!Number.isFinite(ms)) {
    throw new Error(`Date.UTC produced NaN for: ${JSON.stringify(s)}`);
  }
  return ms;
}

/**
 * Group a flat turn list into rounds. A round is a maximal `user*-then-assistant*`
 * exchange: we start a new round whenever a `user` turn follows an `assistant`
 * turn. This mirrors how a real chat session alternates and gives L1 extraction
 * coherent user/assistant pairs. Leading assistant turns form their own round.
 */
export function groupTurnsIntoRounds(turns: LmeTurn[]): LmeTurn[][] {
  const rounds: LmeTurn[][] = [];
  let current: LmeTurn[] = [];
  let sawAssistant = false;

  for (const turn of turns) {
    if (turn.role === "user" && sawAssistant) {
      // boundary: previous exchange is complete
      rounds.push(current);
      current = [];
      sawAssistant = false;
    }
    current = [...current, turn];
    if (turn.role === "assistant") sawAssistant = true;
  }
  if (current.length > 0) rounds.push(current);
  return rounds;
}

/**
 * Convert one LongMemEval question into Format A seed input.
 *
 * - Each haystack session → one seed session keyed by its real session id, so a
 *   later proxy-recall check can map retrieved evidence back to answer_session_ids.
 * - Each turn gets the session's real date + a per-turn step, preserving both
 *   cross-session chronology and within-session order.
 * - `sessionKeyPrefix` namespaces the run (defaults to the question id) so the
 *   caller can keep one isolated data dir per question.
 */
export function lmeQuestionToSeed(
  q: LmeQuestion,
  opts?: { sessionKeyPrefix?: string },
): SeedFormatA {
  const prefix = opts?.sessionKeyPrefix ?? q.question_id;

  if (q.haystack_sessions.length !== q.haystack_dates.length) {
    throw new Error(
      `${q.question_id}: haystack_sessions (${q.haystack_sessions.length}) and ` +
      `haystack_dates (${q.haystack_dates.length}) length mismatch`,
    );
  }

  const sessions: SeedSession[] = q.haystack_sessions.map((turns, i) => {
    const baseTs = parseHaystackDate(q.haystack_dates[i]!);
    const sessionId = q.haystack_session_ids[i] ?? `${prefix}_s${i}`;

    let step = 0;
    const stamp = (): number => {
      const t = baseTs + step * TURN_STEP_MS;
      step += 1;
      return t;
    };

    const rounds = groupTurnsIntoRounds(turns).map((round) =>
      round.map((turn) => ({
        role: turn.role,
        content: turn.content,
        timestamp: stamp(),
      })),
    );

    return {
      sessionKey: `${prefix}__${sessionId}`,
      sessionId,
      conversations: rounds,
    };
  });

  return { sessions };
}
