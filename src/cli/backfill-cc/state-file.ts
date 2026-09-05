/**
 * The resumable ledger for `--run` and `--digest`:
 * `<data-dir>/backfill-cc-state.json`.
 *
 * Two independent sections, both keyed by a stable id:
 *  - `sessions[sessionId]`  — per-transcript replay progress (what the task
 *    spec calls "session id → status, turns sent, last error").
 *  - `digest[sessionKey]`   — per-project-key `/digest` progress, since
 *    digesting is keyed by `session_key` (a project), not by session id.
 *
 * `mergeState` is the only pure piece; `loadState`/`saveState` are thin IO
 * wrappers around it so a crashed `--run`/`--digest` resumes exactly where
 * it left off (unattempted / failed entries are retried, `done`/`replayed`
 * entries are skipped unless the caller passes `--force`).
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionStatus = "pending" | "replayed" | "partial" | "failed";
export type DigestStatus = "pending" | "done" | "failed";

export interface SessionState {
  status: SessionStatus;
  sessionKey: string | null;
  turnsTotal: number;
  turnsSentBefore: number;
  turnsSentAfter: number;
  lastError: string | null;
  updatedAt: string;
}

export interface DigestState {
  status: DigestStatus;
  processedCount: number;
  lastError: string | null;
  updatedAt: string;
}

export interface BackfillState {
  version: 1;
  sessions: Record<string, SessionState>;
  digest: Record<string, DigestState>;
}

export function emptyState(): BackfillState {
  return { version: 1, sessions: {}, digest: {} };
}

/**
 * Merge a set of session/digest updates into an existing state, returning a
 * NEW object (immutable — never mutates `existing`). Later entries in
 * `updates` win over earlier ones and over `existing` on the same key.
 */
export function mergeState(
  existing: BackfillState,
  updates: {
    sessions?: Record<string, SessionState>;
    digest?: Record<string, DigestState>;
  },
): BackfillState {
  return {
    version: 1,
    sessions: { ...existing.sessions, ...(updates.sessions ?? {}) },
    digest: { ...existing.digest, ...(updates.digest ?? {}) },
  };
}

export async function loadState(path: string): Promise<BackfillState> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BackfillState>;
    return {
      version: 1,
      sessions: parsed.sessions ?? {},
      digest: parsed.digest ?? {},
    };
  } catch {
    return emptyState();
  }
}

/** Atomic write (tmp + rename), same pattern as the hook's `writeCursor`. */
export async function saveState(path: string, state: BackfillState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, path);
}

/** Distinct `session_key`s that were successfully replayed at least once. */
export function distinctReplayedKeys(state: BackfillState): string[] {
  const keys = new Set<string>();
  for (const s of Object.values(state.sessions)) {
    if ((s.status === "replayed" || s.status === "partial") && s.sessionKey) {
      keys.add(s.sessionKey);
    }
  }
  return [...keys];
}
