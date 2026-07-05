/**
 * Session-open banner — proves to the model that memory is loaded on the
 * FIRST turn of every new session.
 *
 * Two exports:
 *   buildSessionBanner  — pure function, returns the XML instruction block.
 *   SessionBannerTracker — tracks which sessionKeys have already fired.
 */

import { escapeXmlTags } from "../../utils/sanitize.js";

const BANNER_TAG = "session-open-banner";
const MAX_RECENT_EVENT_CHARS = 120;

// ============================
// Banner builder (pure)
// ============================

export interface SessionBannerInput {
  projectName?: string;
  personaLoaded: boolean;
  sceneCount: number;
  recentEventText?: string;
  /**
   * Immune-system warning. When set (extraction stalled for an active project),
   * it is shown FIRST and LOUD so the failure is never silent — Lorenzo sees
   * "memory is sick" at session open instead of discovering it days later.
   */
  healthWarning?: string;
}

/**
 * Build the instruction block injected on the first turn of a session.
 *
 * The block tells the model to open its very first reply with a one-line
 * "sul pezzo" banner proving that memory is loaded.  Dynamic values are
 * XML-escaped before embedding so stored memory content cannot break out
 * of the tag boundary.
 *
 * Graceful omission rules (no dangling separators):
 *   - projectName missing  → drop "· <project>"
 *   - !personaLoaded       → drop "· persona ✓"
 *   - sceneCount <= 0      → drop "· <N> scene"
 *   - no recentEventText   → drop "· ultimo: …"
 */
export function buildSessionBanner(input: SessionBannerInput): string {
  const { projectName, personaLoaded, sceneCount, recentEventText, healthWarning } = input;

  const segments: string[] = [];
  // LOUD, first: the immune-system warning. If memory is sick, Lorenzo must see
  // it at the top of the banner, not discover it days later by a manual audit.
  if (healthWarning) segments.push(`⚠️ ${escapeXmlTags(healthWarning).slice(0, 90)}`);
  segments.push("Sul pezzo");

  if (projectName) {
    const safeProject = escapeXmlTags(projectName).slice(0, 80);
    segments.push(safeProject);
  }

  segments.push("ricordo chi sei");

  if (recentEventText) {
    const safeEvent = escapeXmlTags(recentEventText).slice(0, MAX_RECENT_EVENT_CHARS);
    segments.push(`ultimo: ${safeEvent}`);
  }

  const memParts: string[] = [];
  if (personaLoaded) memParts.push("persona ✓");
  if (sceneCount > 0) memParts.push(`${sceneCount} scene`);
  if (memParts.length > 0) {
    segments.push(`memoria: ${memParts.join(" · ")}`);
  }

  const bannerLine = `🧠 ${segments.join(" · ")}`;

  return (
    `<${BANNER_TAG}>\n` +
    `FIRST TURN OF THIS SESSION — begin your very first reply with this exact one-line banner, then answer normally:\n` +
    `${bannerLine}\n` +
    `</${BANNER_TAG}>`
  );
}

// ============================
// Tracker (in-process, long-lived)
// ============================

/**
 * Tracks which sessionKeys have already emitted a banner.
 *
 * Returns TRUE the first time a given sessionKey is seen, FALSE afterwards.
 * Distinct sessionKeys are independent (each gets exactly one TRUE).
 *
 * In-memory is intentional: the gateway process is long-lived and a session
 * seen once should not re-emit the banner even after /session/end clears
 * other per-session state (the banner fires once per process-lifetime
 * session, not once per session-end cycle).
 */
export class SessionBannerTracker {
  private readonly seen = new Set<string>();

  /**
   * Peek (NO mutation): TRUE while this sessionKey has not yet emitted the
   * banner. The slot is consumed ONLY by markEmitted(), called by the caller
   * AFTER the banner is committed to a returned (non-timed-out) recall result.
   * Splitting peek from commit prevents losing the banner when recall loses its
   * timeout race: the inner promise must not burn the slot for a result that is
   * then discarded — the next turn retries instead.
   *
   * Note: growth is O(distinct sessionKeys per process). Acceptable for a
   * long-lived single-user gateway; revisit with an LRU only under high churn.
   */
  pending(sessionKey: string): boolean {
    return !this.seen.has(sessionKey);
  }

  /** Commit: mark this sessionKey as having emitted the banner. */
  markEmitted(sessionKey: string): void {
    this.seen.add(sessionKey);
  }
}
