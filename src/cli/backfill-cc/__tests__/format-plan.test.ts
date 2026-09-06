import { describe, it, expect } from "vitest";
import { formatPlanTable } from "../format-plan.js";
import type { Plan } from "../types.js";

function plan(): Plan {
  return {
    generatedAt: "2026-09-05T00:00:00.000Z",
    projectsRoot: "C:\\projects",
    dataDir: "C:\\data",
    totals: {
      "captured-complete": { count: 1, bytes: 100 },
      "captured-partial": { count: 1, bytes: 200 },
      "never-captured": { count: 2, bytes: 300 },
      "argus-child": { count: 3, bytes: 400 },
      unreadable: { count: 0, bytes: 0 },
    },
    rows: [
      {
        projectDirName: "P",
        transcriptPath: "C:\\p\\a.jsonl",
        bytes: 100,
        sessionId: "sess-partial",
        cwd: "C:\\p",
        sessionKey: "key1",
        turns: 2,
        cursorTurns: 1,
        cls: "captured-partial",
      },
      {
        projectDirName: "P",
        transcriptPath: "C:\\p\\b.jsonl",
        bytes: 100,
        sessionId: "sess-never",
        cwd: "C:\\p",
        sessionKey: "key1",
        turns: 1,
        cursorTurns: null,
        cls: "never-captured",
      },
      {
        projectDirName: "C--Argus",
        transcriptPath: "C:\\p\\c.jsonl",
        bytes: 100,
        sessionId: "sess-argus",
        cwd: "C:\\Argus",
        sessionKey: "key2",
        turns: 1,
        cursorTurns: null,
        cls: "argus-child",
      },
    ],
  };
}

describe("formatPlanTable", () => {
  it("lists every class total and the replay candidates, excluding argus-child by default", () => {
    const text = formatPlanTable(plan(), false);
    expect(text).toContain("never-captured");
    expect(text).toContain("argus-child excluded");
    expect(text).toContain("sess-never");
    expect(text).toContain("sess-partial");
    expect(text).not.toContain("sess-argus");
  });

  it("includes argus-child candidates when includeArgusChildren is true", () => {
    const text = formatPlanTable(plan(), true);
    expect(text).toContain("including argus-child");
    expect(text).toContain("sess-argus");
  });
});
