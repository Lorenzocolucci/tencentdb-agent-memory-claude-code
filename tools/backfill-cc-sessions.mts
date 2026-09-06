/**
 * Backfill Claude Code sessions that the Stop hook never captured.
 *
 * WHY
 * ---
 * 3,190 Claude Code transcripts exist on disk (`~/.claude/projects/<project>/
 * <uuid>.jsonl`); only 59 have ever reached memory. 3,131 have not — 3,128 of
 * those are Argus `claude -p` children (hooks disabled by Argus itself, see
 * `argus-child.ts`), 2 are Sofia-AI, 1 is a scratch temp session. Full
 * measured survey: `C:/tmp-sinapsys/understand-backfill.md`.
 *
 * DESIGN
 * ------
 * The cleanest replay of a Stop hook capture is the Stop hook itself:
 *   `node <hook.mjs> stop` with stdin `{session_id, transcript_path, cwd}`.
 * It is idempotent per session via the SAME cursor file a live Claude Code
 * session uses (`hook-runner.ts`), so this backfill can be interrupted and
 * re-run freely: `--list`/`--run` always recompute classification from the
 * cursor files on disk, they never trust their own history to decide what is
 * left to do — only the state file's PROGRESS LOG (and the `--digest` key
 * list) benefits from being remembered across runs.
 *
 * USAGE
 *   npx tsx tools/backfill-cc-sessions.mts                        # --list, dry, default
 *   npx tsx tools/backfill-cc-sessions.mts --list --json plan.json
 *   npx tsx tools/backfill-cc-sessions.mts --run [--include-argus-children] [--pace-ms 500] [--hook <path>] [--capture-timeout-ms 300000]
 *   npx tsx tools/backfill-cc-sessions.mts --digest [--keys a,b,c] [--stall-minutes 240] [--force]
 *
 * All commands accept `--projects-root <dir>` and `--data-dir <dir>` to
 * override the defaults (live `~/.claude/projects` and the live plugin data
 * dir), which is what makes every piece below unit-testable without ever
 * touching the real ones.
 *
 * SAFETY
 * ------
 * `--list` only reads (transcripts + cursor files); it writes nowhere except
 * the file given to `--json`, if any. `--run` only ever writes: the plugin's
 * own cursor files (via the real hook — that IS its job), this tool's own
 * append-only log, and this tool's own state file. `--digest` only calls the
 * gateway's `/digest` route. Nothing here calls `/seed`, touches `vectors.db`
 * directly, or disables/bypasses the live gateway.
 */
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../src/cli/backfill-cc/cli-args.js";
import { buildPlan, replayCandidates } from "../src/cli/backfill-cc/build-plan.js";
import { formatPlanTable } from "../src/cli/backfill-cc/format-plan.js";
import { loadState, saveState, mergeState, distinctReplayedKeys } from "../src/cli/backfill-cc/state-file.js";
import type { SessionState, DigestState } from "../src/cli/backfill-cc/state-file.js";
import { replayTranscript } from "../src/cli/backfill-cc/replay-loop.js";
import { runHookStop } from "../src/cli/backfill-cc/hook-runner.js";
import { readCursorTurns } from "../src/cli/backfill-cc/cursor.js";
import { digestKey, planDigestKeys } from "../src/cli/backfill-cc/digest-driver.js";
import { postDigest, readToken } from "../src/cli/backfill-cc/gateway-http.js";
import { writeFile } from "node:fs/promises";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendLog(dataDir: string, line: string): Promise<void> {
  const path = join(dataDir, "backfill-cc.log");
  const stamped = `${new Date().toISOString()} ${line}\n`;
  try {
    await appendFile(path, stamped, "utf-8");
  } catch {
    // A log write failure must never abort the backfill itself.
  }
  process.stdout.write(stamped);
}

async function runList(opts: { projectsRoot: string; dataDir: string; jsonPath: string | null; includeArgusChildren: boolean }): Promise<void> {
  const plan = await buildPlan({ projectsRoot: opts.projectsRoot, dataDir: opts.dataDir });
  console.log(formatPlanTable(plan, opts.includeArgusChildren));
  if (opts.jsonPath) {
    await writeFile(opts.jsonPath, JSON.stringify(plan, null, 2), "utf-8");
    console.log(`\nPlan written to ${opts.jsonPath}`);
  }
}

async function runReplay(opts: {
  projectsRoot: string;
  dataDir: string;
  includeArgusChildren: boolean;
  hookPath: string;
  paceMs: number;
  captureTimeoutMs: number;
}): Promise<void> {
  const plan = await buildPlan({ projectsRoot: opts.projectsRoot, dataDir: opts.dataDir });
  const candidates = replayCandidates(plan, opts.includeArgusChildren);
  const statePath = join(opts.dataDir, "backfill-cc-state.json");
  let state = await loadState(statePath);

  await appendLog(opts.dataDir, `run: ${candidates.length} transcript(s) to replay (hook=${opts.hookPath}, capture timeout ${opts.captureTimeoutMs}ms)`);

  const counts = { replayed: 0, partial: 0, failed: 0 };
  for (const candidate of candidates) {
    const sessionId = candidate.sessionId as string;
    const cwd = candidate.cwd as string;
    const result = await replayTranscript({
      turns: candidate.turns,
      cursorBefore: candidate.cursorTurns,
      invokeHook: () =>
        runHookStop({
          hookPath: opts.hookPath,
          sessionId,
          transcriptPath: candidate.transcriptPath,
          cwd,
          captureTimeoutMs: opts.captureTimeoutMs,
        }),
      getCursorTurns: () => readCursorTurns(opts.dataDir, sessionId),
      pace: () => sleep(opts.paceMs),
    });

    counts[result.status] += 1;
    const sessionState: SessionState = {
      status: result.status,
      sessionKey: candidate.sessionKey,
      turnsTotal: candidate.turns,
      turnsSentBefore: result.turnsSentBefore,
      turnsSentAfter: result.turnsSentAfter,
      lastError: result.lastError,
      updatedAt: new Date().toISOString(),
    };
    state = mergeState(state, { sessions: { [sessionId]: sessionState } });
    await saveState(statePath, state);

    await appendLog(
      opts.dataDir,
      `[${sessionId}] ${result.status} turns ${result.turnsSentBefore}->${result.turnsSentAfter}/${candidate.turns}` +
        (result.lastError ? ` error=${result.lastError}` : ""),
    );

    await sleep(opts.paceMs);
  }

  const touchedKeys = distinctReplayedKeys(state);
  await appendLog(
    opts.dataDir,
    `run done: replayed=${counts.replayed} partial=${counts.partial} failed=${counts.failed} distinct session_keys touched=${touchedKeys.length}`,
  );
}

async function runDigest(opts: {
  dataDir: string;
  keys: string[] | null;
  gatewayUrl: string;
  tokenFile: string;
  stallMinutes: number;
  force: boolean;
}): Promise<void> {
  const statePath = join(opts.dataDir, "backfill-cc-state.json");
  let state = await loadState(statePath);
  const allKeys = opts.keys ?? distinctReplayedKeys(state);
  const keysToRun = planDigestKeys(allKeys, state.digest, opts.force);

  await appendLog(opts.dataDir, `digest: ${keysToRun.length}/${allKeys.length} key(s) to run (force=${opts.force})`);

  const token = await readToken(opts.tokenFile);
  const stallMs = opts.stallMinutes * 60_000;
  const t0 = Date.now();

  for (const key of keysToRun) {
    const keyStart = Date.now();
    const result = await digestKey(key, {
      stallMs,
      postDigestForKey: (k, signal) => postDigest({ baseUrl: opts.gatewayUrl, token, sessionKey: k, signal }),
      onProgress: (line) => {
        void appendLog(opts.dataDir, `[digest ${key}] ${line}`);
      },
    });

    const digestState: DigestState = {
      status: result.status,
      processedCount: result.processedCount,
      lastError: result.error,
      updatedAt: new Date().toISOString(),
    };
    state = mergeState(state, { digest: { [key]: digestState } });
    await saveState(statePath, state);

    const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
    const keySecs = ((Date.now() - keyStart) / 1000).toFixed(0);
    await appendLog(
      opts.dataDir,
      `[digest ${key}] ${result.status} processed=${result.processedCount} ${keySecs}s elapsed=${elapsedMin}m` +
        (result.error ? ` error=${result.error}` : ""),
    );
  }

  await appendLog(opts.dataDir, `digest done: ${keysToRun.length} key(s) attempted`);
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2), { home: homedir() });
  if (opts.command === "list") {
    await runList(opts);
    return;
  }
  if (opts.command === "run") {
    await runReplay(opts);
    return;
  }
  await runDigest(opts);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`);
  process.exit(1);
});
