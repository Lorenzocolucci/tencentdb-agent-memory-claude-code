/**
 * Pilastro A slice 2 — graduated stance wiring in buildFileInjection.
 *
 * A resurfaced lesson stays a SOFT note by default (unchanged). But when the
 * CURRENT action crosses a one-way door (classifyStakes = high) AND a matched
 * lesson is well-attested, an ADDITIONAL block-before-acting interrupt is
 * surfaced for that single lesson (one at a time). Purely additive: with no
 * actionContent, or a benign action, or an under-attested lesson, the output is
 * exactly today's soft behavior.
 *
 * Pins:
 *   - one-way door + attested lesson → stance-interrupt block-before-acting,
 *     and that lesson is not duplicated as a soft note
 *   - benign action → no interrupt, lesson stays a soft note
 *   - one-way door + UNDER-attested lesson → no interrupt (cry-wolf guard), but
 *     the lesson still surfaces softly (backward compatible)
 *   - no actionContent → no interrupt (backward compatible)
 */

import { describe, it, expect } from "vitest";
import { buildFileInjection } from "../situation-injection.js";
import type { IMemoryStore, KbLessonHit } from "../../store/types.js";

function fakeStore(lessons: KbLessonHit[]): IMemoryStore {
  return {
    queryEntityByKey: () => ({ id: "ent_file_1", name: "deploy.ts" } as never),
    queryHeadFacts: () => [] as never,
    queryEventsForEntity: () => [] as never,
    queryHeadLessonsByFile: () => lessons,
  } as unknown as IMemoryStore;
}

const ATTESTED: KbLessonHit = {
  id: "les_1",
  domain: "deploy",
  lessonText: "You force-pushed to main here before and broke prod.",
  confidence: 0.9,
  evidenceCount: 3,
};
const WEAK: KbLessonHit = {
  id: "les_weak",
  domain: "deploy",
  lessonText: "Maybe unrelated once.",
  confidence: 0.4,
  evidenceCount: 1,
};

const ONE_WAY_DOOR = "git push --force origin main";
const BENIGN = "cat src/deploy.ts";

describe("buildFileInjection — graduated stance (Pilastro A slice 2)", () => {
  it("one-way door + attested lesson → block-before-acting interrupt (not duplicated as soft)", () => {
    const block = buildFileInjection(fakeStore([ATTESTED]), "/repo/src/deploy.ts", {
      actionContent: ONE_WAY_DOOR,
    });
    expect(block).toContain("block-before-acting");
    expect(block).toContain(ATTESTED.lessonText);
    // Not duplicated: the lesson text appears exactly once.
    const occurrences = block!.split(ATTESTED.lessonText).length - 1;
    expect(occurrences).toBe(1);
    // The hard one is not ALSO rendered as a soft "⚠️ lesson" note.
    expect(block).not.toContain(`⚠️ lesson [deploy, 3× evidence]`);
  });

  it("benign action → no interrupt, lesson stays a soft note", () => {
    const block = buildFileInjection(fakeStore([ATTESTED]), "/repo/src/deploy.ts", {
      actionContent: BENIGN,
    });
    expect(block).not.toContain("block-before-acting");
    expect(block).toContain("⚠️ lesson [deploy, 3× evidence]:");
  });

  it("one-way door + UNDER-attested lesson → no interrupt (cry-wolf guard) but still soft", () => {
    const block = buildFileInjection(fakeStore([WEAK]), "/repo/src/deploy.ts", {
      actionContent: ONE_WAY_DOOR,
    });
    expect(block).not.toContain("block-before-acting");
    expect(block).toContain(WEAK.lessonText); // still surfaces softly
  });

  it("no actionContent → no interrupt (backward compatible)", () => {
    const block = buildFileInjection(fakeStore([ATTESTED]), "/repo/src/deploy.ts");
    expect(block).not.toContain("block-before-acting");
    expect(block).toContain("⚠️ lesson [deploy, 3× evidence]:");
  });
});
