import { describe, it, expect } from "vitest";
import { selectThread } from "../recap-selector.js";
import type { KbEvent } from "../../store/types.js";

function evt(p: Partial<KbEvent>): KbEvent {
  return {
    id: "evt_x", ts: "2026-06-29T10:00:00.000Z", recorded_at: "2026-06-29T10:00:00.000Z",
    session_key: "s", session_id: "sid", namespace: "default", project: "proj",
    type: "observation", text: "t", language: "it", entities: [], source_message_ids: [],
    ...p,
  };
}

describe("selectThread", () => {
  it("keeps thread types, drops observations, derives project, picks latest task/decision as next-step", () => {
    const events: KbEvent[] = [
      evt({ id: "e1", type: "observation", text: "noise", source_message_ids: ["m0"] }),
      evt({ id: "e2", type: "decision", text: "chose B", source_message_ids: ["m1"], ts: "2026-06-29T10:01:00.000Z" }),
      evt({ id: "e3", type: "task", text: "next thing", source_message_ids: ["m2"], ts: "2026-06-29T10:02:00.000Z" }),
    ];
    const input = selectThread(events, "2026-06-29T10:02:00.000Z");
    expect(input.project).toBe("proj");
    expect(input.thread.map((t) => t.text)).not.toContain("noise");
    expect(input.thread.map((t) => t.text)).toContain("chose B");
    expect(input.nextStep?.text).toBe("next thing");
  });
  it("returns empty thread when only observations exist", () => {
    const input = selectThread([evt({ type: "observation", source_message_ids: ["m0"] })], "2026-06-29T10:00:00.000Z");
    expect(input.thread).toHaveLength(0);
    expect(input.nextStep).toBeUndefined();
  });
});
