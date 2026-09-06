/**
 * Stream a `<project-dir>/<uuid>.jsonl` transcript line-by-line to extract:
 *  - the `cwd` + `sessionId` needed to replay the Stop hook faithfully
 *    (both live on every `user`/`assistant` line — survey
 *    `understand-backfill.md` §3), and
 *  - the turn count, using the EXACT SAME fold as
 *    `claude-code-plugin/lib/transcript.ts` `readAllTurns` (imported: this
 *    module reuses `parseTranscriptLine` from that file and reimplements only
 *    the accumulation loop, so a future change to the parsing rule there is
 *    not silently missed here — but see the note below on why this cannot
 *    just call `readAllTurns` directly).
 *
 * WHY NOT CALL `readAllTurns` DIRECTLY
 * -------------------------------------
 * `readAllTurns` (`transcript.ts:126-163`) does `readFile(path, "utf-8")` —
 * the WHOLE file in memory, then keeps every turn's full text in an array.
 * Transcripts here run up to ~35 MB (survey §0, max 34,700,630 B) and for
 * classification we only need a COUNT, not the text. This module streams
 * with `readline` and keeps O(1) memory: it counts assistant blocks instead
 * of storing them, and never stores more than the current turn's boundary
 * state. The turn-boundary rule itself is copied verbatim from
 * `readAllTurns`:
 *   - a "turn" is a string-content `user` line followed by 1+ `assistant`
 *     lines with non-empty content;
 *   - array-content `user` lines (tool_result/attachments) are ignored —
 *     they never open OR close a turn (`entry.contentIsArray`);
 *   - a new string-content `user` line closes the previous turn ONLY if that
 *     previous turn already had at least one assistant block (else it is
 *     discarded, matching `readAllTurns`'s `if (currentUser !== null &&
 *     assistantParts.length > 0)` guard);
 *   - the trailing turn is flushed at EOF under the same guard.
 *
 * The one exception the caller must know about: this module does NOT parse
 * the malformed-JSON / non-object guard differently — it delegates that
 * entirely to `parseTranscriptLine`, so any future change to what counts as
 * a valid line is picked up automatically.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseTranscriptLine } from "../../../claude-code-plugin/lib/transcript.js";
import type { TranscriptHeader } from "./types.js";

interface RawLineFields {
  type?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
}

/** Best-effort extraction of the raw `cwd`/`sessionId` fields the parsed
 *  `TranscriptEntry` shape deliberately drops (it only keeps `type`, `role`,
 *  `content`, `uuid`, `parentUuid`, `timestamp` — see transcript.ts). */
function extractRawHeaderFields(line: string): RawLineFields | null {
  try {
    const obj: unknown = JSON.parse(line);
    if (!obj || typeof obj !== "object") return null;
    return obj as RawLineFields;
  } catch {
    return null;
  }
}

export async function readTranscriptHeader(path: string): Promise<TranscriptHeader> {
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let firstUserText: string | null = null;
  let turns = 0;

  // Turn-fold state, mirroring readAllTurns but weight-free: we track
  // "is there a pending user with >=1 assistant block" instead of storing text.
  let hasPendingUser = false;
  let pendingUserHasAssistant = false;

  let readError: string | null = null;

  await new Promise<void>((resolve) => {
    let stream;
    try {
      stream = createReadStream(path, { encoding: "utf-8" });
    } catch (err) {
      readError = (err as Error).message;
      resolve();
      return;
    }

    let settled = false;
    // Wait for 'ready' (fd successfully opened) before handing the stream to
    // `readline.createInterface`. Wiring readline up-front and relying on
    // `stream.on('error', ...)` alone is NOT enough: reproduced directly
    // (node repro, 2026-09-05) — when the underlying `fs.open` fails (e.g.
    // ENOENT), our own 'error' listener DOES run and DOES resolve the
    // promise correctly, but `readline`'s internal wiring around the same
    // destroyed stream throws a SEPARATE, unrelated exception that request
    // escapes as `uncaughtException` (not caught by our listener, since it
    // is not going through `stream.emit('error')`). Gating `createInterface`
    // behind 'ready' means readline is never attached to a stream that is
    // about to error, so that second throw cannot happen.
    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      readError = err.message;
      resolve();
    });
    stream.once("ready", () => {
      if (settled) return;
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (line.length === 0) return;

        if (cwd === null || sessionId === null) {
          const raw = extractRawHeaderFields(line);
          if (raw && (raw.type === "user" || raw.type === "assistant")) {
            if (cwd === null && typeof raw.cwd === "string") cwd = raw.cwd;
            if (sessionId === null && typeof raw.sessionId === "string") sessionId = raw.sessionId;
          }
        }

        const entry = parseTranscriptLine(line);
        if (!entry) return;

        if (entry.role === "user" && !entry.contentIsArray) {
          if (hasPendingUser && pendingUserHasAssistant) turns++;
          hasPendingUser = true;
          pendingUserHasAssistant = false;
          if (firstUserText === null) firstUserText = entry.content;
        } else if (entry.role === "assistant" && entry.content) {
          if (hasPendingUser) pendingUserHasAssistant = true;
        }
      });
      rl.on("close", () => {
        if (settled) return;
        settled = true;
        if (hasPendingUser && pendingUserHasAssistant) turns++;
        resolve();
      });
    });
  });

  return { cwd, sessionId, turns, firstUserText, readError };
}
