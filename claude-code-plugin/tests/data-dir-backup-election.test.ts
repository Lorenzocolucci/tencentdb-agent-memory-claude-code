import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDataDirDetailed } from "../lib/data-dir.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tdai-elect-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function layout(): { scriptPath: string; dataRoot: string } {
  const scriptDir = join(tmp, "plugins", "cache", "mkt", "tdai-memory", "1.0", "dist", "lib");
  mkdirSync(scriptDir, { recursive: true });
  const dataRoot = join(tmp, "plugins", "data");
  mkdirSync(dataRoot, { recursive: true });
  return { scriptPath: join(scriptDir, "hook.mjs"), dataRoot };
}

function dataDir(root: string, name: string, pid: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ pid, port: 8421 }));
  return dir;
}

describe("resolveDataDirDetailed: a backup can never beat a live dir", () => {
  it("dead live PID + alive backup PID -> live wins", () => {
    const { scriptPath, dataRoot } = layout();
    const live = dataDir(dataRoot, "tdai-memory-mkt", 111);
    dataDir(dataRoot, "tdai-memory-mkt.BACKUP-20260614-pre-reindex", 222);
    const res = resolveDataDirDetailed({
      scriptPath,
      env: {},
      home: tmp,
      isPidAlive: (pid) => pid === 222,
    });
    expect(res.dir).toBe(live);
    expect(res.chosenIsBackup).toBe(false);
  });

  it("only backups exist -> a backup is still chosen (and flagged)", () => {
    const { scriptPath, dataRoot } = layout();
    dataDir(dataRoot, "tdai-memory-mkt.BACKUP-20260614", 222);
    const res = resolveDataDirDetailed({ scriptPath, env: {}, home: tmp, isPidAlive: () => true });
    expect(res.chosenIsBackup).toBe(true);
  });
});
