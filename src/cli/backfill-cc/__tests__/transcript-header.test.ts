import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTranscriptHeader } from "../transcript-header.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "__fixtures__");

describe("readTranscriptHeader", () => {
  it("extracts cwd, sessionId and counts turns equal to the readAllTurns fold rule", async () => {
    const header = await readTranscriptHeader(join(FIXTURES, "two-turns.jsonl"));
    expect(header.cwd).toBe("C:\\Sofia-AI");
    expect(header.sessionId).toBe("11111111-1111-1111-1111-111111111111");
    // 2 real turns; the array-content (tool_result) user line in between must
    // NOT open or close a turn boundary (see readAllTurns's `!contentIsArray` guard).
    expect(header.turns).toBe(2);
    expect(header.readError).toBeNull();
  });

  it("captures the first string-content user message for the Argus heuristic", async () => {
    const header = await readTranscriptHeader(join(FIXTURES, "argus-child.jsonl"));
    expect(header.firstUserText).toContain("Sei Argus e stai scrivendo a Lorenzo");
    expect(header.turns).toBe(1);
    expect(header.cwd).toBe("C:\\Argus");
    expect(header.sessionId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("returns nulls (not a throw) when no line carries cwd/sessionId", async () => {
    const header = await readTranscriptHeader(join(FIXTURES, "no-header.jsonl"));
    expect(header.cwd).toBeNull();
    expect(header.sessionId).toBeNull();
    expect(header.turns).toBe(0);
    expect(header.readError).toBeNull();
  });

  it("reports a readError instead of throwing when the file does not exist", async () => {
    const header = await readTranscriptHeader(join(FIXTURES, "does-not-exist.jsonl"));
    expect(header.readError).not.toBeNull();
    expect(header.cwd).toBeNull();
    expect(header.turns).toBe(0);
  });

  it("does not count a trailing user line with no following assistant block", async () => {
    // Regression for the readAllTurns EOF-flush guard: a dangling question
    // with no answer yet must not inflate the turn count.
    const path = join(FIXTURES, "_dangling-user.jsonl");
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      path,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "answered" },
          cwd: "C:\\X",
          sessionId: "s1",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "yes" },
          cwd: "C:\\X",
          sessionId: "s1",
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "unanswered" },
          cwd: "C:\\X",
          sessionId: "s1",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    try {
      const header = await readTranscriptHeader(path);
      expect(header.turns).toBe(1);
    } finally {
      await fs.rm(path, { force: true });
    }
  });
});
