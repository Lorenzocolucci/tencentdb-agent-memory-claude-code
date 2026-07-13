/**
 * resolveRecentEventText — the banner's "ultimo: …" must be the last work of the
 * CURRENT project, scoped by sessionKey (per-project). Regression: the old global
 * `listRecentEvents("default")` leaked another project's last work (TutorAI's recap
 * surfacing when opening Sofia). NON-circular: the fake store returns fixed per-key
 * event lists; the assertion is which project's text comes back.
 */
import { describe, it, expect } from "vitest";
import { resolveRecentEventText } from "../auto-recall.js";

type Ev = { ts: string; type: string; text: string };
function store(bySession: Record<string, Ev[]>): any {
  return { listEventsBySession: (sk: string) => bySession[sk] ?? [] };
}

const tutor: Ev[] = [
  { ts: "2026-07-03T13:00:00Z", type: "event", text: "TutorAI score 77.6" },
  { ts: "2026-07-03T12:00:00Z", type: "event", text: "TutorAI older" },
];
const sofia: Ev[] = [{ ts: "2026-07-02T23:00:00Z", type: "event", text: "Sofia payment fix" }];

describe("resolveRecentEventText — per-project scoping", () => {
  const s = store({ keyTutor: tutor, keySofia: sofia });

  it("returns the latest event of the REQUESTED project, not another", () => {
    expect(resolveRecentEventText(s, "keySofia")).toBe("Sofia payment fix");
    expect(resolveRecentEventText(s, "keyTutor")).toBe("TutorAI score 77.6");
  });

  it("skips session_recap meta-events (returns the last REAL work)", () => {
    const withRecap = store({
      k: [
        { ts: "2026-07-03T14:00:00Z", type: "session_recap", text: "DOVE ERAVAMO…" },
        { ts: "2026-07-03T13:00:00Z", type: "event", text: "il lavoro vero" },
      ],
    });
    expect(resolveRecentEventText(withRecap, "k")).toBe("il lavoro vero");
  });

  it("returns undefined for a project with no events (banner drops 'ultimo', no bleed)", () => {
    expect(resolveRecentEventText(s, "unknownKey")).toBeUndefined();
  });

  it("returns undefined without a sessionKey (never global-bleeds)", () => {
    expect(resolveRecentEventText(s)).toBeUndefined();
  });
});
