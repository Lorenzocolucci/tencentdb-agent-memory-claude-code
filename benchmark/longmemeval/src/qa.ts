/**
 * Reader + Judge stages for the LongMemEval benchmark.
 *
 * Reader:  answers the question using ONLY the memories Sinapsys retrieved.
 * Judge:   GPT-4o semantic check of the answer vs the gold answer — this is why
 *          we do NOT use a substring match (Sinapsys summarizes, e.g. "GPS issue
 *          fixed" for gold "GPS not functioning"; substring would wrongly fail).
 *          Mirrors the official LongMemEval evaluate_qa.py LLM-judge approach.
 */
import { chatComplete } from "./openai.js";

const READER_SYSTEM =
  "You answer a question about a user using memories retrieved from their past " +
  "conversations. Read ALL the memories and REASON across them before answering:\n" +
  "- For 'how many' / 'which' / 'list' questions, COUNT or AGGREGATE the relevant " +
  "items across the memories (e.g. three distinct items mentioned → answer 3).\n" +
  "- For 'when' / temporal questions, use the dates/timestamps in the memories.\n" +
  "- When facts changed over time, prefer the MOST RECENT relevant memory.\n" +
  "Give a direct, concise answer (a phrase or one short sentence). Make a best-effort " +
  "answer from the evidence. Reply 'I don't know' ONLY if the memories contain nothing " +
  "relevant at all — do not abstain just because the answer needs counting or inference.";

export async function reader(question: string, memoryContext: string): Promise<string> {
  const user = `Retrieved memories:\n${memoryContext || "(none)"}\n\nQuestion: ${question}\nAnswer:`;
  return chatComplete(READER_SYSTEM, user, { maxTokens: 256 });
}

const JUDGE_SYSTEM =
  "You are grading a memory system. Given a question, the GOLD correct answer, and a " +
  "MODEL answer, decide if the MODEL answer is correct — i.e. semantically equivalent " +
  "to, or clearly contains, the gold answer. Ignore wording/format differences. " +
  "Reply with EXACTLY one word: yes or no.";

const ABSTENTION_SYSTEM =
  "You are grading an abstention question: the correct behavior is for the model to " +
  "indicate it does NOT know / the information is not available. Given the MODEL answer, " +
  "decide if the model correctly abstained (said it doesn't know / has no such info). " +
  "Reply with EXACTLY one word: yes or no.";

function parseYesNo(raw: string): boolean {
  return /^\s*yes\b/i.test(raw);
}

/**
 * Returns true if the model answer is judged correct.
 * For abstention questions, correct = the model abstained.
 */
export async function judge(
  question: string,
  goldAnswer: string,
  modelAnswer: string,
  isAbstention: boolean,
): Promise<boolean> {
  if (isAbstention) {
    const out = await chatComplete(
      ABSTENTION_SYSTEM,
      `MODEL answer: ${modelAnswer}\n\nDid the model correctly abstain?`,
      { maxTokens: 4 },
    );
    return parseYesNo(out);
  }
  const out = await chatComplete(
    JUDGE_SYSTEM,
    `Question: ${question}\nGOLD answer: ${goldAnswer}\nMODEL answer: ${modelAnswer}\n\nIs the MODEL answer correct?`,
    { maxTokens: 4 },
  );
  return parseYesNo(out);
}
