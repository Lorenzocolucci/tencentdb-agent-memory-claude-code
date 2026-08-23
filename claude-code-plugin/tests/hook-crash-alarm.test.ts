/**
 * THE FAULT THIS TEST CATCHES: "un log non è un segnale", eighth variant.
 *
 * `main()` in lib/hook.ts wraps its whole body in one try/catch whose only
 * action was `safeLog(...)`. Every exception raised AFTER the data dir is
 * resolved — an unreadable/missing token file, a corrupted state.json, a
 * locked hook.log, any bug in a handler — therefore killed recall AND capture
 * while writing one line into `hook.log`, the file nobody reads.
 *
 * That is precisely the shape of the 2026-08-13 → 2026-08-22 outage: memory
 * completely off, ten days, zero signal to Lorenzo. The seven tripwires do not
 * cover it, because they all live INSIDE the try block that never completes.
 *
 * Reproduced live on the installed bundle (2026-08-23): with the token file
 * removed, `session-start`, `user-prompt-submit` and `stop` all exited 0,
 * wrote `ENOENT ... stat '…\token'` to hook.log, wrote NO alarms.json, and
 * `user-prompt-submit` printed nothing at all.
 *
 * The test drives the REAL CLI entry point (`main()` via tsx), not an
 * extracted helper — otherwise deleting the call site in the catch block
 * would leave the test green.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK_TS = resolve(fileURLToPath(new URL("../lib/hook.ts", import.meta.url)));
const TSX = resolve(
  fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
);

/** A port nothing listens on — the gateway must be unreachable here. */
const DEAD_PORT = 18499;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runHook(event: string, dataDir: string, stdin = ""): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [TSX, HOOK_TS, event], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.stdin.end(stdin);
    child.on("close", (code) => res({ stdout, stderr, code }));
  });
}

describe("a crash inside main() must NEVER be silent (the 8th failure mode)", () => {
  let root: string;
  let dataDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tdai-crash-"));
    // The dir name must start with the plugin name or CLAUDE_PLUGIN_DATA is ignored.
    dataDir = join(root, "tdai-memory-crashtest");
    await mkdir(dataDir, { recursive: true });
    // A state.json that PARSES (so the hook proceeds past the daemon check)
    // but whose tokenPath does not exist: readToken throws, exactly as it did
    // live when the token file went missing.
    await writeFile(
      join(dataDir, "state.json"),
      JSON.stringify({
        pid: 999_999,
        port: DEAD_PORT,
        // ccPid <= 0 means "externally managed": the hook must not try to
        // respawn a gateway, so the test never starts a real process.
        ccPid: -1,
        startedAt: "2026-08-23T00:00:00.000Z",
        tokenPath: join(dataDir, "token-that-does-not-exist"),
      }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("session-start: an unreadable token raises an alarm instead of one hook.log line", async () => {
    const r = await runHook("session-start", dataDir);
    expect(r.code).toBe(0); // fail-open: the conversation is never broken

    const alarms = JSON.parse(await readFile(join(dataDir, "alarms.json"), "utf-8")) as Array<{
      code: string;
      message: string;
    }>;
    expect(alarms.map((a) => a.code)).toContain("hook-crashed");
  }, 60_000);

  it("user-prompt-submit: the crash reaches the USER as a systemMessage", async () => {
    const r = await runHook(
      "user-prompt-submit",
      dataDir,
      JSON.stringify({ prompt: "ciao", session_id: "crash-test", cwd: root }),
    );
    expect(r.code).toBe(0);

    // The whole point: Lorenzo sees it. An empty stdout is the bug.
    expect(r.stdout.trim()).not.toBe("");
    const out = JSON.parse(r.stdout) as { systemMessage?: string };
    expect(out.systemMessage ?? "").toMatch(/SINAPSYS/);
  }, 60_000);

  it("stop: a capture that dies of an exception still leaves an alarm behind", async () => {
    const r = await runHook(
      "stop",
      dataDir,
      JSON.stringify({ session_id: "crash-test", transcript_path: join(root, "none.jsonl"), cwd: root }),
    );
    expect(r.code).toBe(0);

    const alarms = JSON.parse(await readFile(join(dataDir, "alarms.json"), "utf-8")) as Array<{
      code: string;
    }>;
    expect(alarms.map((a) => a.code)).toContain("hook-crashed");
  }, 60_000);
});
