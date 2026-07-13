/**
 * Principle distiller (Pilastro C, Fase 2) — turns one cross-session cluster of
 * recurring NON-failure decisions into a single reusable "hard-won principle"
 * via the LLM. Mirrors lessons-distiller: the runner is injected (LLMRunner), so
 * this is host-neutral and testable offline.
 *
 * Distinct from lessons (Pilastro A): a lesson is "what NOT to do again" from a
 * failure; a principle is "the earned rule of thumb" from repeated deliberate
 * choices. The prompt honestly frames the input as N recurrences of the same
 * kind of decision across different sessions.
 *
 * NEVER throws: a timeout, network error, or unparseable output yields `null` —
 * the orchestrator simply skips that cluster. Memory must never break the turn.
 *
 * NOTE: prompt is a first cut; have lo-llm-architect review before auto cadence.
 */
import type { LLMRunner } from "../types.js";
import { runWithoutCjk, hasCjk } from "../../utils/language-guard.js";

// ── Public types ───────────────────────────────────────────────────────────────

export interface DistilledPrinciple {
  /** Short language-neutral area, e.g. "pricing", "tone-of-voice". */
  domain: string;
  /** The earned principle — imperative, generalizing, in the conversation language. */
  principleText: string;
  /** Model self-confidence, clamped to [0,1]. */
  confidence: number;
}

/** Minimal cluster shape the distiller accepts. */
export interface DistillablePrincipleCluster {
  project: string;
  domainEntity: string;
  /** The recurring decision texts — presented as recurrences of one choice. */
  texts: string[];
}

// ── System prompt ──────────────────────────────────────────────────────────────

export const PRINCIPLE_DISTILL_SYSTEM_PROMPT =
  "You distill a set of recurring, deliberate decisions into ONE hard-won guiding principle.\n" +
  "You are given N RECURRENCES of the same kind of choice made across different sessions\n" +
  "(not a single decision, and NOT a failure to avoid — those are handled elsewhere).\n" +
  "Find the general rule the person keeps re-deciding: state it as an earned principle that\n" +
  "will guide a FUTURE similar choice, not a restatement of history.\n" +
  "Keep the principle in the SAME language as the input decisions (do not translate content).\n" +
  'Reply with STRICT JSON only — no prose, no markdown fences — of exactly this shape:\n' +
  '{"domain": string, "principle_text": string, "confidence": number}\n' +
  "- domain: 1-3 word language-neutral area (e.g. \"pricing\", \"tone\", \"scope-cut\").\n" +
  "- principle_text: one or two sentences, imperative, generalizing across the recurrences.\n" +
  "- confidence: 0..1, how sure you are this is a stable principle (not a coincidence).";

// ── Prompt builder ─────────────────────────────────────────────────────────────

export function buildPrinciplePrompt(c: DistillablePrincipleCluster): string {
  const recurrenceLines = c.texts.map((t, i) => `  RECURRENCE ${i + 1}: ${t}`).join("\n");
  return (
    `Project: ${c.project || "(unspecified)"}\n` +
    `Subject: ${c.domainEntity}\n` +
    `RECURRING DECISION — ${c.texts.length} occurrence(s) across different sessions:\n` +
    recurrenceLines + "\n\n" +
    `Distill the single hard-won principle as STRICT JSON.`
  );
}

// ── JSON parsing helpers (mirror lessons-distiller) ─────────────────────────────

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

export function parseDistilledPrinciple(raw: string): DistilledPrinciple | null {
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
  const principleText = typeof obj.principle_text === "string" ? obj.principle_text.trim() : "";
  if (!domain || !principleText) return null;
  return { domain, principleText, confidence: clamp01(obj.confidence) };
}

// ── Distiller ──────────────────────────────────────────────────────────────────

export interface DistillPrincipleOptions {
  timeoutMs?: number;
}

/** Distill one cluster via the LLM. Returns null on any failure (never throws). */
export async function distillPrinciple(
  cluster: DistillablePrincipleCluster,
  llmRunner: LLMRunner,
  opts: DistillPrincipleOptions = {},
): Promise<DistilledPrinciple | null> {
  try {
    // Language barrier: force a rewrite if the model slips into CJK.
    const raw = await runWithoutCjk(llmRunner, {
      systemPrompt: PRINCIPLE_DISTILL_SYSTEM_PROMPT,
      prompt: buildPrinciplePrompt(cluster),
      taskId: "principle-distill",
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    const parsed = parseDistilledPrinciple(raw);
    // Reject a residual-CJK principle rather than store garbage (skip the cluster).
    if (parsed && hasCjk(parsed.principleText)) return null;
    return parsed;
  } catch {
    return null;
  }
}
