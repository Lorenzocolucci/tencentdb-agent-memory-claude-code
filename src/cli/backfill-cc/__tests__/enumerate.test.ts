import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateTranscripts } from "../enumerate.js";

describe("enumerateTranscripts", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "backfill-cc-enum-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds .jsonl files exactly two levels deep and ignores everything else", async () => {
    await mkdir(join(root, "ProjectA"), { recursive: true });
    await writeFile(join(root, "ProjectA", "session1.jsonl"), "{}\n", "utf-8");
    await writeFile(join(root, "ProjectA", "notes.txt"), "ignore me", "utf-8");

    // Depth-3 (sub-agent transcript) must NOT be picked up.
    await mkdir(join(root, "ProjectA", "session1"), { recursive: true });
    await writeFile(join(root, "ProjectA", "session1", "nested.jsonl"), "{}\n", "utf-8");

    // A stray file directly under the projects root (depth 1) must be ignored too.
    await writeFile(join(root, "stray.jsonl"), "{}\n", "utf-8");

    const rows = enumerateTranscripts(root);
    expect(rows).toHaveLength(1);
    expect(rows[0].projectDirName).toBe("ProjectA");
    expect(rows[0].transcriptPath).toBe(join(root, "ProjectA", "session1.jsonl"));
    expect(rows[0].bytes).toBeGreaterThan(0);
  });

  it("returns an empty list (not a throw) when the root does not exist", () => {
    expect(enumerateTranscripts(join(root, "does-not-exist"))).toEqual([]);
  });

  it("skips a project 'directory' entry that is actually a file", async () => {
    await writeFile(join(root, "not-a-dir"), "hi", "utf-8");
    expect(enumerateTranscripts(root)).toEqual([]);
  });
});
