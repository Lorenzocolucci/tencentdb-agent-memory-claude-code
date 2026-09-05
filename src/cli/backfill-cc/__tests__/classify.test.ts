import { describe, it, expect } from "vitest";
import { classifyTranscript } from "../classify.js";
import { getSessionKey } from "../../../../claude-code-plugin/lib/session-key.js";
import type { EnumeratedTranscript, TranscriptHeader } from "../types.js";

const file: EnumeratedTranscript = {
  projectDirName: "C--Sofia-AI",
  transcriptPath: "C:\\fake\\C--Sofia-AI\\s1.jsonl",
  bytes: 1234,
};

function header(overrides: Partial<TranscriptHeader> = {}): TranscriptHeader {
  return {
    cwd: "C:\\Sofia-AI",
    sessionId: "s1",
    turns: 2,
    firstUserText: "hello",
    readError: null,
    ...overrides,
  };
}

describe("classifyTranscript", () => {
  it("is unreadable when the stream itself errored", () => {
    const row = classifyTranscript(file, header({ readError: "ENOENT" }), null);
    expect(row.cls).toBe("unreadable");
    expect(row.reason).toContain("ENOENT");
  });

  it("is unreadable when cwd is missing even if sessionId is present", () => {
    const row = classifyTranscript(file, header({ cwd: null }), null);
    expect(row.cls).toBe("unreadable");
    expect(row.sessionKey).toBeNull();
  });

  it("is unreadable when sessionId is missing even if cwd is present", () => {
    const row = classifyTranscript(file, header({ sessionId: null }), null);
    expect(row.cls).toBe("unreadable");
  });

  it("is captured-complete when the cursor already reached the turn count", () => {
    const row = classifyTranscript(file, header({ turns: 5 }), 5);
    expect(row.cls).toBe("captured-complete");
    expect(row.sessionKey).toBe(getSessionKey("C:\\Sofia-AI"));
  });

  it("is captured-complete when the cursor is AHEAD of the turn count (defensive >=)", () => {
    const row = classifyTranscript(file, header({ turns: 3 }), 10);
    expect(row.cls).toBe("captured-complete");
  });

  it("is captured-partial when the cursor is behind the turn count", () => {
    const row = classifyTranscript(file, header({ turns: 5 }), 2);
    expect(row.cls).toBe("captured-partial");
  });

  it("is never-captured when there is no cursor and it does not look like an Argus child", () => {
    const row = classifyTranscript(file, header(), null);
    expect(row.cls).toBe("never-captured");
  });

  it("is argus-child when there is no cursor, the dir matches, turns===1, and the marker matches", () => {
    const argusFile: EnumeratedTranscript = { ...file, projectDirName: "C--Argus" };
    const row = classifyTranscript(
      argusFile,
      header({ turns: 1, firstUserText: "Sei Argus e stai scrivendo a Lorenzo." }),
      null,
    );
    expect(row.cls).toBe("argus-child");
  });

  it("prefers cursor-based classification OVER the Argus-child heuristic when a cursor exists", () => {
    const argusFile: EnumeratedTranscript = { ...file, projectDirName: "C--Argus" };
    const row = classifyTranscript(
      argusFile,
      header({ turns: 1, firstUserText: "Sei Argus e stai scrivendo a Lorenzo." }),
      1,
    );
    expect(row.cls).toBe("captured-complete");
  });
});
