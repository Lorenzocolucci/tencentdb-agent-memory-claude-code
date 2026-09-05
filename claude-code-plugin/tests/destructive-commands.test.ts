import { describe, it, expect } from "vitest";
import { matchDestructiveCommand } from "../lib/destructive-commands.js";

describe("matchDestructiveCommand — matches", () => {
  const cases: Array<[string, string]> = [
    ["git worktree remove C:/Sinapsys-wt-plugin", "git worktree remove"],
    ["git worktree remove --force ../wt", "git worktree remove"],
    ["rm -rf node_modules", "rm -r"],
    ["rm -r build", "rm -r"],
    ["rm -fr dist", "rm -r"],
    ["rm -Rf /tmp/x", "rm -r"],
    ["rm --recursive out", "rm -r"],
    ["cd /tmp && rm -rf ./cache", "rm -r"],
    ["git reset --hard origin/main", "git reset --hard"],
    ["git reset --hard", "git reset --hard"],
    ["git clean -f", "git clean -f"],
    ["git clean -fdx", "git clean -f"],
    ["git clean -xdf", "git clean -f"],
    ["git push --force origin main", "git push --force"],
    ["git push origin main --force-with-lease", "git push --force"],
    ["git push -f", "git push --force"],
    ["git branch -D work/old", "git branch -D"],
    ["psql -c 'DROP TABLE sofia_lead'", "DROP TABLE"],
    ["psql -c 'drop table x'", "DROP TABLE"],
    ["psql -c 'TRUNCATE financial_records'", "TRUNCATE"],
    ["del /s /q C:\\tmp\\x", "del /s"],
    ["del /q /s C:\\tmp\\x", "del /s"],
    ["Remove-Item -Recurse -Force .\\dist", "Remove-Item -Recurse"],
    ["Remove-Item .\\dist -Recurse", "Remove-Item -Recurse"],
    ["format D: /q", "format <drive>"],
    // Documented, accepted false positive: the text sits inside a quoted echo.
    ['echo "rm -rf is dangerous"', "rm -r"],
  ];
  for (const [cmd, label] of cases) {
    it(`matches ${JSON.stringify(cmd)} as "${label}"`, () => {
      expect(matchDestructiveCommand(cmd)).toBe(label);
    });
  }
});

describe("matchDestructiveCommand — non-matches", () => {
  const cases: string[] = [
    "git worktree list",
    "git worktree add ../wt feature/x",
    "git worktree prune",
    "rm file.txt",
    "rm -f file.txt",
    "rmdir empty",
    "git reset HEAD~1",
    "git reset --soft HEAD~1",
    "git clean -n",
    "git clean --dry-run",
    "git push origin main",
    "git push -u origin work/x",
    "git branch -d merged",
    "git branch -a",
    "npm run format",
    "prettier --format json src/",
    "eslint --format stylish .",
    "SELECT * FROM table_drops",
    "ls -la",
    "del file.txt",
    "Remove-Item .\\file.txt",
    "truncated=1 node x.mjs",
    "",
    "   ",
  ];
  for (const cmd of cases) {
    it(`does not match ${JSON.stringify(cmd)}`, () => {
      expect(matchDestructiveCommand(cmd)).toBeNull();
    });
  }

  it("returns null for non-string input", () => {
    expect(matchDestructiveCommand(undefined)).toBeNull();
    expect(matchDestructiveCommand(null)).toBeNull();
    expect(matchDestructiveCommand({ command: "rm -rf x" })).toBeNull();
    expect(matchDestructiveCommand(42)).toBeNull();
  });
});
