/**
 * Orchestrates enumerate → stream header → read cursor → classify for every
 * transcript under `projectsRoot`, and aggregates per-class totals. This is
 * the entire `--list` computation (read-only: it opens transcript files and
 * cursor files for reading only, never writes anywhere).
 *
 * Files are processed with bounded concurrency so a --list run over ~3,190
 * files does not open them all at once (Windows has a real fd limit) nor run
 * fully serially (each file is a stream open + close).
 */
import { readCursorTurns } from "./cursor.js";
import { readTranscriptHeader } from "./transcript-header.js";
import { classifyTranscript } from "./classify.js";
import { enumerateTranscripts } from "./enumerate.js";
import type { ClassifiedTranscript, Plan, TranscriptClass } from "./types.js";

const ALL_CLASSES: TranscriptClass[] = [
  "captured-complete",
  "captured-partial",
  "never-captured",
  "argus-child",
  "unreadable",
];

const DEFAULT_CONCURRENCY = 16;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface BuildPlanOptions {
  projectsRoot: string;
  dataDir: string;
  concurrency?: number;
}

export async function buildPlan(opts: BuildPlanOptions): Promise<Plan> {
  const files = enumerateTranscripts(opts.projectsRoot);

  const rows = await mapWithConcurrency(files, opts.concurrency ?? DEFAULT_CONCURRENCY, async (file) => {
    const header = await readTranscriptHeader(file.transcriptPath);
    const cursorTurns =
      header.sessionId !== null ? await readCursorTurns(opts.dataDir, header.sessionId) : null;
    return classifyTranscript(file, header, cursorTurns);
  });

  const totals = Object.fromEntries(
    ALL_CLASSES.map((cls) => [cls, { count: 0, bytes: 0 }]),
  ) as Record<TranscriptClass, { count: number; bytes: number }>;
  for (const row of rows) {
    totals[row.cls].count += 1;
    totals[row.cls].bytes += row.bytes;
  }

  return {
    generatedAt: new Date().toISOString(),
    projectsRoot: opts.projectsRoot,
    dataDir: opts.dataDir,
    totals,
    rows,
  };
}

/** Rows that `--run` would replay, given whether Argus children are included. */
export function replayCandidates(plan: Plan, includeArgusChildren: boolean): ClassifiedTranscript[] {
  return plan.rows.filter(
    (r) =>
      r.cls === "never-captured" ||
      r.cls === "captured-partial" ||
      (includeArgusChildren && r.cls === "argus-child"),
  );
}
