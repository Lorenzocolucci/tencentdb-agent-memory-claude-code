/**
 * B2b injection — buildFileInjection surfaces a file's recurring-failure lesson.
 *
 * Pins: (1) a lesson appears in the <file-memory> block when the touched file is
 * in its trigger; (2) a file with ONLY a lesson (no facts/events) STILL surfaces
 * — the whole point of the Mistake Notebook is "you've failed here before", even
 * if nothing else is tied to the file; (3) silent-unless-relevant holds when the
 * file has nothing at all.
 */

import { describe, it, expect } from "vitest";
import { buildFileInjection } from "../situation-injection.js";
import type { IMemoryStore, KbLessonHit } from "../../store/types.js";

/** Minimal fake store exposing only what buildFileInjection reads. */
function fakeStore(opts: {
  entityId?: string;
  facts?: Array<{ attribute: string; value: string }>;
  events?: Array<{ type: string; text: string }>;
  lessons?: KbLessonHit[];
}): IMemoryStore {
  const { entityId = "ent_file_1", facts = [], events = [], lessons = [] } = opts;
  return {
    queryEntityByKey: () => (entityId ? ({ id: entityId, name: "telegram.ts" } as never) : null),
    queryHeadFacts: () => facts as never,
    queryEventsForEntity: () => events as never,
    queryHeadLessonsByFile: () => lessons,
  } as unknown as IMemoryStore;
}

describe("buildFileInjection with lessons (B2b)", () => {
  it("includes the lesson line when the touched file has a matching lesson", () => {
    const store = fakeStore({
      facts: [{ attribute: "owner", value: "team-notify" }],
      lessons: [{ domain: "notification-services", lessonText: "Check the outbox state first.", confidence: 0.8, evidenceCount: 3 }],
    });
    const block = buildFileInjection(store, "/repo/src/telegram.ts");
    expect(block).toContain("<file-memory>");
    expect(block).toContain("⚠️ lesson [notification-services, 3× evidence]: Check the outbox state first.");
    // Lesson is listed BEFORE the raw fact (warning outranks facts).
    expect(block!.indexOf("lesson")).toBeLessThan(block!.indexOf("owner"));
  });

  it("surfaces a file that has ONLY a lesson (no facts/events)", () => {
    const store = fakeStore({
      lessons: [{ domain: "d", lessonText: "Recurring failure here.", confidence: 0.6, evidenceCount: 2 }],
    });
    const block = buildFileInjection(store, "/repo/src/telegram.ts");
    expect(block).not.toBeNull();
    expect(block).toContain("Recurring failure here.");
  });

  it("stays silent when the file has no facts, events, or lessons", () => {
    const store = fakeStore({});
    expect(buildFileInjection(store, "/repo/src/telegram.ts")).toBeNull();
  });
});
