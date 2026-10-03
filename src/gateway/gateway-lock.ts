/**
 * Exclusive gateway lock: `<dataDir>/gateway.lock`.
 *
 * Why (2026-10-03): two gateways ran against the same data dir (a hook spawn
 * racing the scheduled task). Both opened the SQLite store and both drained the
 * capture inbox, so sessions were stored twice. The TCP port alone is not a
 * lock: the second process only learns it lost AFTER the slow initialize().
 * The lock is taken BEFORE initialize and held until stop().
 *
 * Mechanism: `open(path, 'wx')` is atomic. A leftover file whose PID is dead
 * (crash, kill -9) is stale and is taken over; a live PID means "someone else
 * owns this data dir".
 */
import { open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const GATEWAY_LOCK_FILE = "gateway.lock";

/** A lock file this young with unreadable content is a writer mid-write, not stale. */
const MID_WRITE_GRACE_MS = 5_000;

export class GatewayLockHeldError extends Error {
  readonly ownerPid: number | null;
  constructor(lockPath: string, ownerPid: number | null) {
    super(
      `Another gateway already owns this data directory (lock ${lockPath}, pid ${ownerPid ?? "unknown"}). Exiting.`,
    );
    this.name = "GatewayLockHeldError";
    this.ownerPid = ownerPid;
  }
}

export interface GatewayLock {
  readonly path: string;
  /** Remove the lock file if (and only if) it still names this process. */
  release(): Promise<void>;
}

export interface GatewayLockOptions {
  pid?: number;
  /** Lock file name inside the data dir (default `gateway.lock`; the worker uses `worker.lock`). */
  fileName?: string;
  /** Injectable liveness probe (tests). */
  isAlive?: (pid: number) => boolean;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else - still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwnerPid(path: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function tryCreate(path: string, pid: number): Promise<boolean> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(JSON.stringify({ pid, acquiredAt: new Date().toISOString() }), "utf-8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** True when the existing lock file does not protect a live owner. */
async function isStale(path: string, isAlive: (pid: number) => boolean): Promise<boolean> {
  const ownerPid = await readOwnerPid(path);
  if (ownerPid !== null) return !isAlive(ownerPid);
  const s = await stat(path).catch(() => null);
  if (!s) return true; // vanished between EEXIST and now
  return Date.now() - s.mtimeMs > MID_WRITE_GRACE_MS;
}

/**
 * Take the lock or throw {@link GatewayLockHeldError}. The data dir must exist.
 */
export async function acquireGatewayLock(dataDir: string, opts: GatewayLockOptions = {}): Promise<GatewayLock> {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? isPidAlive;
  const path = join(dataDir, opts.fileName ?? GATEWAY_LOCK_FILE);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (await tryCreate(path, pid)) {
      return {
        path,
        release: async () => {
          if ((await readOwnerPid(path)) === pid) await rm(path, { force: true });
        },
      };
    }
    if (!(await isStale(path, isAlive))) break;
    await rm(path, { force: true });
  }
  throw new GatewayLockHeldError(path, await readOwnerPid(path));
}
