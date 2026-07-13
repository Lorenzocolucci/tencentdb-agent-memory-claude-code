import { describe, it, expect } from "vitest";
import { latestRecapBlock } from "../recap-retrieval.js";
import type { KbEvent } from "../../store/types.js";

function recapEvt(text: string): KbEvent {
  return {
    id: "r", ts: "2026-06-29T11:00:00.000Z", recorded_at: "r", session_key: "sk1",
    session_id: "sid", namespace: "default", project: "", type: "session_recap",
    text, language: "it", entities: [], source_message_ids: [],
  };
}

describe("latestRecapBlock", () => {
  it("returns a <session-recap> block for the latest recap of the session_key", () => {
    const store = {
      latestEventBySessionKeyType: (k: string, t: string) =>
        k === "sk1" && t === "session_recap"
          ? recapEvt("DOVE ERAVAMO — proj\n- (decision) x [anchor: msg m1]")
          : undefined,
    } as any;
    const out = latestRecapBlock({ store, sessionKey: "sk1" });
    expect(out).toContain("<session-recap>");
    expect(out).toContain("DOVE ERAVAMO — proj");
  });

  it("returns '' when no recap exists or sessionKey is empty", () => {
    const store = { latestEventBySessionKeyType: () => undefined } as any;
    expect(latestRecapBlock({ store, sessionKey: "sk1" })).toBe("");
    expect(latestRecapBlock({ store, sessionKey: "" })).toBe("");
  });

  it("returns '' and never throws when store lacks the method", () => {
    expect(latestRecapBlock({ store: {} as any, sessionKey: "sk1" })).toBe("");
  });
});
