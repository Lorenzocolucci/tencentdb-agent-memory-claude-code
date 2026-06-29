import { describe, it, expect } from "vitest";
import { latestRecapBlock } from "../recap-retrieval.js";
import type { KbEvent } from "../../store/types.js";

function recapEvt(text: string): KbEvent {
  return {
    id: "r", ts: "2026-06-29T11:00:00.000Z", recorded_at: "r", session_key: "s",
    session_id: "sid", namespace: "default", project: "proj", type: "session_recap",
    text, language: "it", entities: [], source_message_ids: [],
  };
}

describe("latestRecapBlock", () => {
  it("returns a <session-recap> block for the latest recap of the project", () => {
    const store = {
      latestEventByProjectType: (p: string, t: string) =>
        p === "proj" && t === "session_recap"
          ? recapEvt("DOVE ERAVAMO — proj\n- (decision) x [anchor: msg m1]")
          : undefined,
    } as any;
    const out = latestRecapBlock({ store, project: "proj" });
    expect(out).toContain("<session-recap>");
    expect(out).toContain("DOVE ERAVAMO — proj");
  });

  it("returns '' when no recap exists or project is empty", () => {
    const store = { latestEventByProjectType: () => undefined } as any;
    expect(latestRecapBlock({ store, project: "proj" })).toBe("");
    expect(latestRecapBlock({ store, project: "" })).toBe("");
  });

  it("returns '' and never throws when store lacks the method", () => {
    expect(latestRecapBlock({ store: {} as any, project: "proj" })).toBe("");
  });
});
