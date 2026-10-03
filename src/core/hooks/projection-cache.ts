/**
 * Recall-path file projections, cached by file signature (Sinapsys fix plan 2.7).
 *
 * The persona (`persona.md`, hundreds of KB) and the binding principles are read
 * from disk on EVERY recall and the persona is then re-stripped. Their content
 * changes on a minutes-to-days scale, so the processed text is reused until the
 * file's (mtime, size) signature changes. A `stat` per recall is the only cost;
 * the injected TEXT is byte-identical to what the uncached path produced.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { loadPrinciples, sanitizeProjectKey } from "./principles.js";

const MAX_ENTRIES = 64;

interface Entry {
  sig: string;
  value: string | undefined;
}

const cache = new Map<string, Entry>();

function remember(key: string, entry: Entry): void {
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

/** `mtimeMs:size` of a file, or "absent" when it cannot be stat-ed. */
async function fileSig(file: string): Promise<string> {
  try {
    const st = await fs.stat(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "absent";
  }
}

/**
 * Read + transform the persona file, reusing the previous result while the file
 * is unchanged. Missing file or empty content -> undefined (same as the uncached
 * path: an absent persona is normal for new users).
 */
export async function readPersonaCached(
  personaPath: string,
  strip: (raw: string) => string,
): Promise<string | undefined> {
  const sig = await fileSig(personaPath);
  if (sig === "absent") {
    cache.delete(personaPath);
    return undefined;
  }
  const hit = cache.get(personaPath);
  if (hit && hit.sig === sig) return hit.value;
  try {
    const raw = await fs.readFile(personaPath, "utf-8");
    const text = strip(raw).trim();
    const value = text.length > 0 ? text : undefined;
    remember(personaPath, { sig, value });
    return value;
  } catch {
    return undefined; // unreadable -> behaves as "no persona", never cached
  }
}

/**
 * {@link loadPrinciples}, reusing the previous result while both source files
 * (global `principles.md` + the project's `principles/<key>.md`) are unchanged.
 */
export async function loadPrinciplesCached(
  dataDir: string,
  projectName?: string,
): Promise<string | undefined> {
  const globalFile = path.join(dataDir, "principles.md");
  const key = projectName ? sanitizeProjectKey(projectName) : "";
  const projectFile = key ? path.join(dataDir, "principles", `${key}.md`) : "";
  const sig = `${await fileSig(globalFile)}|${projectFile ? await fileSig(projectFile) : "none"}`;
  const cacheKey = `principles:${globalFile}|${projectFile}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.sig === sig) return hit.value;
  const value = await loadPrinciples(dataDir, projectName);
  remember(cacheKey, { sig, value });
  return value;
}

/** Test-only: drop every cached projection. */
export function _resetProjectionCacheForTest(): void {
  cache.clear();
}
