import { describe, it, expect, vi } from "vitest";
import { captureSessionRecap } from "../recap-capture.js";
import type { KbEvent, KbEventInput } from "../../store/types.js";

function evt(p: Partial<KbEvent>): KbEvent {
  return {
    id: "e", ts: "2026-06-29T10:00:00.000Z", recorded_at: "r", session_key: "s1",
    session_id: "sid", namespace: "default", project: "proj", type: "decision",
    text: "chose B", language: "it", entities: [], source_message_ids: ["m1"], ...p,
  };
}

describe("captureSessionRecap", () => {
  it("inserts a session_recap event built from the session's thread", () => {
    const inserted: KbEventInput[] = [];
    const store = {
      listEventsBySession: () => [
        evt({}),
        evt({ id: "e2", type: "task", text: "next", source_message_ids: ["m2"], ts: "2026-06-29T10:05:00.000Z" }),
      ],
      insertEvent: (e: KbEventInput) => { inserted.push(e); return evt({}); },
    } as any;
    captureSessionRecap({ store, sessionKey: "s1", now: "2026-06-29T11:00:00.000Z" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].type).toBe("session_recap");
    expect(inserted[0].project).toBe("proj");
    expect(inserted[0].text).toContain("chose B");
    expect(inserted[0].sourceMessageIds).toEqual(expect.arrayContaining(["m1", "m2"]));
  });

  it("does NOT insert when there is no thread (only observations)", () => {
    const insert = vi.fn();
    const store = { listEventsBySession: () => [evt({ type: "observation" })], insertEvent: insert } as any;
    captureSessionRecap({ store, sessionKey: "s1", now: "2026-06-29T11:00:00.000Z" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("scopes the recap to the most recent session_id (excludes older sessions under the same key)", () => {
    const inserted: KbEventInput[] = [];
    const store = {
      listEventsBySession: () => [
        evt({ id: "old", session_id: "sid_old", type: "decision", text: "OLD session decision", source_message_ids: ["mo"], ts: "2026-06-20T10:00:00.000Z" }),
        evt({ id: "new", session_id: "sid_new", type: "decision", text: "NEW session decision", source_message_ids: ["mn"], ts: "2026-06-29T10:00:00.000Z" }),
      ],
      insertEvent: (e: KbEventInput) => { inserted.push(e); return evt({}); },
    } as any;
    captureSessionRecap({ store, sessionKey: "s1", now: "2026-06-29T11:00:00.000Z" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].text).toContain("NEW session decision");
    expect(inserted[0].text).not.toContain("OLD session decision");
  });

  it("never throws when the store lacks listEventsBySession", () => {
    expect(() => captureSessionRecap({ store: {} as any, sessionKey: "s1", now: "n" })).not.toThrow();
  });
});
