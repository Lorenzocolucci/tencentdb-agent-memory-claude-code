/**
 * Plugin tests that call handleHook without a `dataDir` resolve the data dir to
 * `<home>/.tdai-memory`. Now that hooks persist state there (prompt-cache,
 * recall-misses), such tests would read and write the developer's REAL data dir
 * and depend on each other across runs. Point the home dir at a throwaway temp
 * dir for plugin test files only; `src/` tests (which read real fixtures from
 * the home dir) are untouched.
 */
import { expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (/[\\/]claude-code-plugin[\\/]tests[\\/]/.test(expect.getState().testPath ?? "")) {
  const home = mkdtempSync(join(tmpdir(), "tdai-test-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}
