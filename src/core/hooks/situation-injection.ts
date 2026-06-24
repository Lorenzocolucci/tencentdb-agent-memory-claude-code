/**
 * File → memory match (Track A 3+4, the "inject" half).
 *
 * Given a file the agent just touched, surface what the associative graph
 * already knows about it: current facts + events referencing it. This is the
 * memory that "comes to you" when you open a file — proactive injection by
 * SITUATION (the file), not by the words of a query.
 *
 * GOLDEN RULE (Lorenzo's choice): silent unless relevant. Unknown file, or a
 * known file with nothing tied to it → return null. No noise, ever.
 *
 * Lessons (Track B) plug in here later: once the Mistake Notebook is populated,
 * a file's lessons join the facts/events in this block.
 */

import type { IMemoryStore } from "../store/types.js";
import { canonicalKey } from "../kb/kb-queries.js";

const NAMESPACE = "default";
const MAX_FACTS = 6;
const MAX_EVENTS = 4;
const MAX_LINE = 160;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1)}…` : t;
}

/** Candidate canonical keys for a touched file: full posix path AND basename. */
function fileKeyCandidates(filePath: string): string[] {
  const full = canonicalKey("file", filePath); // already posix-normalized + lowercased
  // Derive the basename from the NORMALIZED key (always "/"-separated), never
  // from the raw input — Windows backslash paths must not depend on a fragile
  // split of the original string.
  const posixPath = full.startsWith("file:") ? full.slice("file:".length) : full;
  const base = posixPath.split("/").filter(Boolean).pop() ?? posixPath;
  const baseKey = `file:${base}`;
  // The KB stores file entities inconsistently (sometimes the full path,
  // sometimes the basename), so try both; dedupe when they coincide.
  return full === baseKey ? [full] : [full, baseKey];
}

/**
 * Build the proactive memory block for a touched file, or null when there is
 * nothing worth surfacing (the silent-unless-relevant rule).
 */
export function buildFileInjection(store: IMemoryStore, filePath: string): string | null {
  if (!store.queryEntityByKey || !store.queryHeadFacts || !store.queryEventsForEntity) {
    return null; // backend without KB read primitives → silence
  }

  // Resolve the file entity by full-path key, falling back to basename key.
  let entity = null as ReturnType<NonNullable<IMemoryStore["queryEntityByKey"]>>;
  for (const key of fileKeyCandidates(filePath)) {
    const found = store.queryEntityByKey(NAMESPACE, "file", key);
    if (found) {
      entity = found;
      break;
    }
  }
  if (!entity) return null; // unknown file → silence

  const facts = store.queryHeadFacts(entity.id).slice(0, MAX_FACTS);
  const events = store.queryEventsForEntity(entity.id, NAMESPACE, MAX_EVENTS);
  if (facts.length === 0 && events.length === 0) return null; // nothing tied → silence

  const lines: string[] = [];
  for (const f of facts) {
    lines.push(`- ${f.attribute}: ${clip(f.value)}`);
  }
  for (const e of events) {
    lines.push(`- (${e.type}) ${clip(e.text)}`);
  }

  return (
    "<file-memory>\n" +
    `📌 What memory already knows about ${entity.name} (proactive — reference, not a task):\n` +
    lines.join("\n") +
    "\n</file-memory>"
  );
}

/**
 * Resolve the owner entity id for a touched file (full-path key, basename
 * fallback), or null when the file is unknown. Used by the Context Fingerprint
 * wiring to learn which owner a situation surfaced and to dedup against the
 * single-file block — additive, no change to {@link buildFileInjection}.
 */
export function resolveFileOwnerId(store: IMemoryStore, filePath: string): string | null {
  if (!store.queryEntityByKey) return null;
  for (const key of fileKeyCandidates(filePath)) {
    const found = store.queryEntityByKey(NAMESPACE, "file", key);
    if (found) return found.id;
  }
  return null;
}
