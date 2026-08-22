/**
 * Resolve the gateway data directory — layout-independent.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The previous implementation lived inline in hook.ts and computed the plugins
 * root with a FIXED number of `..` hops from the script's own path:
 *
 *     dist/lib/hook.mjs  →  join(dirname, "..","..","..","..", "data")
 *
 * That assumed the install layout `<plugins>/<marketplace>/<plugin>/dist/lib/`.
 * Claude Code now installs plugins as
 *
 *     <plugins>/cache/<marketplace>/<plugin>/<version>/dist/lib/hook.mjs
 *
 * i.e. SIX hops, not four. With four hops the lookup resolved to
 * `<plugins>/cache/<marketplace>/data`, which does not exist, so discovery
 * returned nothing and every hook fell back to `~/.tdai-memory` — a directory
 * with no `state.json`. The hook then logged "no daemon, skipped" into a log
 * file nobody reads and exited 0. Capture stopped completely, in silence.
 *
 * The fix is to stop counting hops: walk UP from the script until we find an
 * ancestor that actually contains a `data` directory holding at least one of
 * OUR data dirs. That survives any future re-layout by Claude Code.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { homedir } from "node:os";

export const PLUGIN_NAME = "tdai-memory";

/** How the data dir was found. `fallback` means NOTHING usable was found. */
export type DataDirSource = "discovered" | "env" | "fallback";

export interface DataDirResolution {
  dir: string;
  source: DataDirSource;
  /** Candidates seen during discovery, newest state.json first. */
  candidates: DataDirCandidate[];
}

export interface DataDirCandidate {
  dir: string;
  pid: number;
  mtimeMs: number;
}

export interface ResolveOptions {
  /** Absolute path of the running script (hook.mjs). */
  scriptPath: string;
  /** Process env; injected so tests never touch the real environment. */
  env?: Record<string, string | undefined>;
  /** Home directory; injected for tests. */
  home?: string;
  /** Liveness probe; injected for tests. */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Find the plugins `data` root by walking up from the script path.
 *
 * An ancestor qualifies when `<ancestor>/data` exists AND contains at least
 * one entry whose name starts with the plugin name. Requiring one of OUR dirs
 * avoids latching onto some unrelated `data/` folder that happens to sit on
 * the path (e.g. a repo checkout with its own `data/`).
 */
export function findPluginsDataRoot(scriptPath: string): string | null {
  let cur = dirname(scriptPath);
  const { root } = parse(cur);
  // Bounded walk: a path can never have more ancestors than its segment count.
  for (let hops = 0; hops < 32; hops++) {
    const candidate = join(cur, "data");
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        const names = readdirSync(candidate);
        if (names.some((n) => n.startsWith(PLUGIN_NAME))) return candidate;
      }
    } catch {
      // Unreadable ancestor — keep walking.
    }
    if (cur === root) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * Enumerate our data dirs under a plugins `data` root, newest state.json first.
 *
 * Backup directories (`*.BACKUP-*`) are deliberately included: they still start
 * with the plugin name and could in principle hold a live gateway. Liveness of
 * the recorded PID is what actually decides, not the name.
 */
export function findOwnDataDirs(dataRoot: string): DataDirCandidate[] {
  let names: string[];
  try {
    names = readdirSync(dataRoot);
  } catch {
    return [];
  }
  const out: DataDirCandidate[] = [];
  for (const name of names) {
    if (!name.startsWith(PLUGIN_NAME)) continue;
    const dir = join(dataRoot, name);
    const statePath = join(dir, "state.json");
    try {
      const mtimeMs = statSync(statePath).mtimeMs;
      const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as { pid?: unknown };
      const pid = typeof parsed.pid === "number" ? parsed.pid : 0;
      out.push({ dir, pid, mtimeMs });
    } catch {
      // No readable state.json → not a usable candidate.
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** True if a process with this PID currently exists (POSIX + Windows). */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM => the process exists but we lack permission to signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Resolve the data dir, reporting HOW it was found.
 *
 * Order:
 *   1. on-disk discovery (authoritative — prefers a dir whose PID is alive);
 *   2. `CLAUDE_PLUGIN_DATA`, but only when it is one of OUR dirs (Claude Code
 *      injects a single plugin's value into the generic Bash environment, so
 *      for skill/slash-command invocations it routinely names another plugin);
 *   3. `~/.tdai-memory` — a last resort that means "we are lost". Callers MUST
 *      treat `source === "fallback"` as a failure worth shouting about.
 */
export function resolveDataDirDetailed(opts: ResolveOptions): DataDirResolution {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;

  const root = findPluginsDataRoot(opts.scriptPath);
  const candidates = root ? findOwnDataDirs(root) : [];
  if (candidates.length > 0) {
    const alive = candidates.filter((c) => isAlive(c.pid));
    const pool = alive.length > 0 ? alive : candidates;
    return { dir: pool[0].dir, source: "discovered", candidates };
  }

  const fromEnv = env.CLAUDE_PLUGIN_DATA;
  if (fromEnv && basename(fromEnv).startsWith(PLUGIN_NAME)) {
    return { dir: fromEnv, source: "env", candidates };
  }

  return { dir: join(home, ".tdai-memory"), source: "fallback", candidates };
}
