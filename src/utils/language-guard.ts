/**
 * Language guard — a barrier at the LLM output boundary that forbids CJK text.
 *
 * WHY: the extraction/distillation model (Kimi/Moonshot) occasionally emits
 * Chinese or CJK mojibake despite same-language instructions. Lorenzo works in
 * Italian/English, so CJK in a stored memory is ALWAYS garbage. This guard makes
 * the model REWRITE when it slips, and lets callers REJECT a residual rather than
 * store garbage (better no memory than a Chinese one).
 *
 * Pure + host-neutral: takes an injected LLMRunner. Never throws beyond what the
 * runner throws (callers already wrap runner.run in try/catch).
 */
import type { LLMRunner, LLMRunParams } from "../core/types.js";

/**
 * CJK detection: Han ideographs (+ Ext-A / compatibility), Hiragana, Katakana,
 * Hangul. Catches both clean Chinese and mixed-script mojibake.
 */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿･-ﾟ]/;

export function hasCjk(s: string): boolean {
  return typeof s === "string" && CJK_RE.test(s);
}

const REWRITE_DIRECTIVE =
  "\n\nCRITICAL: your previous answer contained Chinese / CJK characters, which are FORBIDDEN. " +
  "Rewrite the SAME answer with ZERO Chinese/Japanese/Korean characters — use only the " +
  "language of the input (Italian or English). Keep the exact same meaning and JSON shape.";

export interface RunWithoutCjkOptions {
  /** How many rewrite attempts after the first CJK-tainted output. Default 2. */
  maxRewrites?: number;
}

/**
 * Run the prompt; if the output contains CJK, re-run with an escalating "no CJK"
 * directive up to `maxRewrites` times. Returns the best (last) output — callers
 * that must not store residual CJK should check {@link hasCjk} and skip.
 */
export async function runWithoutCjk(
  runner: LLMRunner,
  params: LLMRunParams,
  opts: RunWithoutCjkOptions = {},
): Promise<string> {
  const maxRewrites = opts.maxRewrites ?? 2;
  let out = await runner.run(params);
  let attempts = 0;
  while (hasCjk(out) && attempts < maxRewrites) {
    attempts += 1;
    out = await runner.run({
      ...params,
      systemPrompt: (params.systemPrompt ?? "") + REWRITE_DIRECTIVE,
    });
  }
  return out;
}
