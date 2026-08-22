/**
 * NO SILENT FAILURE.
 *
 * Sinapsys stopped capturing on 2026-08-13 and nobody noticed until 2026-08-22,
 * because every failure mode wrote to a log file nobody reads:
 *
 *   - the gateway was down for 5 days      → "connect ECONNREFUSED" in hook.log
 *   - the data dir could not be resolved   → "no daemon, skipped" in hook.log
 *   - a capture could be dropped gateway-side with nothing written at all
 *
 * A log file is not a signal. This module turns a failure into something the
 * USER sees, using the only channel Claude Code renders directly to them: the
 * `systemMessage` field of a UserPromptSubmit hook.
 *
 * Because a hook process is short-lived and a failure usually happens in a
 * DIFFERENT hook (stop / session-start) than the one that can speak
 * (user-prompt-submit), alarms are persisted as a breadcrumb file and drained
 * on the next prompt. Nothing is ever lost and nothing is ever silent.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";

export const ALARM_FILE = "alarms.json";

/** Distinct failure modes. One entry per code — repeats bump `count`. */
export type AlarmCode =
  | "data-dir-lost"
  | "gateway-unreachable"
  | "capture-failed"
  | "capture-empty"
  | "memory-stale";

export interface AlarmRecord {
  code: AlarmCode;
  message: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

/** Human-facing prefix. Deliberately loud — this is the whole point. */
const PREFIX = "🚨 SINAPSYS";

export async function readAlarms(dataDir: string): Promise<AlarmRecord[]> {
  try {
    const raw = await readFile(join(dataDir, ALARM_FILE), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAlarmRecord);
  } catch {
    return [];
  }
}

function isAlarmRecord(v: unknown): v is AlarmRecord {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.code === "string" && typeof o.message === "string";
}

/**
 * Record a failure. Never throws: an alarm that crashes the hook would be a
 * worse bug than the one it reports.
 *
 * Repeats of the same code are collapsed into one record with a counter, so a
 * gateway that has been down for five days produces one clear line
 * ("×512 volte, dal 13/08") instead of five days of noise.
 */
export async function raiseAlarm(
  dataDir: string,
  code: AlarmCode,
  message: string,
  now: Date = new Date(),
): Promise<void> {
  const iso = now.toISOString();
  try {
    const existing = await readAlarms(dataDir);
    const prev = existing.find((a) => a.code === code);
    const next: AlarmRecord[] = prev
      ? existing.map((a) =>
          a.code === code
            ? { ...a, message, lastSeen: iso, count: a.count + 1 }
            : a,
        )
      : [...existing, { code, message, firstSeen: iso, lastSeen: iso, count: 1 }];

    const path = join(dataDir, ALARM_FILE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(next, null, 1), { mode: 0o600 });
  } catch {
    // Last resort: at least reach stderr.
  }
  // Immediate channel, in addition to the persisted breadcrumb.
  try {
    process.stderr.write(`${PREFIX}: ${message}\n`);
  } catch {
    // ignore
  }
}

/** Clear a specific alarm once the underlying condition is healthy again. */
export async function clearAlarm(dataDir: string, code: AlarmCode): Promise<void> {
  try {
    const existing = await readAlarms(dataDir);
    const next = existing.filter((a) => a.code !== code);
    if (next.length === existing.length) return;
    const path = join(dataDir, ALARM_FILE);
    if (next.length === 0) {
      await rm(path, { force: true });
      return;
    }
    await writeFile(path, JSON.stringify(next, null, 1), { mode: 0o600 });
  } catch {
    // ignore
  }
}

/**
 * Render pending alarms as a single user-facing line, then clear them.
 *
 * Returns "" when everything is healthy, so the caller can simply skip the
 * `systemMessage` field.
 */
export async function drainAlarms(dataDir: string): Promise<string> {
  const alarms = await readAlarms(dataDir);
  if (alarms.length === 0) return "";
  const parts = alarms.map((a) => {
    const times = a.count > 1 ? ` (×${a.count}, dal ${a.firstSeen.slice(0, 16).replace("T", " ")})` : "";
    return `${a.message}${times}`;
  });
  try {
    await rm(join(dataDir, ALARM_FILE), { force: true });
  } catch {
    // ignore
  }
  return `${PREFIX} — la memoria NON sta funzionando: ${parts.join(" · ")}`;
}
