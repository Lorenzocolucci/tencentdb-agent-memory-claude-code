/**
 * Pure text formatting for `--list`: a per-class table plus the exact list
 * of session ids that `--run` would replay.
 */
import { replayCandidates } from "./build-plan.js";
import type { Plan, TranscriptClass } from "./types.js";

const CLASS_ORDER: TranscriptClass[] = [
  "captured-complete",
  "captured-partial",
  "never-captured",
  "argus-child",
  "unreadable",
];

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatPlanTable(plan: Plan, includeArgusChildren: boolean): string {
  const lines: string[] = [];
  lines.push(`Plan generated ${plan.generatedAt}`);
  lines.push(`  projects root: ${plan.projectsRoot}`);
  lines.push(`  data dir:      ${plan.dataDir}`);
  lines.push("");
  lines.push("class              count      bytes");
  lines.push("-----------------  ---------  ----------");
  let totalCount = 0;
  let totalBytes = 0;
  for (const cls of CLASS_ORDER) {
    const t = plan.totals[cls];
    totalCount += t.count;
    totalBytes += t.bytes;
    lines.push(`${cls.padEnd(18)} ${String(t.count).padStart(9)}  ${humanBytes(t.bytes).padStart(10)}`);
  }
  lines.push("-----------------  ---------  ----------");
  lines.push(`${"TOTAL".padEnd(18)} ${String(totalCount).padStart(9)}  ${humanBytes(totalBytes).padStart(10)}`);
  lines.push("");

  const candidates = replayCandidates(plan, includeArgusChildren);
  lines.push(
    `--run would replay ${candidates.length} transcript(s)` +
      (includeArgusChildren ? " (including argus-child)" : " (argus-child excluded)"),
  );
  for (const row of candidates) {
    lines.push(`  ${row.sessionId ?? "(no session id)"}  [${row.cls}]  ${row.projectDirName}`);
  }
  return lines.join("\n");
}
