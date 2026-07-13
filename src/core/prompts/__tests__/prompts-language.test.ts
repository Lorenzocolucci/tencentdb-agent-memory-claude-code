/**
 * Prompt + injected-display LANGUAGE guard (TDD for the "Chinese → English" fix).
 *
 * ROOT CAUSE (verified 2026-06-29): every memory-extraction system prompt and
 * every injected display template was authored in Chinese. The live extraction
 * model (Kimi/Moonshot) then defaulted to Chinese / script-mixed mojibake for the
 * STORED content, despite the in-prompt "use the conversation language" rule.
 *
 * THE GOAL this test encodes (non-circular: it asserts the property we want, not
 * the implementation):
 *   1. No prompt / injected-display string contains CJK characters — the prompt
 *      text itself must be English.
 *   2. Each EXTRACTION prompt still carries an explicit output-language rule that
 *      pins the stored content to the CONVERSATION's language (NOT English). This
 *      is the guard that keeps Lorenzo's Italian memories Italian: translating the
 *      prompt must not accidentally force English content.
 *
 * RED before the translation, GREEN after. A future regression that reintroduces
 * a Chinese prompt fails (1); one that forces English content fails (2).
 */

import { describe, it, expect } from "vitest";

import { KB_EXTRACTION_SYSTEM_PROMPT, formatKbExtractionPrompt } from "../kb-extraction.js";
import { EXTRACT_MEMORIES_SYSTEM_PROMPT, formatExtractionPrompt } from "../l1-extraction.js";
import { CONFLICT_DETECTION_SYSTEM_PROMPT } from "../l1-dedup.js";
import { buildSceneExtractionPrompt } from "../scene-extraction.js";
import { buildPersonaPrompt } from "../persona-generation.js";
import { generateSceneNavigation } from "../../scene/scene-navigation.js";
import { MEMORY_TOOLS_GUIDE, RELEVANT_MEMORIES_HEADER } from "../../hooks/recall-display.js";

/**
 * CJK detector. Covers CJK Unified Ideographs + Ext-A, CJK symbols & punctuation
 * (。，：「」（） …), and fullwidth/halfwidth forms — i.e. everything a Chinese
 * prompt would contain. Latin, digits, emoji and box-drawing are intentionally
 * NOT flagged (a prompt may legitimately use ─ or 🧬).
 */
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/u;

function firstCjk(text: string): string | null {
  const m = text.match(CJK);
  if (!m) return null;
  const idx = m.index ?? 0;
  return text.slice(Math.max(0, idx - 30), idx + 30);
}

function expectNoCjk(label: string, text: string): void {
  const sample = firstCjk(text);
  expect(sample, `${label} still contains CJK near: «${sample}»`).toBeNull();
}

// A tiny but representative pair of messages for the user-prompt builders.
const sampleMessages = [
  { id: "m1", role: "user" as const, content: "Let's use PostgreSQL 16.", timestamp: Date.parse("2026-06-29T10:00:00Z") },
  { id: "m2", role: "assistant" as const, content: "Agreed.", timestamp: Date.parse("2026-06-29T10:00:30Z") },
];

describe("extraction prompts are English (no CJK)", () => {
  it("KB extraction system prompt + user builder have no CJK", () => {
    expectNoCjk("KB_EXTRACTION_SYSTEM_PROMPT", KB_EXTRACTION_SYSTEM_PROMPT);
    const user = formatKbExtractionPrompt({ newMessages: sampleMessages, knownEntities: ["Sofia"] });
    expectNoCjk("formatKbExtractionPrompt", user);
  });

  it("L1 extraction system prompt + user builder have no CJK", () => {
    expectNoCjk("EXTRACT_MEMORIES_SYSTEM_PROMPT", EXTRACT_MEMORIES_SYSTEM_PROMPT);
    const user = formatExtractionPrompt({ newMessages: sampleMessages });
    expectNoCjk("formatExtractionPrompt", user);
  });

  it("L1 dedup / conflict-detection system prompt has no CJK", () => {
    expectNoCjk("CONFLICT_DETECTION_SYSTEM_PROMPT", CONFLICT_DETECTION_SYSTEM_PROMPT);
  });

  it("scene-extraction system + user prompt have no CJK", () => {
    const { systemPrompt, userPrompt } = buildSceneExtractionPrompt({
      memoriesJson: "[]",
      sceneSummaries: "(none)",
      currentTimestamp: "2026-06-29T10:00:00Z",
      maxScenes: 15,
    });
    expectNoCjk("scene-extraction systemPrompt", systemPrompt);
    expectNoCjk("scene-extraction userPrompt", userPrompt);
  });

  it("persona-generation system + user prompt have no CJK", () => {
    const { systemPrompt, userPrompt } = buildPersonaPrompt({
      mode: "first",
      currentTime: "2026-06-29T10:00:00Z",
      totalProcessed: 10,
      sceneCount: 2,
      changedSceneCount: 1,
      changedScenesContent: "scene body",
      personaFilePath: "persona.md",
      checkpointPath: "cp.json",
    });
    expectNoCjk("persona-generation systemPrompt", systemPrompt);
    expectNoCjk("persona-generation userPrompt", userPrompt);
  });
});

describe("injected display templates are English (no CJK)", () => {
  it("scene navigation output has no CJK", () => {
    const nav = generateSceneNavigation([
      { filename: "scene-sofia.md", summary: "Sofia: 3 event(s)", heat: 120, created: "2026-06-01", updated: "2026-06-29" },
    ]);
    expectNoCjk("generateSceneNavigation", nav);
  });

  it("memory-tools guide + relevant-memories header have no CJK", () => {
    expectNoCjk("MEMORY_TOOLS_GUIDE", MEMORY_TOOLS_GUIDE);
    expectNoCjk("RELEVANT_MEMORIES_HEADER", RELEVANT_MEMORIES_HEADER);
  });
});

describe("extraction prompts pin content to the CONVERSATION language (not English)", () => {
  // The translated prompt must STILL instruct the model to write stored content
  // in the conversation's own language — otherwise Italian memories become
  // English. We assert the directive survives translation by checking the prompt
  // mentions the conversation/source language as the output-language rule.
  const conversationLangRule = /conversation['’]?s? (?:own )?language|source language|language of the (?:conversation|window|messages)/i;

  it("KB extraction keeps the conversation-language output rule", () => {
    expect(conversationLangRule.test(KB_EXTRACTION_SYSTEM_PROMPT)).toBe(true);
  });

  it("L1 extraction keeps the conversation-language output rule", () => {
    expect(conversationLangRule.test(EXTRACT_MEMORIES_SYSTEM_PROMPT)).toBe(true);
  });
});
