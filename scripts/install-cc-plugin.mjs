/**
 * Build the Claude Code plugin AND install it where Claude Code actually loads
 * it from — in one step.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-07 the plugin was fixed in the repo (banner + friction capture)
 * and built into claude-code-plugin/dist. Copying it into the installed plugin
 * was a separate manual step, and it never happened. For two weeks the machine
 * ran a bundle from 2026-06-29 while the repo said the fix had shipped.
 *
 * A step that can be forgotten WILL be forgotten. So there is no longer a
 * manual step: `npm run install:cc-plugin` builds and installs.
 *
 * The install target is DISCOVERED, never hardcoded, because Claude Code
 * changes its plugin layout (that change is exactly what broke capture on
 * 2026-08-13). We look for any directory under <plugins> that contains
 * dist/lib/hook.mjs and belongs to this plugin — by path token OR by the
 * name in its .claude-plugin/plugin.json. The second test matters: the
 * marketplace SOURCE dir (`~/.claude/plugins/<marketplace>/plugin`) has no
 * "tdai-memory" in its path, so until 2026-09-05 it never received a bundle
 * and any `/plugin` reinstall would have regressed the cache to August 7.
 *
 * Usage:  node scripts/install-cc-plugin.mjs [--dry-run]
 *   --dry-run  list targets and files, write nothing (skips the build too).
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_NAME = "tdai-memory";
const MAX_WALK_DEPTH = 6;

/** Name declared in <dir>/.claude-plugin/plugin.json, or null. Never throws. */
export function readPluginManifestName(dir) {
  try {
    const raw = readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf-8");
    const name = JSON.parse(raw)?.name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/**
 * Pure target filter. A dir is an install target when it holds a built hook
 * bundle AND is ours — either its path carries the plugin dir name, or its
 * manifest declares our plugin name.
 */
export function isInstallTarget({ path, hasBundle, manifestName }) {
  if (!hasBundle) return false;
  return path.includes(PLUGIN_NAME) || manifestName === PLUGIN_NAME;
}

/** Every dir under <root> that looks like an installed copy of this plugin. */
export function findInstallTargets(root = join(homedir(), ".claude", "plugins")) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        if (!statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      // Skip the data dirs — they hold the database, not code.
      if (e === "data") continue;
      if (e === "node_modules") continue;
      const hasBundle = existsSync(join(p, "dist", "lib", "hook.mjs"));
      if (isInstallTarget({ path: p, hasBundle, manifestName: readPluginManifestName(p) })) {
        found.push(p);
        continue;
      }
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** Relative paths (posix separators) of every regular file under <dir>. */
export function listFilesRecursive(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * [from, to] pairs to install, relative to <pluginSrc> and to the target.
 * The bundle, the hook registration and EVERY file under skills/ — a new
 * skill dir that is not copied is a skill that does not exist for the user.
 */
export function collectInstallFiles(pluginSrc) {
  const files = [
    ["dist/lib/hook.mjs", "dist/lib/hook.mjs"],
    ["hooks/hooks.json", "hooks/hooks.json"],
  ];
  for (const rel of listFilesRecursive(join(pluginSrc, "skills"))) {
    files.push([`skills/${rel}`, `skills/${rel}`]);
  }
  return files;
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const pluginSrc = join(REPO, "claude-code-plugin");

  if (dryRun) {
    process.stdout.write("DRY RUN — nessuna scrittura, build saltata.\n");
  } else {
    process.stdout.write("Costruisco il plugin…\n");
    execFileSync("npm", ["run", "build:cc-plugin"], {
      cwd: REPO,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  }

  const targets = findInstallTargets();
  if (targets.length === 0) {
    process.stderr.write(
      "Nessun plugin installato trovato sotto ~/.claude/plugins — niente da aggiornare.\n",
    );
    process.exit(1);
  }

  const files = collectInstallFiles(pluginSrc);
  for (const [from] of files) {
    if (!existsSync(join(pluginSrc, from))) throw new Error(`manca ${join(pluginSrc, from)}`);
  }

  for (const target of targets) {
    process.stdout.write(`${dryRun ? "Destinazione" : "Installo in"}: ${target}\n`);
    for (const [from, to] of files) {
      const src = join(pluginSrc, from);
      const dst = join(target, to);
      if (dryRun) {
        process.stdout.write(`  ${to}\n`);
        continue;
      }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      process.stdout.write(`  copiato ${to}\n`);
    }
  }
  process.stdout.write(
    dryRun
      ? `\n${targets.length} destinazioni, ${files.length} file per destinazione. Nulla scritto.\n`
      : "\nFatto. Riapri Claude Code perché gli agganci vengano ricaricati.\n",
  );
}

// Only run when executed directly, so tests can import the pure helpers.
const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main(process.argv.slice(2));
}
