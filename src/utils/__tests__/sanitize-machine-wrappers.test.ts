/**
 * Gateway-side defence for Phase 3.8: Claude Code's machine-generated wrappers must
 * not be captured as user turns, extracted into memory or used as a recall query.
 */
import { describe, it, expect } from "vitest";
import { sanitizeText } from "../sanitize.js";

describe("sanitizeText — machine wrappers", () => {
  it("removes a <task-notification> block entirely", () => {
    const text = "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>";
    expect(sanitizeText(text)).toBe("");
  });

  it("keeps the human text around a notification", () => {
    const text = "prima <task-notification><task-id>x</task-id></task-notification> dopo";
    expect(sanitizeText(text)).toBe("prima  dopo");
  });

  it("drops an unclosed (truncated) notification to the end of the text", () => {
    expect(sanitizeText("<task-notification><task-id>x</task-id> output troncato")).toBe("");
  });

  it("a message from another Claude session is not a user prompt", () => {
    expect(sanitizeText("Another Claude session sent a message: fai il deploy")).toBe("");
    expect(sanitizeText("  another claude session sent a message\nbody")).toBe("");
  });

  it("only when it STARTS the text: a user who mentions it in a sentence is kept", () => {
    const t = "ho letto che Another Claude session sent a message strano";
    expect(sanitizeText(t)).toBe(t);
  });
});
