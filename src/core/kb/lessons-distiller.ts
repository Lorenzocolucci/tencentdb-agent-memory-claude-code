/**
 * Lesson distiller (Phase B, B2a+) — turns one cross-session failure cluster
 * into a reusable lesson via the LLM. The runner is injected (LLMRunner), so
 * this is host-neutral and testable offline.
 *
 * B2a contract changes (vs B1):
 *   - trigger_pattern is REMOVED from DistilledLesson and from the JSON contract.
 *     The LLM now returns only: domain, lesson_text, anti_patterns, confidence.
 *     trigger_pattern is set deterministically by lesson-trigger.ts (canonical
 *     fingerprint), never by the LLM.
 *   - The prompt now honestly describes the input as "N recurrences of the same
 *     class of failure across different sessions" + "fix(es) that resolved them
 *     (if known)". The LLM distils ONE generalizable lesson for the class.
 *
 * Contract with the rest of Phase B: NEVER throws. A timeout, network error, or
 * unparseable model output yields `null` — the orchestrator simply skips that
 * cluster. Memory must never break the conversation.
 *
 * NOTE: prompt is a first cut; have lo-llm-architect review before auto cadence.
 */

import type { LLMRunner } from "../types.js";
import { runWithoutCjk, hasCjk } from "../../utils/language-guard.js";

// ── Public types ───────────────────────────────────────────────────────────────

/** The model's distilled output for one cluster (B2a: no trigger_pattern). */
export interface DistilledLesson {
  /** Short language-neutral area, e.g. "circuit-breaker", "twilio-templates". */
  domain: string;
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
  /** All bug event texts — presented as recurrences of the same failure class. */
  bugTexts: string[];
  /**
   * Fix event texts pulled from fixed-by / caused relations (may be empty).
   * An empty list means the resolution is unknown; the lesson can still
   * warn about the recurring class of failure.
   */
  fixTexts: string[];
}

// ── System prompt ──────────────────────────────────────────────────────────────

export const LESSON_DISTILL_SYSTEM_PROMPT =
  "You distill a class of recurring software failures into a single reusable engineering lesson.\n" +
  "You are given N RECURRENCES of the same failure across different sessions (not a single incident)\n" +
  "and optionally the fix(es) that resolved one or more of them.\n" +
  "Be specific and general at once: the lesson must help in a FUTURE similar situation, not restate history.\n" +
  'Reply with STRICT JSON only — no prose, no markdown fences — of exactly this shape:\n' +
  '{"domain": string, "lesson_text": string, "anti_patterns": string[], "confidence": number}\n' +
  "- domain: 2-4 word language-neutral area (e.g. \"circuit-breaker\", \"jwt-refresh\").\n" +
  "- lesson_text: one or two sentences, imperative, actionable. If fixes are unknown,\n" +
  "  describe the class of failure and advise investigation.\n" +
  "- anti_patterns: short phrases of what NOT to do (may be empty).\n" +
  "- confidence: 0..1, how sure you are this generalises across sessions.";

// ── Prompt builder ─────────────────────────────────────────────────────────────

/** Build the user prompt carrying the failure context (recurrences + fixes). */
export function buildDistillPrompt(c: DistillableCluster): string {
  const n = c.bugTexts.length;
  const recurrenceLines = c.bugTexts
    .map((t, i) => `  RECURRENCE ${i + 1}: ${t}`)
    .join("\n");

  const fixSection =
    c.fixTexts.length > 0
      ? c.fixTexts.map((t, i) => `  ${i + 1}. ${t}`).join("\n")
      : "  (unknown — the resolution was not captured)";

  return (
    `Project: ${c.project || "(unspecified)"}\n` +
    `FAILURE CLASS — ${n} recurrence(s) across different sessions:\n` +
    recurrenceLines + "\n\n" +
    `KNOWN FIX(ES) (how at least one recurrence was resolved):\n` +
    fixSection + "\n\n" +
    `Distill the single reusable lesson as STRICT JSON.`
  );
}

// ── JSON parsing helpers ───────────────────────────────────────────────────────

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

// ── Parser ─────────────────────────────────────────────────────────────────────

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
  const lessonText = typeof obj.lesson_text === "string" ? obj.lesson_text.trim() : "";
  // trigger_pattern is intentionally ignored if present in the LLM response —
  // the runner derives it from canonicalTrigger(clusterTrigger(...)).
  if (!domain || !lessonText) return null;
  return {
    domain,
    lessonText,
    antiPatterns: stringArray(obj.anti_patterns),
    confidence: clamp01(obj.confidence),
  };
}

// ── Distiller ──────────────────────────────────────────────────────────────────

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
    // Language barrier: force a rewrite if the model slips into CJK.
    const raw = await runWithoutCjk(llmRunner, {
      systemPrompt: LESSON_DISTILL_SYSTEM_PROMPT,
      prompt: buildDistillPrompt(cluster),
      taskId: "lesson-distill",
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    const parsed = parseDistilledLesson(raw);
    // Reject a residual-CJK lesson rather than store garbage (skip the cluster).
    if (parsed && (hasCjk(parsed.lessonText) || hasCjk(parsed.domain))) return null;
    return parsed;
  } catch {
    return null;
  }
}
