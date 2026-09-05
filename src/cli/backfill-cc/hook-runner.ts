/**
 * Real IO: spawn `node <hookPath> stop` with the Stop hook's stdin contract
 * (`hook.ts` `HookStdin`: `session_id`, `transcript_path`, `cwd` — no
 * timestamps, matching Trap 1 in `understand-backfill.md` §4.3: the hook
 * itself never puts per-message timestamps on a `/capture` call, so replaying
 * it exactly, rather than hand-building a `/capture` payload, sidesteps that
 * trap by construction).
 *
 * This is the ONLY module in this tool that touches a child process. It
 * reports success/failure of the SPAWN (exit code 0, no spawn error) —
 * whether the hook actually advanced the cursor is verified separately by
 * re-reading the cursor file (`replay-loop.ts`), because a 0 exit code from
 * `handleStop` does not by itself prove a capture succeeded (capture
 * failures are recorded as alarms, not a non-zero exit — hook.ts:356-379).
 */
import { spawn } from "node:child_process";
import type { HookInvocationResult } from "./replay-loop.js";

export interface RunHookStopParams {
  hookPath: string;
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  /**
   * Kill budget for the child. Default: 30s (the Stop hook's budget in
   * hooks.json) or, when `captureTimeoutMs` is set, two capture attempts plus
   * 10s of slack — the hook retries `/capture` once before giving up.
   */
  timeoutMs?: number;
  /**
   * Passed to the child as `TDAI_CAPTURE_TIMEOUT_MS` so its gateway client
   * waits that long for `/capture` instead of the live 12s default. A replay
   * is offline work: waiting beats abandoning a request the gateway keeps
   * processing anyway (2026-09-05: 20 abandoned 50-turn captures queued).
   */
  captureTimeoutMs?: number;
  /** Injectable for tests; defaults to the running node binary. */
  nodeBin?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CAPTURE_ATTEMPTS = 2;
const KILL_SLACK_MS = 10_000;

export function childTimeoutMs(params: Pick<RunHookStopParams, "timeoutMs" | "captureTimeoutMs">): number {
  if (params.timeoutMs !== undefined) return params.timeoutMs;
  if (params.captureTimeoutMs !== undefined) return params.captureTimeoutMs * CAPTURE_ATTEMPTS + KILL_SLACK_MS;
  return DEFAULT_TIMEOUT_MS;
}

export function runHookStop(params: RunHookStopParams): Promise<HookInvocationResult> {
  const timeoutMs = childTimeoutMs(params);
  const nodeBin = params.nodeBin ?? process.execPath;
  const env =
    params.captureTimeoutMs !== undefined
      ? { ...process.env, TDAI_CAPTURE_TIMEOUT_MS: String(params.captureTimeoutMs) }
      : process.env;

  return new Promise((resolve) => {
    const child = spawn(nodeBin, [params.hookPath, "stop"], { stdio: ["pipe", "pipe", "pipe"], env });
    let stderr = "";
    let stdout = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, error: `hook timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `exit ${code}: ${(stderr || stdout).slice(0, 500)}` });
        return;
      }
      resolve({ ok: true });
    });

    const payload = JSON.stringify({
      session_id: params.sessionId,
      transcript_path: params.transcriptPath,
      cwd: params.cwd,
    });
    child.stdin?.write(payload);
    child.stdin?.end();
  });
}
