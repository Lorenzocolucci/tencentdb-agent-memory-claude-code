/**
 * Regression tests for the bug that silently killed capture for 10 days:
 * the plugin resolved its data dir by counting `..` hops, and Claude Code
 * changed the install layout from
 *     <plugins>/<marketplace>/<plugin>/dist/lib/
 * to
 *     <plugins>/cache/<marketplace>/<plugin>/<version>/dist/lib/
 * The 4-hop arithmetic then pointed at a directory that does not exist, and
 * every hook fell back to ~/.tdai-memory and logged "no daemon, skipped".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findPluginsDataRoot,
  findOwnDataDirs,
  resolveDataDirDetailed,
} from "../lib/data-dir.js";

let tmp: string;

function makeLayout(hopsSegments: string[]): { scriptPath: string; dataRoot: string } {
  // <tmp>/plugins/<...hopsSegments>/dist/lib/hook.mjs  +  <tmp>/plugins/data
  const plugins = join(tmp, "plugins");
  const scriptDir = join(plugins, ...hopsSegments, "dist", "lib");
  mkdirSync(scriptDir, { recursive: true });
  const scriptPath = join(scriptDir, "hook.mjs");
  writeFileSync(scriptPath, "// stub");
  const dataRoot = join(plugins, "data");
  mkdirSync(dataRoot, { recursive: true });
  return { scriptPath, dataRoot };
}

function makeDataDir(dataRoot: string, name: string, pid: number): string {
  const dir = join(dataRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ pid, port: 8421 }));
  return dir;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tdai-datadir-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("findPluginsDataRoot", () => {
  it("finds the data root in the OLD 4-hop layout", () => {
    const { scriptPath, dataRoot } = makeLayout(["tdai-local", "tdai-memory"]);
    makeDataDir(dataRoot, "tdai-memory-tdai-local", 1);
    expect(findPluginsDataRoot(scriptPath)).toBe(dataRoot);
  });

  it("finds the data root in the CURRENT 6-hop cache/<version> layout", () => {
    // This is the exact shape that broke capture on 2026-08-13.
    const { scriptPath, dataRoot } = makeLayout([
      "cache",
      "tdai-local",
      "tdai-memory",
      "0.1.0",
    ]);
    makeDataDir(dataRoot, "tdai-memory-tdai-local", 1);
    expect(findPluginsDataRoot(scriptPath)).toBe(dataRoot);
  });

  it("ignores a `data` dir that holds no dir of ours", () => {
    const { scriptPath, dataRoot } = makeLayout(["cache", "mkt", "plug", "1.0.0"]);
    mkdirSync(join(dataRoot, "some-other-plugin"), { recursive: true });
    expect(findPluginsDataRoot(scriptPath)).toBeNull();
  });

  it("returns null when there is no data dir anywhere above the script", () => {
    const scriptDir = join(tmp, "lonely", "dist", "lib");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "hook.mjs");
    writeFileSync(scriptPath, "// stub");
    expect(findPluginsDataRoot(scriptPath)).toBeNull();
  });
});

describe("findOwnDataDirs", () => {
  it("skips dirs without a readable state.json and sorts newest first", () => {
    const { dataRoot } = makeLayout(["cache", "m", "p", "1.0.0"]);
    makeDataDir(dataRoot, "tdai-memory-old", 11);
    mkdirSync(join(dataRoot, "tdai-memory-no-state"), { recursive: true });
    mkdirSync(join(dataRoot, "unrelated-plugin"), { recursive: true });
    // Written last => newest mtime.
    const newer = makeDataDir(dataRoot, "tdai-memory-new", 22);

    const found = findOwnDataDirs(dataRoot);
    expect(found.map((c) => c.dir)).toContain(newer);
    expect(found.some((c) => c.dir.endsWith("tdai-memory-no-state"))).toBe(false);
    expect(found.some((c) => c.dir.endsWith("unrelated-plugin"))).toBe(false);
  });
});

describe("resolveDataDirDetailed", () => {
  it("prefers the candidate whose recorded PID is alive", () => {
    const { scriptPath, dataRoot } = makeLayout(["cache", "m", "p", "1.0.0"]);
    const dead = makeDataDir(dataRoot, "tdai-memory-dead", 111);
    const live = makeDataDir(dataRoot, "tdai-memory-live", 222);

    const res = resolveDataDirDetailed({
      scriptPath,
      env: {},
      home: tmp,
      isPidAlive: (pid) => pid === 222,
    });
    expect(res.dir).toBe(live);
    expect(res.source).toBe("discovered");
    expect(res.dir).not.toBe(dead);
  });

  it("uses CLAUDE_PLUGIN_DATA only when it names one of our dirs", () => {
    const scriptDir = join(tmp, "lonely", "dist", "lib");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "hook.mjs");
    writeFileSync(scriptPath, "// stub");

    const ours = resolveDataDirDetailed({
      scriptPath,
      env: { CLAUDE_PLUGIN_DATA: join(tmp, "tdai-memory-somewhere") },
      home: tmp,
    });
    expect(ours.source).toBe("env");

    const foreign = resolveDataDirDetailed({
      scriptPath,
      env: { CLAUDE_PLUGIN_DATA: join(tmp, "some-other-plugin") },
      home: tmp,
    });
    expect(foreign.source).toBe("fallback");
  });

  it("reports source=fallback when nothing is discoverable — the alarm case", () => {
    const scriptDir = join(tmp, "lonely", "dist", "lib");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "hook.mjs");
    writeFileSync(scriptPath, "// stub");

    const res = resolveDataDirDetailed({ scriptPath, env: {}, home: tmp });
    expect(res.source).toBe("fallback");
    expect(res.dir).toBe(join(tmp, ".tdai-memory"));
  });
});
