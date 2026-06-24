/**
 * Track A slice 2 — inject the project's binding principles (the WHY), not just
 * facts. The "forgot the vision" failure happened because the north-star was a
 * passive pointer, not a binding directive surfaced with force. loadPrinciples
 * reads a curated principles.md from the data dir; formatPrinciplesBlock wraps
 * it as a <governing-principles> block with binding framing (NOT the
 * "for reference only" framing that recalled facts get).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPrinciples, formatPrinciplesBlock, sanitizeProjectKey } from "../principles.js";

describe("loadPrinciples", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-principles-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns the curated content when principles.md exists", async () => {
    fs.writeFileSync(path.join(dir, "principles.md"), "Sinapsys = associative memory, never the ordinary version.\n");
    expect(await loadPrinciples(dir)).toBe("Sinapsys = associative memory, never the ordinary version.");
  });

  it("returns undefined when the file is missing", async () => {
    expect(await loadPrinciples(dir)).toBeUndefined();
  });

  it("returns undefined when the file is empty or whitespace", async () => {
    fs.writeFileSync(path.join(dir, "principles.md"), "   \n\t\n");
    expect(await loadPrinciples(dir)).toBeUndefined();
  });
});

describe("loadPrinciples — per-project", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-principles-proj-"));
    fs.mkdirSync(path.join(dir, "principles"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("combines global + per-project (global first, project after)", async () => {
    fs.writeFileSync(path.join(dir, "principles.md"), "GLOBAL: determinismo assoluto.");
    fs.writeFileSync(path.join(dir, "principles", "sofia-ai.md"), "PROJECT: Sofia north-star.");
    const out = await loadPrinciples(dir, "sofia-ai");
    expect(out).toBe("GLOBAL: determinismo assoluto.\n\nPROJECT: Sofia north-star.");
  });

  it("falls back to global-only when no project file exists", async () => {
    fs.writeFileSync(path.join(dir, "principles.md"), "GLOBAL only.");
    expect(await loadPrinciples(dir, "unknown-project")).toBe("GLOBAL only.");
  });

  it("returns project-only when there is no global file", async () => {
    fs.writeFileSync(path.join(dir, "principles", "tutorai.md"), "PROJECT only.");
    expect(await loadPrinciples(dir, "tutorai")).toBe("PROJECT only.");
  });

  it("behaves exactly as before when projectName is omitted (backward compat)", async () => {
    fs.writeFileSync(path.join(dir, "principles.md"), "GLOBAL.");
    fs.writeFileSync(path.join(dir, "principles", "x.md"), "should be ignored");
    expect(await loadPrinciples(dir)).toBe("GLOBAL.");
  });

  it("resists path traversal in the project name (stays inside principles/)", async () => {
    // A traversal attempt must not read the global file or anything outside.
    fs.writeFileSync(path.join(dir, "principles.md"), "GLOBAL secret.");
    const out = await loadPrinciples(dir, "../../principles");
    // Sanitized key cannot escape; no project file matches → global-only.
    expect(out).toBe("GLOBAL secret.");
  });

  it("ignores an empty/whitespace project file (global wins)", async () => {
    fs.writeFileSync(path.join(dir, "principles.md"), "GLOBAL.");
    fs.writeFileSync(path.join(dir, "principles", "blank.md"), "   \n");
    expect(await loadPrinciples(dir, "blank")).toBe("GLOBAL.");
  });
});

describe("sanitizeProjectKey", () => {
  it("lowercases and keeps safe filename chars", () => {
    expect(sanitizeProjectKey("Sofia-AI")).toBe("sofia-ai");
    expect(sanitizeProjectKey("tencentdb_agent.memory")).toBe("tencentdb_agent.memory");
  });
  it("strips path separators and traversal", () => {
    expect(sanitizeProjectKey("../../etc")).toBe("etc");
    expect(sanitizeProjectKey("a/b\\c")).toBe("abc");
  });
  it("returns '' for an all-unsafe or empty name", () => {
    expect(sanitizeProjectKey("")).toBe("");
    expect(sanitizeProjectKey("///")).toBe("");
  });
});

describe("formatPrinciplesBlock", () => {
  it("wraps content in a binding <governing-principles> block", () => {
    const block = formatPrinciplesBlock("Build the revolutionary version.");
    expect(block.startsWith("<governing-principles>")).toBe(true);
    expect(block.trimEnd().endsWith("</governing-principles>")).toBe(true);
    expect(block).toContain("Build the revolutionary version.");
    // Binding framing — must NOT be demoted like recalled facts.
    expect(block.toUpperCase()).toContain("BINDING");
  });
});
