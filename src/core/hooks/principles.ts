/**
 * Project principles injection (Track A slice 2).
 *
 * Proactive Injection must carry the WHY (binding directives / north-star), not
 * only the WHAT (recalled facts). The "forgot the vision" failure happened
 * because the north-star was a passive index pointer, not a binding directive
 * surfaced with force at the top of context.
 *
 * Source: a curated `principles.md` in the plugin data dir (trusted — WE write
 * it, unlike recalled memories). It is injected FIRST and framed as BINDING,
 * the opposite of the "for reference only" framing recalled facts get.
 */

import fs from "node:fs/promises";
import path from "node:path";

const PRINCIPLES_FILE = "principles.md";
const PRINCIPLES_DIR = "principles";

/** Read a file, returning its trimmed content or undefined when absent/empty. */
async function readTrimmed(filePath: string): Promise<string | undefined> {
  try {
    const trimmed = (await fs.readFile(filePath, "utf-8")).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined; // missing / unreadable → normal no-op
  }
}

/**
 * Reduce a project name to a safe, stable filename key: lowercase, keep only
 * [a-z0-9._-], drop everything else (path separators, traversal). Returns ''
 * when nothing safe remains — callers then skip the per-project lookup.
 */
export function sanitizeProjectKey(name: string): string {
  // Drop unsafe chars (incl. path separators), then strip any leading dots so a
  // traversal prefix like "../../" cannot survive as a "...."-prefixed filename.
  return name.toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/^\.+/, "");
}

/**
 * Load the binding principles for this data dir. Two layers, both BINDING:
 *   - GLOBAL `principles.md` — cross-project working rules.
 *   - PER-PROJECT `principles/<projectKey>.md` — that project's north-star/focus.
 * Global comes first, the project's principles after (more specific last). Either
 * may be absent; returns undefined only when BOTH are. Backward compatible: with
 * no projectName it loads exactly the global file as before.
 */
export async function loadPrinciples(
  dataDir: string,
  projectName?: string,
): Promise<string | undefined> {
  const global = await readTrimmed(path.join(dataDir, PRINCIPLES_FILE));

  let project: string | undefined;
  if (projectName) {
    const key = sanitizeProjectKey(projectName);
    if (key) project = await readTrimmed(path.join(dataDir, PRINCIPLES_DIR, `${key}.md`));
  }

  const parts = [global, project].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Wrap curated principles in a BINDING block (distinct from "reference only" facts). */
export function formatPrinciplesBlock(text: string): string {
  return (
    "<governing-principles>\n" +
    "⚠️ BINDING — the project north-star and non-negotiable directives for THIS work. " +
    "They override convenience and defaults. Read them BEFORE acting; if a plan contradicts them, the plan is wrong.\n\n" +
    text +
    "\n</governing-principles>"
  );
}
