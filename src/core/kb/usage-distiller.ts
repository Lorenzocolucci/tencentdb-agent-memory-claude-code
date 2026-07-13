/**
 * Usage distiller (Slice A3, Percorso B) — the PRECISION filter the live finding
 * proved is required: the B1 brain clusters behaviors semantically, but on real
 * data every threshold surfaces mostly NOISE (status notes, one-off facts, test
 * strings misclassified as `observation`). Clustering gives RECALL; this LLM
 * gate gives PRECISION.
 *
 * Given N observations that co-occur semantically across different sessions, the
 * model JUDGES: is this a genuine, generalizable behavioral tendency ("how the
 * person works" / "what they keep doing"), or is it noise? Only a confirmed
 * tendency is written — with a clean, generalized statement, not the raw text.
 *
 * Mirrors principle-distiller: injected LLMRunner (host-neutral, testable), CJK
 * barrier (Kimi can slip into Chinese; Lorenzo works in IT/EN — reject residual
 * rather than store garbage). NEVER throws: any failure yields null → skip.
 */
import type { LLMRunner } from "../types.js";
import { runWithoutCjk, hasCjk } from "../../utils/language-guard.js";

// ── Public types ───────────────────────────────────────────────────────────────

export interface DistilledUsage {
  /** TRUE only if the model judges this a genuine recurring behavioral tendency. */
  isTendency: boolean;
  /** The clean, generalized tendency (same language as input). Empty if not. */
  tendencyText: string;
  /** Model self-confidence, clamped to [0,1]. */
  confidence: number;
}

/** Minimal cluster shape the distiller accepts. */
export interface DistillableUsageCluster {
  project: string;
  /** The co-occurring behavior texts — presented as observations across sessions. */
  texts: string[];
}

// ── System prompt ──────────────────────────────────────────────────────────────

export const USAGE_DISTILL_SYSTEM_PROMPT =
  "You are a strict judge of BEHAVIORAL TENDENCIES for a personal-memory system.\n" +
  "You are given N observations that co-occurred (semantically similar) across DIFFERENT\n" +
  "work sessions. Decide if together they reveal a genuine, generalizable tendency in HOW\n" +
  "the person works or WHAT they keep doing — something useful to recall in a future session.\n" +
  "\n" +
  "REJECT (is_tendency=false) if the cluster is NOT a real behavioral tendency, e.g.:\n" +
  "  - status notes or one-off facts (a specific bug id, a build status, a deploy result),\n" +
  "  - test strings / debugging artifacts / boilerplate,\n" +
  "  - a single topic mentioned repeatedly but implying no habit or preference,\n" +
  "  - anything you could not restate as \"the person tends to / prefers to / usually …\".\n" +
  "Be strict: when in doubt, REJECT. A false tendency pollutes the memory forever.\n" +
  "\n" +
  "Keep any text in the SAME language as the input (do not translate). Reply with STRICT\n" +
  "JSON only — no prose, no markdown fences — of exactly this shape:\n" +
  '{"is_tendency": boolean, "tendency_text": string, "confidence": number}\n' +
  "- is_tendency: true only for a genuine, generalizable behavioral tendency.\n" +
  "- tendency_text: if true, one sentence stating the tendency (\"Tende a …\" / \"Prefers to …\"); if false, \"\".\n" +
  "- confidence: 0..1, how sure you are this is a stable tendency (not a coincidence).";

// ── Prompt builder ─────────────────────────────────────────────────────────────

export function buildUsagePrompt(c: DistillableUsageCluster): string {
  const lines = c.texts.map((t, i) => `  OBSERVATION ${i + 1}: ${t}`).join("\n");
  return (
    `Project: ${c.project || "(unspecified)"}\n` +
    `${c.texts.length} semantically-related observation(s) across different sessions:\n` +
    lines + "\n\n" +
    `Is this a genuine recurring behavioral tendency? Reply as STRICT JSON.`
  );
}

// ── JSON parsing helpers (mirror principle-distiller) ───────────────────────────

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function clamp01(n: unknown): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// ── Parser ─────────────────────────────────────────────────────────────────────

export function parseDistilledUsage(raw: string): DistilledUsage | null {
  if (!raw || !raw.trim()) return null;
  const json = extractJsonObject(raw);
  if (!json) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const isTendency = obj.is_tendency === true;
  const tendencyText = typeof obj.tendency_text === "string" ? obj.tendency_text.trim() : "";
  // A confirmed tendency MUST carry a statement; reject a true-but-empty answer.
  if (isTendency && !tendencyText) return null;
  return { isTendency, tendencyText, confidence: clamp01(obj.confidence) };
}

// ── Distiller ──────────────────────────────────────────────────────────────────

export interface DistillUsageOptions {
  timeoutMs?: number;
}

/**
 * Judge one candidate cluster via the LLM. Returns:
 *   - a DistilledUsage with isTendency=true and a clean statement, OR
 *   - null when it is NOT a tendency, the output is unparseable, or CJK residue
 *     survives the rewrite barrier (never store garbage). Never throws.
 */
export async function distillUsageCluster(
  cluster: DistillableUsageCluster,
  llmRunner: LLMRunner,
  opts: DistillUsageOptions = {},
): Promise<DistilledUsage | null> {
  try {
    const raw = await runWithoutCjk(llmRunner, {
      systemPrompt: USAGE_DISTILL_SYSTEM_PROMPT,
      prompt: buildUsagePrompt(cluster),
      taskId: "usage-distill",
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    const parsed = parseDistilledUsage(raw);
    if (!parsed || !parsed.isTendency) return null;
    // Reject residual-CJK rather than store garbage (skip the cluster).
    if (hasCjk(parsed.tendencyText)) return null;
    return parsed;
  } catch {
    return null;
  }
}
