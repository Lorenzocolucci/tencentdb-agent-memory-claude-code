/**
 * Read the Stop hook's per-session cursor file, the SAME file
 * `claude-code-plugin/lib/hook.ts` `readCursor`/`writeCursor` use
 * (`<dataDir>/cursors/<sanitizeCursorId(sessionId)>.json`,
 * `{lastSentIndex, updatedAt}` — hook.ts:432-463).
 *
 * `sanitizeCursorId` below is copied verbatim from `hook.ts` (it is not
 * exported there). Session ids on disk are plain UUIDs, so in practice this
 * never changes the id — it exists purely so a lookup here can never diverge
 * from what a real replay would write.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function sanitizeCursorId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default";
}

/**
 * Returns the cursor's `lastSentIndex`, or `null` when no cursor file exists
 * (or it is unreadable/malformed — treated the same as "never captured",
 * matching the hook's own `readCursor` fallback of 0 turned into "no cursor"
 * for classification purposes by the caller).
 */
export async function readCursorTurns(dataDir: string, sessionId: string): Promise<number | null> {
  const cursorId = sanitizeCursorId(sessionId);
  const path = join(dataDir, "cursors", `${cursorId}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    const obj = JSON.parse(raw) as { lastSentIndex?: unknown };
    return typeof obj.lastSentIndex === "number" && obj.lastSentIndex >= 0 ? obj.lastSentIndex : null;
  } catch {
    return null;
  }
}
