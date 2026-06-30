/**
 * Tests for resolveKbExtractionSystemPrompt — the opt-in extraction-prompt
 * override used by the LongMemEval benchmark. Default behavior (no env var)
 * MUST be the built-in prompt, so product extraction is unchanged.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KB_EXTRACTION_SYSTEM_PROMPT,
  resolveKbExtractionSystemPrompt,
} from "../kb-extraction.js";

const ENV = "TDAI_KB_EXTRACTION_PROMPT_FILE";

afterEach(() => {
  delete process.env[ENV];
});

describe("resolveKbExtractionSystemPrompt", () => {
  it("returns the built-in prompt when the env var is unset (product default unchanged)", () => {
    delete process.env[ENV];
    expect(resolveKbExtractionSystemPrompt()).toBe(KB_EXTRACTION_SYSTEM_PROMPT);
  });

  it("returns the file contents when the env var points to a readable file", () => {
    const tmp = path.join(os.tmpdir(), `kbprompt-${process.pid}.txt`);
    fs.writeFileSync(tmp, "CUSTOM GENERIC EXTRACTION PROMPT");
    process.env[ENV] = tmp;
    try {
      expect(resolveKbExtractionSystemPrompt()).toBe("CUSTOM GENERIC EXTRACTION PROMPT");
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("falls back to the built-in prompt when the override path is unreadable (never throws)", () => {
    process.env[ENV] = path.join(os.tmpdir(), "does-not-exist-kbprompt-xyz.txt");
    expect(resolveKbExtractionSystemPrompt()).toBe(KB_EXTRACTION_SYSTEM_PROMPT);
  });

  it("ignores an empty override file (falls back to built-in)", () => {
    const tmp = path.join(os.tmpdir(), `kbprompt-empty-${process.pid}.txt`);
    fs.writeFileSync(tmp, "   \n  ");
    process.env[ENV] = tmp;
    try {
      expect(resolveKbExtractionSystemPrompt()).toBe(KB_EXTRACTION_SYSTEM_PROMPT);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
