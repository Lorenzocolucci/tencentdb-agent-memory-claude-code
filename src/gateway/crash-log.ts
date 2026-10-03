/**
 * Crash black box: an uncaught exception / unhandled rejection is appended to
 * `<dataDir>/gateway.crash.log` (synchronously - the process is about to die)
 * and the process exits 1. Before this, a crash left nothing but a truncated
 * stderr, which the next start overwrote.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const CRASH_LOG_FILE = "gateway.crash.log";

export type CrashKind = "uncaughtException" | "unhandledRejection";

export function formatCrashEntry(kind: CrashKind, err: unknown, now: Date = new Date()): string {
  const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  return `${now.toISOString()} pid=${process.pid} ${kind}: ${detail}\n`;
}

/** Append one entry. Never throws: a failing black box must not mask the crash. */
export function writeCrashLog(dataDir: string, kind: CrashKind, err: unknown, file: string = CRASH_LOG_FILE): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, file), formatCrashEntry(kind, err), "utf-8");
  } catch (writeErr) {
    process.stderr.write(`tdai-memory-gateway: could not write ${CRASH_LOG_FILE}: ${String(writeErr)}\n`);
  }
}

export interface CrashHandlerTarget {
  on(event: "uncaughtException" | "unhandledRejection", listener: (err: unknown) => void): unknown;
}

/** Install the handlers. `exit` and `target` are injectable for tests. */
export function installCrashHandlers(
  dataDir: string,
  exit: (code: number) => void = (code) => process.exit(code),
  target: CrashHandlerTarget = process,
  file: string = CRASH_LOG_FILE,
): void {
  const handle = (kind: CrashKind) => (err: unknown): void => {
    writeCrashLog(dataDir, kind, err, file);
    process.stderr.write(`tdai-memory-gateway: fatal ${kind}: ${String(err)}\n`);
    exit(1);
  };
  target.on("uncaughtException", handle("uncaughtException"));
  target.on("unhandledRejection", handle("unhandledRejection"));
}
