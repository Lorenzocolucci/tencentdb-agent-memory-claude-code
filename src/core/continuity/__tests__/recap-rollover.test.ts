import { describe, it, expect, vi } from "vitest";
import { captureRolloverRecap } from "../recap-rollover.js";
import type { KbEvent, KbEventInput } from "../../store/types.js";

function evt(p: Partial<KbEvent>): KbEvent {
  return {
    id: "e", ts: "2026-06-29T10:00:00.000Z", recorded_at: "r", session_key: "s1",
    session_id: "sid", namespace: "default", project: "proj", type: "decision",
    text: "chose B", language: "it", entities: [], source_message_ids: ["m1"], ...p,
  };
}

describe("captureRolloverRecap", () => {
  it("captures the PREVIOUS session's recap when a new session opens", () => {
    const inserted: KbEventInput[] = [];
    const store = {
      listEventsBySession: () => [
        evt({ id: "a1", session_id: "A", type: "decision", text: "PREV session decision", source_message_ids: ["ma"], ts: "2026-06-30T10:00:00.000Z" }),
        // the just-opened session has not produced thread events yet at recall time
        evt({ id: "b1", session_id: "B", type: "observation", text: "current noise", ts: "2026-07-01T09:00:00.000Z" }),
      ],
      insertEvent: (e: KbEventInput) => { inserted.push(e); return evt({}); },
    } as any;

    captureRolloverRecap({ store, sessionKey: "s1", currentSessionId: "B", now: "2026-07-01T09:01:00.000Z" });

    expect(inserted).toHaveLength(1);
    expect(inserted[0].type).toBe("session_recap");
    expect(inserted[0].sessionId).toBe("A"); // idempotency key = described session
    expect(inserted[0].text).toContain("PREV session decision");
  });

  it("is idempotent — no duplicate recap for a session already captured", () => {
    const insert = vi.fn();
    const store = {
      listEventsBySession: () => [
        evt({ id: "a1", session_id: "A", type: "decision", text: "PREV decision", source_message_ids: ["ma"], ts: "2026-06-30T10:00:00.000Z" }),
        evt({ id: "r1", session_id: "A", type: "session_recap", text: "DOVE ERAVAMO ...", ts: "2026-06-30T10:05:00.000Z" }),
      ],
      insertEvent: insert,
    } as any;

    captureRolloverRecap({ store, sessionKey: "s1", currentSessionId: "B", now: "2026-07-01T09:01:00.000Z" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("RE-CAPTURES when the session accumulated events after its last recap (no freeze)", () => {
    const inserted: KbEventInput[] = [];
    const store = {
      listEventsBySession: () => [
        // an early recap captured mid-session...
        evt({ id: "r1", session_id: "A", type: "session_recap", text: "DOVE ERAVAMO (early)", ts: "2026-06-30T13:00:00.000Z" }),
        // ...but the session kept working AFTER it.
        evt({ id: "a1", session_id: "A", type: "decision", text: "afternoon decision", source_message_ids: ["ma"], ts: "2026-06-30T14:30:00.000Z" }),
      ],
      insertEvent: (e: KbEventInput) => { inserted.push(e); return evt({}); },
    } as any;

    captureRolloverRecap({ store, sessionKey: "s1", currentSessionId: "B", now: "2026-06-30T20:00:00.000Z" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].sessionId).toBe("A");
    expect(inserted[0].text).toContain("afternoon decision");
  });

  it("no-ops when only the current session exists (no previous session to capture)", () => {
    const insert = vi.fn();
    const store = {
      listEventsBySession: () => [
        evt({ id: "b1", session_id: "B", type: "decision", text: "current decision", ts: "2026-07-01T09:00:00.000Z" }),
      ],
      insertEvent: insert,
    } as any;

    captureRolloverRecap({ store, sessionKey: "s1", currentSessionId: "B", now: "2026-07-01T09:01:00.000Z" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("ignores recap-type events when picking the previous session", () => {
    const inserted: KbEventInput[] = [];
    const store = {
      listEventsBySession: () => [
        evt({ id: "a1", session_id: "A", type: "decision", text: "real prev decision", source_message_ids: ["ma"], ts: "2026-06-30T10:00:00.000Z" }),
        // a later recap event tagged to some session must NOT be treated as the "previous session"
        evt({ id: "rZ", session_id: "Z", type: "session_recap", text: "DOVE ERAVAMO Z", ts: "2026-06-30T23:00:00.000Z" }),
      ],
      insertEvent: (e: KbEventInput) => { inserted.push(e); return evt({}); },
    } as any;

    captureRolloverRecap({ store, sessionKey: "s1", currentSessionId: "B", now: "2026-07-01T09:01:00.000Z" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].sessionId).toBe("A");
    expect(inserted[0].text).toContain("real prev decision");
  });

  it("never throws when the store lacks capabilities", () => {
    expect(() => captureRolloverRecap({ store: {} as any, sessionKey: "s1", currentSessionId: "B", now: "n" })).not.toThrow();
  });
});
