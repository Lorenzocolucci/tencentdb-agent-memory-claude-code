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
import { loadPrinciples, formatPrinciplesBlock } from "../principles.js";

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
