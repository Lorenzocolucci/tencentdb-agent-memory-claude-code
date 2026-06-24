/**
 * Track A 3+4 — situation extraction from a PostToolUse event.
 *
 * The observe half: given the tool that just ran, what is the agent touching?
 * v1 cares about the FILE in play (the strongest situation signal) and whether
 * the tool errored. Pure + testable; the KB match and injection live elsewhere.
 */

import { describe, it, expect } from "vitest";
import { extractSituation } from "../situation.js";

describe("extractSituation", () => {
  it("pulls file_path from file-touching tools, normalized to posix slashes", () => {
    for (const tool of ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(extractSituation({ toolName: tool, toolInput: { file_path: "C:\\Sofia-AI\\src\\x.ts" } })).toEqual({
        filePath: "C:/Sofia-AI/src/x.ts",
        isError: false,
      });
    }
  });

  it("marks an error when the tool output is an error", () => {
    expect(
      extractSituation({ toolName: "Read", toolInput: { file_path: "a.ts" }, toolOutputIsError: true }),
    ).toEqual({ filePath: "a.ts", isError: true });
  });

  it("returns no file for non-file tools (Bash, WebFetch, …)", () => {
    expect(extractSituation({ toolName: "Bash", toolInput: { command: "ls" } })).toEqual({ isError: false });
    expect(extractSituation({ toolName: "WebFetch", toolInput: { url: "http://x" } })).toEqual({ isError: false });
  });

  it("is defensive against missing / malformed tool_input", () => {
    expect(extractSituation({ toolName: "Read", toolInput: undefined })).toEqual({ isError: false });
    expect(extractSituation({ toolName: "Read", toolInput: { file_path: 42 } })).toEqual({ isError: false });
    expect(extractSituation({ toolName: "", toolInput: {} })).toEqual({ isError: false });
  });
});
