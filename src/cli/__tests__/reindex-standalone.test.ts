/**
 * Tests for the standalone `node` reindex entry (no openclaw host required).
 *
 * We drive the BUILT entry (dist/src/cli/reindex-standalone.mjs) as a child
 * process — the same way Lorenzo runs it — and assert the loud failure paths.
 * This proves the entry boots, parses argv, resolves config via
 * loadGatewayConfig(), and reuses runReindexCommand without crashing.
 *
 * It deliberately NEVER points at a real store: the only dirs used are an
 * ephemeral temp dir with NO vectors.db, so this can never touch the live
 * gateway's vectors.db.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ENTRY = path.join(REPO_ROOT, "dist", "src", "cli", "reindex-standalone.mjs");

function run(args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: "utf-8",
    env,
  });
}

describe("reindex-standalone entry (built .mjs)", () => {
  let tmpDir: string | undefined;

  beforeAll(() => {
    if (!fs.existsSync(ENTRY)) {
      throw new Error(
        `Built entry not found at ${ENTRY}. Run \`npm run build:plugin\` before this test.`,
      );
    }
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("exits non-zero with a usage message when --data-dir and TDAI_DATA_DIR are both absent", () => {
    const env = { ...process.env };
    delete env.TDAI_DATA_DIR;

    const res = run([], env);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("--data-dir is required");
    expect(res.stderr).toContain("Usage:");
  });

  it("exits non-zero with the loud 'No vectors.db found' refusal for a dir without a store", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-reindex-standalone-"));
    // tmpDir exists but intentionally has NO vectors.db.

    const res = run(["--data-dir", tmpDir], { ...process.env });

    expect(res.status).not.toBe(0);
    // Combined stdout+stderr: the core command prints the refusal to stderr,
    // its progress logs to stderr via our logger.
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toContain("No vectors.db found");
  });
});
