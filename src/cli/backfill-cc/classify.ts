/**
 * Pure classification: combine an enumerated file + its streamed header +
 * its cursor lookup into a single `ClassifiedTranscript`.
 *
 * Precedence (checked in this order):
 *  1. `unreadable`       — the stream errored, or no line yielded both
 *     `cwd` and `sessionId` (both are required to replay the hook: it needs
 *     `cwd` for `getSessionKey`/`session_key`, and `sessionId` for the
 *     cursor filename).
 *  2. cursor file EXISTS  → `captured-complete` (cursor >= turns) or
 *     `captured-partial` (cursor < turns). This takes priority over the
 *     Argus-child check: a transcript that already went through `/capture`
 *     is "done" regardless of what it looks like.
 *  3. no cursor file      → `argus-child` if it matches the heuristic,
 *     otherwise `never-captured`.
 */
import { isArgusChild } from "./argus-child.js";
import { getSessionKey } from "../../../claude-code-plugin/lib/session-key.js";
import type { ClassifiedTranscript, EnumeratedTranscript, TranscriptHeader } from "./types.js";

export function classifyTranscript(
  file: EnumeratedTranscript,
  header: TranscriptHeader,
  cursorTurns: number | null,
): ClassifiedTranscript {
  const base = {
    projectDirName: file.projectDirName,
    transcriptPath: file.transcriptPath,
    bytes: file.bytes,
    sessionId: header.sessionId,
    cwd: header.cwd,
    sessionKey: header.cwd !== null ? getSessionKey(header.cwd) : null,
    turns: header.turns,
    cursorTurns,
  };

  if (header.readError !== null) {
    return { ...base, cls: "unreadable", reason: `read error: ${header.readError}` };
  }
  if (header.cwd === null || header.sessionId === null) {
    return {
      ...base,
      cls: "unreadable",
      reason: "no user/assistant line carried both cwd and sessionId",
    };
  }

  if (cursorTurns !== null) {
    return { ...base, cls: cursorTurns >= header.turns ? "captured-complete" : "captured-partial" };
  }

  const argus = isArgusChild({
    projectDirName: file.projectDirName,
    turns: header.turns,
    firstUserText: header.firstUserText,
  });
  return { ...base, cls: argus ? "argus-child" : "never-captured" };
}
