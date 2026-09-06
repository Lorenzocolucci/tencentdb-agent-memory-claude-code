/**
 * Pure argv parser for `tools/backfill-cc-sessions.mts`. No IO, no defaults
 * baked from environment probing beyond `os.homedir()` — fully testable by
 * passing an explicit `argv` and `home`.
 */
import { join } from "node:path";

export type Command = "list" | "run" | "digest";

export interface CommonOptions {
  projectsRoot: string;
  dataDir: string;
}

export interface ListOptions extends CommonOptions {
  command: "list";
  jsonPath: string | null;
  includeArgusChildren: boolean;
}

export interface RunOptions extends CommonOptions {
  command: "run";
  includeArgusChildren: boolean;
  hookPath: string;
  paceMs: number;
  /** Forwarded to each hook child as TDAI_CAPTURE_TIMEOUT_MS (see hook-runner.ts). */
  captureTimeoutMs: number;
}

export interface DigestOptions extends CommonOptions {
  command: "digest";
  /** null = derive distinct session_keys touched by --run from the state file. */
  keys: string[] | null;
  gatewayUrl: string;
  tokenFile: string;
  stallMinutes: number;
  force: boolean;
}

export type CliOptions = ListOptions | RunOptions | DigestOptions;

function findValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

export interface ParseCliArgsEnv {
  home: string;
}

export function parseCliArgs(argv: string[], env: ParseCliArgsEnv): CliOptions {
  const defaultDataDir = join(env.home, ".claude", "plugins", "data", "tdai-memory-tdai-local");
  const dataDir = findValue(argv, "--data-dir") ?? defaultDataDir;
  const projectsRoot = findValue(argv, "--projects-root") ?? join(env.home, ".claude", "projects");
  const includeArgusChildren = argv.includes("--include-argus-children");

  if (argv.includes("--run")) {
    const defaultHookPath = join(
      env.home,
      ".claude",
      "plugins",
      "cache",
      "tdai-local",
      "tdai-memory",
      "0.1.0",
      "dist",
      "lib",
      "hook.mjs",
    );
    return {
      command: "run",
      projectsRoot,
      dataDir,
      includeArgusChildren,
      hookPath: findValue(argv, "--hook") ?? defaultHookPath,
      paceMs: Number(findValue(argv, "--pace-ms") ?? "500"),
      // 5 minutes: a never-captured 18 MB transcript needs well over the live
      // 12s for its 50-turn batch (measured 2026-09-05). Offline, waiting is
      // cheaper than re-sending.
      captureTimeoutMs: Number(findValue(argv, "--capture-timeout-ms") ?? "300000"),
    };
  }

  if (argv.includes("--digest")) {
    const keysRaw = findValue(argv, "--keys");
    return {
      command: "digest",
      projectsRoot,
      dataDir,
      keys: keysRaw ? keysRaw.split(",").map((k) => k.trim()).filter(Boolean) : null,
      gatewayUrl: findValue(argv, "--gateway-url") ?? "http://127.0.0.1:8421",
      // Defaults from the resolved data dir, so overriding --data-dir alone
      // still points at that data dir's own token file (the live default
      // resolves to the exact live token path the task specifies).
      tokenFile: findValue(argv, "--token-file") ?? join(dataDir, "token"),
      // 240 min: a big session key drains gateway-side in ~50-message passes,
      // each an LLM call of 40-90 s (measured 2026-09-05/06). At 30 min the
      // watchdog aborted the HTTP call and marked the key "failed" while the
      // gateway kept draining — the tool lied, the work continued.
      stallMinutes: Number(findValue(argv, "--stall-minutes") ?? "240"),
      force: argv.includes("--force"),
    };
  }

  // Default command: --list (dry, read-only).
  return {
    command: "list",
    projectsRoot,
    dataDir,
    jsonPath: findValue(argv, "--json") ?? null,
    includeArgusChildren,
  };
}
