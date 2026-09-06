/**
 * Shared types for the Claude Code session backfill CLI
 * (`tools/backfill-cc-sessions.mts`).
 *
 * See docs at the top of the CLI entry point for the full design. This file
 * has zero runtime logic on purpose — every consumer imports the same shapes.
 */

/**
 * How a single `<project-dir>/<uuid>.jsonl` transcript relates to the live
 * capture pipeline (`claude-code-plugin/lib/hook.ts` Stop handler):
 *
 * - `captured-complete` — a cursor file exists and its `lastSentIndex` is
 *   already >= the transcript's turn count. Nothing to do.
 * - `captured-partial`  — a cursor file exists but is behind the turn count
 *   (a previous Stop failed partway, or the transcript grew after the last
 *   successful capture). Replaying finishes the job.
 * - `never-captured`    — no cursor file at all. The Stop hook never ran for
 *   this session (most commonly: hooks were disabled for the process that
 *   produced it).
 * - `argus-child`       — a `never-captured` transcript that also matches the
 *   Argus `claude -p` child heuristic (see `argus-child.ts`). Excluded from
 *   `--run` unless `--include-argus-children` is passed, so a plain run does
 *   not spend LLM budget on ~3,128 one-shot investigator transcripts by
 *   accident.
 * - `unreadable`        — the file could not be streamed, or no line yielded
 *   both `cwd` and `sessionId` (needed to replay the hook faithfully).
 */
export type TranscriptClass =
  | "captured-complete"
  | "captured-partial"
  | "never-captured"
  | "argus-child"
  | "unreadable";

/** Result of streaming a transcript file for its header fields and turn count. */
export interface TranscriptHeader {
  /** `cwd` from the first user/assistant line that carries it, or null. */
  cwd: string | null;
  /** `sessionId` from the first user/assistant line that carries it, or null. */
  sessionId: string | null;
  /** Turn count computed with the same fold as `readAllTurns` (see transcript-header.ts). */
  turns: number;
  /** Text of the first string-content `user` line, if any. Used only by the
   *  Argus-child heuristic; not the full transcript. */
  firstUserText: string | null;
  /** Set when the file could not be opened/streamed at all. */
  readError: string | null;
}

/** One enumerated `<project-dir>/<uuid>.jsonl` file, before classification. */
export interface EnumeratedTranscript {
  projectDirName: string;
  transcriptPath: string;
  bytes: number;
}

/** A fully classified transcript: enumeration + header + cursor + class. */
export interface ClassifiedTranscript {
  projectDirName: string;
  transcriptPath: string;
  bytes: number;
  sessionId: string | null;
  cwd: string | null;
  /** `getSessionKey(cwd)`, or null when `cwd` is unknown. */
  sessionKey: string | null;
  turns: number;
  /** `lastSentIndex` from the cursor file, or null when no cursor exists. */
  cursorTurns: number | null;
  cls: TranscriptClass;
  /** Populated only for `unreadable`. */
  reason?: string;
}

/** Aggregated `--list` output: one entry per class plus the raw rows. */
export interface Plan {
  generatedAt: string;
  projectsRoot: string;
  dataDir: string;
  totals: Record<TranscriptClass, { count: number; bytes: number }>;
  rows: ClassifiedTranscript[];
}
