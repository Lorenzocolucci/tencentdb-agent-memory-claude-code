/**
 * The last tripwire: "memory has a HOLE".
 *
 * The other alarms fire when something reports an error. This one fires when
 * nothing reports anything — the failure mode that actually happened. A hook
 * that is never called cannot complain; a gateway that is up but starving
 * answers 200 forever. So we compare two independent facts:
 *
 *   A. the newest message memory has stored     (from /health last_capture_at)
 *   B. the newest Claude Code session on disk   (transcript mtimes)
 *
 * If sessions kept happening well after memory stopped recording, there is a
 * hole — regardless of which component broke, or whether it ever said so.
 *
 * Crucially this does NOT fire during a holiday: with no new sessions, B stops
 * advancing too, and the two stay in step.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** A gap this large between work and memory is a fault, not a lull. */
export const STALE_GAP_MS = 24 * 60 * 60 * 1000;

export interface StalenessVerdict {
  stale: boolean;
  /** Milliseconds by which the newest session outruns the newest memory. */
  gapMs: number;
  lastCapture: Date | null;
  lastSession: Date | null;
}

/** mtime of the most recently written transcript under ~/.claude/projects. */
export function newestTranscriptMs(projectsRoot: string): number {
  let newest = 0;
  let dirs: string[];
  try {
    dirs = readdirSync(projectsRoot);
  } catch {
    return 0;
  }
  for (const d of dirs) {
    const dir = join(projectsRoot, d);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const m = statSync(join(dir, f)).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        // unreadable file — ignore
      }
    }
  }
  return newest;
}

/**
 * Decide whether memory is lagging behind real work.
 *
 * Unknowns are never treated as faults: a missing `last_capture_at` (old
 * gateway, alternative store) or an unreadable projects dir yields `stale:false`.
 * A false alarm would train the user to ignore alarms, which is the one thing
 * this whole mechanism cannot afford.
 */
export function assessStaleness(
  lastCaptureIso: string | null | undefined,
  newestSessionMs: number,
  nowMs: number,
  gapMs: number = STALE_GAP_MS,
): StalenessVerdict {
  const captureMs = lastCaptureIso ? Date.parse(lastCaptureIso) : NaN;
  if (!Number.isFinite(captureMs) || newestSessionMs <= 0) {
    return { stale: false, gapMs: 0, lastCapture: null, lastSession: null };
  }
  // Ignore transcript mtimes in the future (clock skew, sync tools).
  const session = Math.min(newestSessionMs, nowMs);
  const gap = session - captureMs;
  return {
    stale: gap > gapMs,
    gapMs: Math.max(0, gap),
    lastCapture: new Date(captureMs),
    lastSession: new Date(session),
  };
}

export function describeStaleness(v: StalenessVerdict): string {
  const days = Math.floor(v.gapMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor(v.gapMs / (60 * 60 * 1000)) % 24;
  const age = days > 0 ? `${days} giorni e ${hours} ore` : `${hours} ore`;
  const last = v.lastCapture ? v.lastCapture.toISOString().slice(0, 16).replace("T", " ") : "mai";
  return `BUCO nella memoria: hai lavorato per ${age} dopo l'ultimo ricordo salvato (${last})`;
}
