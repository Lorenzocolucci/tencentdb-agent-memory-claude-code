/**
 * Heuristic: is this a one-shot Argus `claude -p` investigator/reporter child,
 * rather than a real interactive Claude Code session?
 *
 * WHY IT EXISTS
 * -------------
 * Argus (`C:/Argus`) spawns `claude -p … --settings claude-child-settings.json`
 * with `disableAllHooks: true` (see `C:/Argus/engine/lib/child-env.mjs:44-61`),
 * so the tdai Stop hook never runs for these processes and every one of them
 * is `never-captured`. There are ~3,128 of them (survey 2026-09-05,
 * `C:/tmp-sinapsys/understand-backfill.md` §0) — almost all of the uncaptured
 * corpus by file count. Replaying + digesting them is a real LLM-budget
 * decision, not a bug fix, so they get their own class and require an
 * explicit `--include-argus-children` flag on `--run`.
 *
 * THE RULE (as specified by the task, both conditions required first)
 * ---------------------------------------------------------------------
 * 1. `projectDirName` starts with `C--Argus` (covers the main dir AND every
 *    worktree dir seen in the survey: `C--Argus-l6`, `-l5`, `-l17`, `-d`,
 *    `-l14`, `-b`, `-l13`, `-l11`, `-f`, `-l18`, `-a/-c/-e/-g/-l16/-l19`,
 *    `-docs`).
 * 2. `turns === 1` — every Argus child transcript on disk has exactly one
 *    turn (survey §0: "3130 turns — every file has exactly 1 turn").
 *
 * ...then EITHER:
 * 3a. the first user message is longer than 2000 chars, OR
 * 3b. it matches the Argus system-preamble marker.
 *
 * THE MARKER, measured (not guessed)
 * -----------------------------------
 * A direct scan of every `C--Argus*` transcript ≤150 KB on disk
 * (2026-09-05, ad-hoc Node script, not committed — reproducible by reading
 * the first string-content `user` line of every `.jsonl` under
 * `~/.claude/projects/C--Argus*`) found 3131 such files. Applying
 * `isLong OR marker` classifies **3128/3131 (99.9%)** as Argus children —
 * matching the survey's independently-measured "3128 under C--Argus*"
 * exactly (`understand-backfill.md` §0). The 3 that slip through are all
 * short (<2000 chars) one-line acks/instructions that never say "Argus"
 * ("rispondi solo: ok\n", "Rispondi solo: OK\n", "Run exactly this shell
 * command with the Bash tool …") — they fall through to `never-captured`
 * and WOULD be replayed by a plain `--run`. Accepted: 3/3131 (<0.1%) is a
 * known, documented gap, not silently wrong.
 *
 * The marker check is a case-insensitive prefix match (allowing leading
 * whitespace) rather than a substring search anywhere in the text, so a
 * real investigation transcript that merely *mentions* Argus deep in a long
 * prompt is never misclassified.
 */
const ARGUS_PREAMBLE_RE = /^\s*sei\s+argus\b/i;

const LONG_MESSAGE_THRESHOLD = 2000;

export interface ArgusChildInput {
  projectDirName: string;
  turns: number;
  /** First string-content user message text, or null if none was found. */
  firstUserText: string | null;
}

export function isArgusProjectDir(projectDirName: string): boolean {
  return projectDirName.startsWith("C--Argus");
}

export function isArgusChild(input: ArgusChildInput): boolean {
  if (!isArgusProjectDir(input.projectDirName)) return false;
  if (input.turns !== 1) return false;
  const text = input.firstUserText ?? "";
  if (text.length > LONG_MESSAGE_THRESHOLD) return true;
  return ARGUS_PREAMBLE_RE.test(text);
}
