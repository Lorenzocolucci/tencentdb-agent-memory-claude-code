/**
 * Lesson distiller (Phase B, part 3) — turns one resolved-failure cluster into
 * a reusable lesson via the LLM. The runner is injected (LLMRunner), so this is
 * host-neutral and testable offline.
 *
 * Contract with the rest of Phase B: NEVER throws. A timeout, network error, or
 * unparseable model output yields `null` — the orchestrator simply skips that
 * cluster. Memory must never break the conversation.
 *
 * NOTE: the prompt is a first cut; have lo-llm-architect review it before the
 * cadence goes automatic.
 */

import type { LLMRunner } from "../types.js";

/** The model's distilled output for one cluster. */
export interface DistilledLesson {
  /** Short language-neutral area, e.g. "circuit-breaker", "twilio-templates". */
  domain: string;
  /** The recurring situation that should trigger recall of this lesson. */
  triggerPattern: string;
  /** The actionable lesson (what to do / what was learned). */
  lessonText: string;
  /** Mistakes to avoid (what NOT to do). */
  antiPatterns: string[];
  /** Model self-confidence, clamped to [0,1]. */
  confidence: number;
}

/** Minimal cluster shape the distiller accepts (satisfied by FailureCluster adapter). */
export interface DistillableCluster {
  project: string;
  bugText: string;
  fixTexts: string[];
}

export const LESSON_DISTILL_SYSTEM_PROMPT =
  "You distill ONE resolved software failure (a bug and the fix(es) that resolved it) into a single reusable engineering lesson.\n" +
  "Be specific and general at once: the lesson must help in a FUTURE similar situation, not just restate this incident.\n" +
  'Reply with STRICT JSON only — no prose, no markdown fences — of exactly this shape:\n' +
  '{"domain": string, "trigger_pattern": string, "lesson_text": string, "anti_patterns": string[], "confidence": number}\n' +
  "- domain: 2-4 word language-neutral area (e.g. \"circuit-breaker\", \"jwt-refresh\").\n" +
  "- trigger_pattern: the recurring situation in which this lesson should resurface.\n" +
  "- lesson_text: one or two sentences, imperative, actionable.\n" +
  "- anti_patterns: short phrases of what NOT to do (may be empty).\n" +
  "- confidence: 0..1, how sure you are this generalizes.";

/** Build the user prompt carrying the failure context (bug + every fix). */
export function buildDistillPrompt(c: DistillableCluster): string {
  const fixes = c.fixTexts.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
  return (
    `Project: ${c.project || "(unspecified)"}\n` +
    `BUG (the failure):\n  ${c.bugText}\n` +
    `FIX(es) (how it was resolved):\n${fixes}\n\n` +
    `Distill the single reusable lesson as STRICT JSON.`
  );
}

/** Extract the first balanced JSON object from a model response (handles fences/prose). */
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

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Parse a model response into a DistilledLesson, or null if invalid. */
export function parseDistilledLesson(raw: string): DistilledLesson | null {
  if (!raw || !raw.trim()) return null;
  const json = extractJsonObject(raw);
  if (!json) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const domain = typeof obj.domain === "string" ? obj.domain.trim() : "";
  const triggerPattern = typeof obj.trigger_pattern === "string" ? obj.trigger_pattern.trim() : "";
  const lessonText = typeof obj.lesson_text === "string" ? obj.lesson_text.trim() : "";
  if (!domain || !triggerPattern || !lessonText) return null;
  return {
    domain,
    triggerPattern,
    lessonText,
    antiPatterns: stringArray(obj.anti_patterns),
    confidence: clamp01(obj.confidence),
  };
}

export interface DistillOptions {
  timeoutMs?: number;
}

/** Distill one cluster via the LLM. Returns null on any failure (never throws). */
export async function distillLesson(
  cluster: DistillableCluster,
  llmRunner: LLMRunner,
  opts: DistillOptions = {},
): Promise<DistilledLesson | null> {
  try {
    const raw = await llmRunner.run({
      systemPrompt: LESSON_DISTILL_SYSTEM_PROMPT,
      prompt: buildDistillPrompt(cluster),
      taskId: "lesson-distill",
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    return parseDistilledLesson(raw);
  } catch {
    return null;
  }
}
