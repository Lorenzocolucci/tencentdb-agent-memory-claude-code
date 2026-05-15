import { describe, it, expect } from "vitest";
import { readLatestTurn, parseTranscriptLine } from "../lib/transcript.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/transcript-sample.jsonl");

describe("parseTranscriptLine", () => {
  it("parses a user message", () => {
    const line = '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1"}';
    const parsed = parseTranscriptLine(line);
    expect(parsed).toEqual({
      type: "user",
      role: "user",
      content: "hi",
      uuid: "u1",
    });
  });

  it("parses an assistant message", () => {
    const line = '{"type":"assistant","message":{"role":"assistant","content":"hello"},"uuid":"a1"}';
    const parsed = parseTranscriptLine(line);
    expect(parsed?.role).toBe("assistant");
    expect(parsed?.content).toBe("hello");
  });

  it("returns null for malformed JSON", () => {
    expect(parseTranscriptLine("{ not json }")).toBeNull();
  });

  it("returns null for messages without content", () => {
    const line = '{"type":"user","message":{"role":"user"},"uuid":"u1"}';
    expect(parseTranscriptLine(line)).toBeNull();
  });

  it("handles content array (multi-part messages) by joining strings", () => {
    const line = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"},{"type":"text","text":"world"}]},"uuid":"u1"}';
    const parsed = parseTranscriptLine(line);
    expect(parsed?.content).toBe("hello\nworld");
  });
});

describe("readLatestTurn", () => {
  it("returns the most recent user/assistant pair", async () => {
    const turn = await readLatestTurn(FIXTURE);
    expect(turn).not.toBeNull();
    expect(turn!.user).toBe("second question");
    expect(turn!.assistant).toBe("second answer");
  });

  it("returns null for a missing file", async () => {
    const turn = await readLatestTurn("/tmp/nonexistent-transcript-tdai.jsonl");
    expect(turn).toBeNull();
  });

  it("returns null for an empty file", async () => {
    const tmpPath = resolve(__dirname, "fixtures/empty.jsonl");
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpPath, "");
    try {
      const turn = await readLatestTurn(tmpPath);
      expect(turn).toBeNull();
    } finally {
      await fs.unlink(tmpPath);
    }
  });
});
