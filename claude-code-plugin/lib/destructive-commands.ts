/**
 * Destructive-command matcher for the PostToolUse hook.
 *
 * WHY: a SUCCESSFUL destructive command (`git worktree remove` that followed a
 * junction and wiped the real node_modules, 2026-08) leaves no trace in memory:
 * success carries no error, and capture drops tool traffic by design. This
 * small explicit list lets the hook tag such a Bash call as `tool_risk:
 * "destructive"` so the gateway records it and can link a later user
 * correction to it.
 *
 * Deliberately simple: a rule matches anywhere in the command string, so
 * `echo "rm -rf"` matches too. That false positive is accepted — the cost is
 * one harmless observation row, while a miss is a lost lesson. What must NOT
 * match are the everyday read-only siblings (`git worktree list`, `git clean
 * -n`, `npm run format`, `git push` without force).
 */

export interface DestructiveRule {
  /** Short stable label, also usable as part of a signature. */
  label: string;
  pattern: RegExp;
}

/** Commands whose success is worth remembering. Order = first match wins. */
export const DESTRUCTIVE_RULES: readonly DestructiveRule[] = [
  { label: "git worktree remove", pattern: /\bgit\s+worktree\s+remove\b/ },
  // rm with a recursive flag, in any short-flag combination (-r, -rf, -fr, -R, -Rf …).
  { label: "rm -r", pattern: /(^|[\s;&|"'(])rm\s+(-[A-Za-z]*[rR][A-Za-z]*\b|--recursive\b)/ },
  { label: "git reset --hard", pattern: /\bgit\s+reset\s+(?:[^|&;]*\s)?--hard\b/ },
  // git clean with a short-flag group containing f (-f, -fd, -fdx, -xdf …).
  { label: "git clean -f", pattern: /\bgit\s+clean\b[^|&;]*\s-[A-Za-z]*f[A-Za-z]*\b/ },
  { label: "git push --force", pattern: /\bgit\s+push\b[^|&;]*\s(?:--force(?:-with-lease)?\b|-f\b)/ },
  { label: "git branch -D", pattern: /\bgit\s+branch\s+(?:[^|&;]*\s)?-D\b/ },
  { label: "DROP TABLE", pattern: /\bdrop\s+table\b/i },
  { label: "TRUNCATE", pattern: /\btruncate\b/i },
  { label: "del /s", pattern: /(^|[\s;&|"'(])del\s+(?:\/[a-z]\s+)*\/s\b/i },
  { label: "Remove-Item -Recurse", pattern: /\bremove-item\b[^|&;]*\s-recurse\b/i },
  // `format X:` (disk format). The bare word `format` is far too common
  // (`npm run format`, `--format json`), so a drive letter is required.
  { label: "format <drive>", pattern: /(^|[\s;&|"'(])format\s+[a-z]:/i },
];

/**
 * Returns the label of the first destructive rule matching `command`, or null
 * when the command is not on the list.
 */
export function matchDestructiveCommand(command: unknown): string | null {
  if (typeof command !== "string" || !command.trim()) return null;
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(command)) return rule.label;
  }
  return null;
}
