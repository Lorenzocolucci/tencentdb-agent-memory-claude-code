/**
 * project-key.ts — what counts as a REAL project key.
 *
 * WHY: `lessons.project` was copied from the first bug event of a cluster, and
 * event projects come from `basename(cwd)`. Measured on the live DB
 * (2026-10-03): lessons carried "AI", "src", pure digits, "tdd-canary-<ts>" and
 * "sofia-ai-<ts>". A lesson tagged with such a value either never matches its
 * own project or — worse — matches an unrelated directory called `src`. The
 * proactive layer scopes lessons HARD by project, so the key must be trustworthy.
 *
 * Pure, no I/O.
 */

/** Directory names that exist in every repo and therefore identify nothing. */
const GENERIC_DIR_NAMES: ReadonlySet<string> = new Set([
  "src", "lib", "app", "web", "api", "bin", "dist", "build", "out", "docs", "doc",
  "test", "tests", "tmp", "temp", "backend", "frontend", "client", "server", "scripts",
  "public", "node_modules", "home", "users",
]);

/** Minimum length of a plausible project name ("AI" is a truncated "Sofia AI"). */
const MIN_LENGTH = 3;

/** True when `project` looks like a real project directory name / key. */
export function isRealProjectKey(project: string | null | undefined): boolean {
  if (typeof project !== "string") return false;
  const p = project.normalize("NFKC").trim().toLowerCase();
  if (p.length < MIN_LENGTH) return false;
  if (GENERIC_DIR_NAMES.has(p)) return false;
  if (!/[a-z]/.test(p)) return false; // digits / punctuation only
  if (/^[0-9a-f]{6,}$/.test(p)) return false; // hex ids / short hashes
  if (p.startsWith("tdd-canary")) return false; // test fixtures
  if (/-\d{5,}$/.test(p)) return false; // `<name>-<epoch ms>` / worktree suffixes
  return true;
}

/**
 * The project of a cluster of events: the most common REAL project key among
 * them (ties → alphabetical, for determinism); "" when none is real. Original
 * spelling of the winning key is preserved.
 */
export function pickClusterProject(projects: readonly (string | null | undefined)[]): string {
  const counts = new Map<string, { n: number; spelling: string }>();
  for (const raw of projects) {
    if (!isRealProjectKey(raw)) continue;
    const spelling = (raw as string).trim();
    const k = spelling.normalize("NFKC").toLowerCase();
    const cur = counts.get(k);
    counts.set(k, { n: (cur?.n ?? 0) + 1, spelling: cur?.spelling ?? spelling });
  }
  let best: { key: string; n: number; spelling: string } | undefined;
  for (const [key, v] of counts) {
    if (!best || v.n > best.n || (v.n === best.n && key < best.key)) {
      best = { key, n: v.n, spelling: v.spelling };
    }
  }
  return best?.spelling ?? "";
}
