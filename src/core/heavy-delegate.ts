/**
 * HeavyWorkDelegate — the seam between the HTTP gateway process and the worker.
 *
 * Phase 5 (2026-10-03): the gateway's single event loop must never run heavy
 * work. A `TdaiCore` created with `role: "gateway"` keeps recall / search /
 * observe local and hands everything heavy to this delegate; the real
 * implementation (`WorkerSupervisor`) forwards each call to the worker process,
 * which runs a `role: "worker"` TdaiCore on its own event loop.
 *
 * Every method may reject with `WorkerUnavailableError` when the worker is down
 * (restarting); callers decide whether that is a 503 or a skipped best-effort job.
 */
import type { KbDelta } from "./kb/extraction-schema.js";
import type { ApplyKbDeltaResult } from "./kb/kb-writer.js";

export class WorkerUnavailableError extends Error {
  constructor(message = "memory worker is not available (restarting)") {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

export interface ApplyDeltaOptions {
  namespace?: string;
  project?: string;
  sessionKey?: string;
  sessionId?: string;
}

export interface HeavyWorkDelegate {
  /** Cornerstone block for a session key (worker caches it corpus-wide, with a cooldown). */
  buildCornerstone(key: string): Promise<string>;
  /** Kick the lessons / principles / usage distillation (worker applies its own cooldown). */
  scheduleDistillation(): void;
  /** Flush a session: extraction flush, consolidation, recap, credit. Resolves when flushed. */
  sessionEnd(sessionKey: string): Promise<void>;
  /** Digest one backlog session through the live extraction path. */
  digest(sessionKey: string): Promise<{ processedCount: number }>;
  /** Deterministic KB write (POST /kb/write). */
  applyDelta(delta: KbDelta, opts: ApplyDeltaOptions): Promise<ApplyKbDeltaResult>;
  /** Grounded Trust confirm / reject. */
  resolveGated(params: {
    ownerId: string;
    ownerKind: "fact" | "event";
    decision: "confirm" | "reject";
  }): Promise<{ ok: boolean; text: string }>;
}

/** Process role of a TdaiCore. `full` = everything in one process (tests, CLIs, TDAI_WORKER=inline). */
export type CoreRole = "full" | "gateway" | "worker";
