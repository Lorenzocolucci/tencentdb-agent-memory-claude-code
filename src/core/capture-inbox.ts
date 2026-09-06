/**
 * Durable capture inbox — "sign for the parcel first, unpack it later".
 *
 * Why this exists (measured 2026-09-05): `POST /capture` used to do all its
 * work — L0 upsert of up to 100 messages in synchronous SQLite, checkpoint,
 * scheduler notify — BEFORE answering. A long session's 50-turn batch took
 * ~29 s; the plugin client gives up at 12 s, logs "session not saved" and
 * does NOT advance its cursor, while the gateway keeps processing the
 * abandoned request. The next Stop re-sends the same batch: double work,
 * nothing acknowledged, `/health` mute for a minute. That is the mechanism
 * behind the "captured-partial" sessions.
 *
 * Contract:
 *  - `enqueue()` writes the request to `<dir>/<id>.json` (tmp + rename, so a
 *    crash never leaves a half file) and returns as soon as the file is on
 *    disk. The caller answers the client immediately with `accepted = number
 *    of messages`. Once the file exists the turns are safe: a gateway restart
 *    replays every pending file in order (`start()`).
 *  - One item at a time, FIFO by id (time-ordered), with a `setImmediate`
 *    yield between items so recall/health requests interleave.
 *  - A failing item is retried on the next drain; after `maxAttempts` it is
 *    moved to `<dir>/failed/` with the error, never silently dropped.
 *  - `status()` exposes the backlog so `/health` (and the plugin's tripwire)
 *    can say "memory is N minutes behind" instead of staying quiet.
 *
 * Pure orchestration: the actual capture work is the injected `process`.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "./types.js";

const TAG = "[capture-inbox]";
const FAILED_DIR = "failed";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 30_000;

export interface InboxItem<T> {
  id: string;
  body: T;
}

export interface CaptureInboxStatus {
  /** Files waiting to be processed (including the one in flight). */
  pending: number;
  /** Age in seconds of the oldest pending file, or null when idle. */
  oldestPendingAgeS: number | null;
  /** Items parked in failed/ after maxAttempts. */
  failed: number;
  /** True while the drain loop is running. */
  draining: boolean;
}

export interface CaptureInboxOptions<T> {
  dir: string;
  process: (item: InboxItem<T>) => Promise<unknown>;
  logger?: Logger;
  maxAttempts?: number;
  /** Delay before retrying a failed item (default 30 s; tests use ~1 ms). */
  retryDelayMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable yield between items (tests: no-op). */
  yieldToLoop?: () => Promise<void>;
}

const defaultYield = (): Promise<void> => new Promise((r) => setImmediate(r));

export class CaptureInbox<T = unknown> {
  private readonly dir: string;
  private readonly failedDir: string;
  private readonly processItem: (item: InboxItem<T>) => Promise<unknown>;
  private readonly logger?: Logger;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly yieldToLoop: () => Promise<void>;
  private readonly attempts = new Map<string, number>();
  private counter = 0;
  private draining = false;
  private drainAgain = false;
  private stopped = false;
  private started = false;
  private currentDrain: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: CaptureInboxOptions<T>) {
    this.dir = opts.dir;
    this.failedDir = join(opts.dir, FAILED_DIR);
    this.processItem = opts.process;
    this.logger = opts.logger;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.now = opts.now ?? Date.now;
    this.yieldToLoop = opts.yieldToLoop ?? defaultYield;
  }

  /** Create the directories and replay whatever a previous process left behind. */
  async start(): Promise<void> {
    await mkdir(this.failedDir, { recursive: true });
    this.started = true;
    const leftover = (await this.listPending()).length;
    if (leftover > 0) this.logger?.info(`${TAG} replaying ${leftover} pending capture(s) from a previous run`);
    this.kick();
  }

  /** Stop draining after the current item; pending files stay on disk for the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.currentDrain) await this.currentDrain.catch(() => {});
  }

  /**
   * Persist the request and return at once. Time-ordered ids keep FIFO order
   * across restarts; the counter breaks ties inside one millisecond.
   */
  async enqueue(body: T): Promise<{ id: string }> {
    // Id first (synchronously): call order == id order. Then the writes are
    // chained so file N is on disk before file N+1 — two concurrent Stops must
    // not let the later one be drained first while the earlier is still a .tmp.
    const id = this.nextId();
    const finalPath = join(this.dir, `${id}.json`);
    const tmpPath = join(this.dir, `${id}.tmp`);
    const write = async (): Promise<void> => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmpPath, JSON.stringify({ id, body }), "utf-8");
      await rename(tmpPath, finalPath);
    };
    const mine = this.writeChain.then(write, write);
    this.writeChain = mine.catch(() => {});
    await mine;
    if (this.started) this.kick();
    return { id };
  }

  async status(): Promise<CaptureInboxStatus> {
    const pending = await this.listPending();
    let oldestPendingAgeS: number | null = null;
    if (pending.length > 0) {
      const s = await stat(join(this.dir, pending[0]!)).catch(() => null);
      if (s) oldestPendingAgeS = Math.max(0, Math.floor((this.now() - s.mtimeMs) / 1000));
    }
    const failed = await readdir(this.failedDir).then((f) => f.filter((n) => n.endsWith(".json")).length).catch(() => 0);
    return { pending: pending.length, oldestPendingAgeS, failed, draining: this.draining };
  }

  /** Awaitable for tests: resolves when the current drain (if any) is done. */
  async idle(): Promise<void> {
    while (this.currentDrain) await this.currentDrain.catch(() => {});
  }

  private nextId(): string {
    this.counter = (this.counter + 1) % 1_000_000;
    return `${String(this.now()).padStart(15, "0")}-${String(this.counter).padStart(6, "0")}-${randomBytes(3).toString("hex")}`;
  }

  private async listPending(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    return names.filter((n) => n.endsWith(".json")).sort();
  }

  private kick(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    this.currentDrain = this.drain().finally(() => {
      this.draining = false;
      this.currentDrain = null;
      if (this.drainAgain && !this.stopped) {
        this.drainAgain = false;
        this.kick();
      }
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const [name] = await this.listPending();
      if (!name) return;
      const path = join(this.dir, name);
      let item: InboxItem<T>;
      try {
        item = JSON.parse(await readFile(path, "utf-8")) as InboxItem<T>;
      } catch (err) {
        await this.park(name, `unreadable inbox file: ${errMsg(err)}`);
        continue;
      }
      try {
        await this.processItem(item);
        await rm(path, { force: true });
        this.attempts.delete(name);
      } catch (err) {
        const n = (this.attempts.get(name) ?? 0) + 1;
        this.attempts.set(name, n);
        if (n >= this.maxAttempts) {
          await this.park(name, errMsg(err));
        } else {
          this.logger?.warn(
            `${TAG} ${name} failed (attempt ${n}/${this.maxAttempts}): ${errMsg(err)} — retry in ${this.retryDelayMs}ms`,
          );
          // Do not spin on the same file: leave the loop and come back later.
          // A timer (not "the next capture") guarantees the retry even on a
          // quiet night with no new Stop hooks.
          this.drainAgain = false;
          const t = setTimeout(() => this.kick(), this.retryDelayMs);
          t.unref?.();
          return;
        }
      }
      await this.yieldToLoop();
    }
  }

  private async park(name: string, error: string): Promise<void> {
    this.attempts.delete(name);
    const from = join(this.dir, name);
    const to = join(this.failedDir, name);
    await rename(from, to).catch(() => rm(from, { force: true }));
    await writeFile(`${to}.error.txt`, `${new Date(this.now()).toISOString()} ${error}\n`, "utf-8").catch(() => {});
    this.logger?.error(`${TAG} ${name} parked in failed/ after ${this.maxAttempts} attempts: ${error}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
