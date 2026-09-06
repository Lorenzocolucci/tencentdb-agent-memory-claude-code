/**
 * Enumerate main-session transcripts: `<projects-root>/<project-dir>/<uuid>.jsonl`,
 * depth exactly 2 relative to `projectsRoot`. Sub-agent transcripts one level
 * deeper (`<project-dir>/<uuid>/<nested>.jsonl`) are never visited — by design
 * (survey §3: "never captured by design", 1172 such files exist and are out
 * of scope for this tool).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EnumeratedTranscript } from "./types.js";

export function enumerateTranscripts(projectsRoot: string): EnumeratedTranscript[] {
  const out: EnumeratedTranscript[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsRoot);
  } catch {
    return out;
  }

  for (const projectDirName of projectDirs) {
    const dirPath = join(projectsRoot, projectDirName);
    let dirStat;
    try {
      dirStat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const transcriptPath = join(dirPath, entry);
      let fileStat;
      try {
        fileStat = statSync(transcriptPath);
      } catch {
        continue;
      }
      if (!fileStat.isFile()) continue;
      out.push({ projectDirName, transcriptPath, bytes: fileStat.size });
    }
  }
  return out;
}
