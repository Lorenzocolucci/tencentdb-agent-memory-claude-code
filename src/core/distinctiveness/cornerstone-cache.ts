/**
 * Session-scoped cache for the cornerstone injection block (Idea 5).
 *
 * WHY: buildCornerstones() embeds the whole event corpus (one batched embed call
 * + N vector searches) to score distinctiveness. Running it on EVERY turn would
 * add that cost to the recall critical path each message. The cornerstone set is
 * stable within a session, so we compute it ONCE per session and reuse the
 * rendered block string for the rest of the session — exactly the "compute at
 * session open, reuse for the session" pattern Lorenzo asked for (the same shape
 * as the session-open banner / recap).
 *
 * Deferred commit (mirrors SessionBannerTracker): the caller commits the computed
 * block ONLY after a real (non-timed-out) recall result actually carried it, so a
 * slow first turn that loses the recall timeout race retries next turn instead of
 * caching a half-built/empty block forever.
 *
 * In-memory + process-lifetime on purpose: the gateway is a long-lived single-user
 * process; a session computed once should not recompute even across /session/end.
 * Growth is O(distinct session keys per process) — acceptable here; revisit with an
 * LRU only under high churn.
 */
export class CornerstoneSessionCache {
  private readonly blocks = new Map<string, string>();

  /** True while this session has NOT yet computed its cornerstone block. */
  pending(key: string): boolean {
    return !this.blocks.has(key);
  }

  /**
   * The cached block for this session, or undefined if not computed yet.
   * A cached value of "" means "computed, but there was nothing to inject" — it
   * is still a HIT (we must not recompute), distinct from undefined (MISS).
   */
  get(key: string): string | undefined {
    return this.blocks.get(key);
  }

  /** Commit the computed block for this session (called after a real result). */
  commit(key: string, block: string): void {
    this.blocks.set(key, block);
  }
}
