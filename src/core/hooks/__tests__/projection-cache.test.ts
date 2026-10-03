/**
 * Phase 2.7 — persona / principles projection cache: the processed text is reused
 * while the file is unchanged and refreshed the moment it changes. The returned
 * text must be exactly what the uncached path returns.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPersonaCached, loadPrinciplesCached, _resetProjectionCacheForTest } from "../projection-cache.js";
import { loadPrinciples } from "../principles.js";

describe("projection cache", () => {
  let dir: string;
  beforeEach(() => {
    _resetProjectionCacheForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-projcache-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("persona: strips once per file version, not once per call", async () => {
    const file = path.join(dir, "persona.md");
    fs.writeFileSync(file, "  hello persona  \n");
    let strips = 0;
    const strip = (raw: string) => { strips++; return raw; };
    expect(await readPersonaCached(file, strip)).toBe("hello persona");
    expect(await readPersonaCached(file, strip)).toBe("hello persona");
    expect(await readPersonaCached(file, strip)).toBe("hello persona");
    expect(strips).toBe(1);

    fs.writeFileSync(file, "a longer, changed persona body\n"); // different size → new signature
    expect(await readPersonaCached(file, strip)).toBe("a longer, changed persona body");
    expect(strips).toBe(2);
  });

  it("persona: missing or empty file → undefined, and a file created later is picked up", async () => {
    const file = path.join(dir, "persona.md");
    expect(await readPersonaCached(file, (r) => r)).toBeUndefined();
    fs.writeFileSync(file, "   \n");
    expect(await readPersonaCached(file, (r) => r)).toBeUndefined();
    fs.writeFileSync(file, "now there is content");
    expect(await readPersonaCached(file, (r) => r)).toBe("now there is content");
  });

  it("principles: identical to loadPrinciples, and refreshed when either file changes", async () => {
    fs.writeFileSync(path.join(dir, "principles.md"), "GLOBAL");
    fs.mkdirSync(path.join(dir, "principles"));
    fs.writeFileSync(path.join(dir, "principles", "sofia.md"), "PROJECT");
    expect(await loadPrinciplesCached(dir, "Sofia")).toBe(await loadPrinciples(dir, "Sofia"));
    expect(await loadPrinciplesCached(dir, "Sofia")).toBe("GLOBAL\n\nPROJECT");

    fs.writeFileSync(path.join(dir, "principles", "sofia.md"), "PROJECT v2 (longer)");
    expect(await loadPrinciplesCached(dir, "Sofia")).toBe("GLOBAL\n\nPROJECT v2 (longer)");
    expect(await loadPrinciplesCached(dir, "Other")).toBe("GLOBAL"); // different project key, own entry
    expect(await loadPrinciplesCached(path.join(dir, "nowhere"))).toBeUndefined();
  });
});
