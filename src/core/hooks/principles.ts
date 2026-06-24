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

/** Read the curated principles for this data dir, or undefined when absent/empty. */
export async function loadPrinciples(dataDir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(dataDir, PRINCIPLES_FILE), "utf-8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    // Missing / unreadable principles file is a normal no-op.
    return undefined;
  }
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
