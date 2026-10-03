/**
 * pretool-service.ts — the gateway-facing wrapper of the PreToolUse matcher.
 *
 * Adds what the pure matcher must not do: log every warning/deny with its lesson
 * id, and count the exposure on the lesson (`exposure_count` +1, and
 * `stance_fire_count` +1 on a deny) — batched OFF the request path so a slow
 * write can never delay the tool call the hook is gating.
 */

import { PretoolMatcher, type PretoolItem, type PretoolRequest } from "./pretool-match.js";
import { createPretoolSource, getStoreDb } from "./pretool-queries.js";
import type { PretoolSource } from "./pretool-queries.js";

const TAG = "[memory-tdai][pretool]";
/** Counter writes are flushed this long after the first pending one. */
export const COUNTER_FLUSH_MS = 1_000;

interface Counters {
  recordLessonExposure?(lessonId: string, sessionId: string, now: string): void;
  recordStanceFire?(lessonId: string, now: string): void;
}

interface PendingCounter {
  lessonId: string;
  sessionKey: string;
  deny: boolean;
}

export interface PretoolServiceDeps {
  logger: { info(msg: string): void; warn(msg: string): void };
  /** Where lessons/events are read from. */
  source: PretoolSource;
  /** Where exposure counters are written (the IMemoryStore). */
  counters?: Counters;
  now?: () => number;
}

export class PretoolService {
  private readonly matcher: PretoolMatcher;
  private pending: PendingCounter[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: PretoolServiceDeps) {
    this.matcher = new PretoolMatcher(deps.source, { now: deps.now, logger: deps.logger });
  }

  /** Build from the live store; undefined when the store has no SQLite handle. */
  static fromStore(store: unknown, logger: PretoolServiceDeps["logger"]): PretoolService | undefined {
    const db = getStoreDb(store);
    if (!db) return undefined;
    return new PretoolService({ logger, source: createPretoolSource(db), counters: store as Counters });
  }

  /** Background warm-up (index build). Never throws. */
  async warm(): Promise<void> {
    await this.matcher.warm();
  }

  /** In-memory lookup + logging + deferred counters. Never throws, never touches the DB inline. */
  check(req: PretoolRequest): PretoolItem | null {
    let item: PretoolItem | null = null;
    try {
      item = this.matcher.match(req);
    } catch (err) {
      this.deps.logger.warn(`${TAG} match failed (fail open): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (item) this.noteHit(req, item);
    return item;
  }

  private noteHit(req: PretoolRequest, item: PretoolItem): void {
    this.deps.logger.info(
      `${TAG} ${item.severity} phase=${req.phase} project=${req.project} tool=${req.toolName} ` +
        `kind=${item.kind} lesson=${item.lessonId ?? "-"} event=${item.eventId ?? "-"}`,
    );
    if (!item.lessonId) return;
    this.pending.push({ lessonId: item.lessonId, sessionKey: req.sessionKey, deny: item.severity === "deny" });
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), COUNTER_FLUSH_MS);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  /** Write pending counters now (also called by the timer and by tests). */
  flush(): void {
    this.flushTimer = null;
    const batch = this.pending;
    this.pending = [];
    const c = this.deps.counters;
    if (!c || batch.length === 0) return;
    const now = new Date((this.deps.now ?? Date.now)()).toISOString();
    for (const p of batch) {
      try {
        c.recordLessonExposure?.(p.lessonId, p.sessionKey, now);
        if (p.deny) c.recordStanceFire?.(p.lessonId, now);
      } catch (err) {
        this.deps.logger.warn(`${TAG} counter write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
