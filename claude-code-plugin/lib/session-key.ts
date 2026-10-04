/**
 * Compute a stable session key for a given working directory.
 *
 * Default: SHA-256 of the normalized absolute path, first 16 hex chars (64 bits).
 * Override: TDAI_SESSION_KEY env var, if non-empty.
 *
 * Used by hook handlers to partition memory by project rather than by
 * Claude Code session, so multiple cc terminals on the same project share
 * recall results.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export function getSessionKey(cwd: string): string {
  const override = process.env.TDAI_SESSION_KEY;
  if (override && override.length > 0) {
    return override;
  }
  const normalized = resolve(cwd);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Project name for a working directory: the name of the git REPOSITORY it belongs
 * to, so a subfolder (`C:\Shop\backend`) and a linked worktree
 * (`C:\Shop\.claude\worktrees\agent-…`, `C:\Shop-b`) are all "Shop". Outside a
 * repository it is the folder name. A repository nested inside another one
 * (`C:\Shop\frontend` with its own `.git`) belongs to the OUTER one: the product
 * is the outermost repository. A submodule is its own project. The home
 * directory and its ancestors
 * never count, so a dotfiles repo in home cannot swallow every project.
 * Used for recall scope, event tags and per-project principles.
 * Returns "" for a root/empty path.
 */
export function getProjectName(cwd: string): string {
  const start = resolve(cwd);
  const root = outermostRepo(start, 0);
  return basename(root ?? start);
}

/** Outermost repository directory containing `start`, or undefined. Never throws. */
function outermostRepo(start: string, hops: number): string | undefined {
  const stop = new Set(ancestorsOf(resolve(homedir())));
  let found: string | undefined;
  for (let dir = start; !stop.has(dir); ) {
    const kind = gitKind(dir);
    // A submodule (`.git` file not pointing at a worktree) is usually a vendored
    // library: it is its own project and nothing above it counts.
    if (kind === "file") return found ?? dir;
    if (kind === "dir") found = dir;
    else if (kind !== undefined) {
      // Linked worktree → continue from its main repository (bounded).
      found = hops < 4 ? (outermostRepo(kind.main, hops + 1) ?? kind.main) : dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

function ancestorsOf(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    out.push(d);
    if (dirname(d) === d) return out;
  }
}

/** "dir" for a repository, {main} for a linked worktree, "file" for other `.git` files. */
function gitKind(dir: string): "dir" | "file" | { main: string } | undefined {
  const gitPath = resolve(dir, ".git");
  try {
    if (!statSync(gitPath).isFile()) return "dir";
  } catch {
    return undefined;
  }
  try {
    const m = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)$/m);
    const gitdir = (m?.[1] ?? "").trim().split("\\").join("/");
    const at = gitdir.lastIndexOf("/.git/worktrees/");
    if (at > 0) return { main: resolve(gitdir.slice(0, at)) };
  } catch {
    /* unreadable .git file: treat the folder as a repository */
  }
  return "file";
}
