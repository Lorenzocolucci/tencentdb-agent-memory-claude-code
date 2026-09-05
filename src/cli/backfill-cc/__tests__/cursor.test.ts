import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursorTurns, sanitizeCursorId } from "../cursor.js";

describe("sanitizeCursorId", () => {
  it("leaves a plain UUID untouched", () => {
    expect(sanitizeCursorId("11111111-1111-1111-1111-111111111111")).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("replaces unsafe characters and caps length, matching hook.ts", () => {
    expect(sanitizeCursorId("a/b\\c:d")).toBe("a_b_c_d");
    expect(sanitizeCursorId("")).toBe("default");
  });
});

describe("readCursorTurns", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "backfill-cc-cursor-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns null when no cursor file exists (never-captured)", async () => {
    expect(await readCursorTurns(dataDir, "no-such-session")).toBeNull();
  });

  it("returns lastSentIndex when a cursor file exists", async () => {
    const cursorsDir = join(dataDir, "cursors");
    await mkdir(cursorsDir, { recursive: true });
    await writeFile(
      join(cursorsDir, "sess-1.json"),
      JSON.stringify({ lastSentIndex: 3, updatedAt: new Date().toISOString() }),
      "utf-8",
    );
    expect(await readCursorTurns(dataDir, "sess-1")).toBe(3);
  });

  it("returns null for a malformed cursor file rather than throwing", async () => {
    const cursorsDir = join(dataDir, "cursors");
    await mkdir(cursorsDir, { recursive: true });
    await writeFile(join(cursorsDir, "sess-2.json"), "not json", "utf-8");
    expect(await readCursorTurns(dataDir, "sess-2")).toBeNull();
  });
});
