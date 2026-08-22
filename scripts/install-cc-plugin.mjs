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
 * dist/lib/hook.mjs and belongs to this plugin.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR_NAME = "tdai-memory";

/** Every dir under <plugins> that looks like an installed copy of this plugin. */
function findInstallTargets() {
  const root = join(homedir(), ".claude", "plugins");
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
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
      if (existsSync(join(p, "dist", "lib", "hook.mjs")) && p.includes(PLUGIN_DIR_NAME)) {
        found.push(p);
        continue;
      }
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function main() {
  process.stdout.write("Costruisco il plugin…\n");
  execFileSync("npm", ["run", "build:cc-plugin"], {
    cwd: REPO,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const targets = findInstallTargets();
  if (targets.length === 0) {
    process.stderr.write(
      "Nessun plugin installato trovato sotto ~/.claude/plugins — niente da aggiornare.\n",
    );
    process.exit(1);
  }

  const files = [
    ["claude-code-plugin/dist/lib/hook.mjs", "dist/lib/hook.mjs"],
    ["claude-code-plugin/hooks/hooks.json", "hooks/hooks.json"],
  ];
  for (const target of targets) {
    for (const [from, to] of files) {
      const src = join(REPO, from);
      const dst = join(target, to);
      if (!existsSync(src)) throw new Error(`manca ${src}`);
      copyFileSync(src, dst);
    }
    process.stdout.write(`Installato in ${target}\n`);
  }
  process.stdout.write(
    "\nFatto. Riapri Claude Code perché gli agganci vengano ricaricati.\n",
  );
}

main();
