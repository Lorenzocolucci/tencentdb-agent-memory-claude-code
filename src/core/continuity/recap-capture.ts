/**
 * recap-capture — session-end glue that turns a finished session into a
 * first-class `session_recap` KbEvent. Reads the session's own events, selects
 * the anchored thread, builds the recap text, and inserts it.
 *
 * Off the critical path: every failure is swallowed (memory must never break
 * the conversation). No-ops when the store lacks the required capabilities.
 */
import type { IMemoryStore, KbEvent } from "../store/types.js";
import { selectThread } from "./recap-selector.js";
import { buildRecapText } from "./recap-builder.js";

/**
 * Narrow a session_key's events to the single most recent session_id (the
 * session that just ended). Falls back to all events when session_id is absent.
 */
function scopeToLatestSession(events: readonly KbEvent[]): readonly KbEvent[] {
  let latest: KbEvent | undefined;
  for (const e of events) if (!latest || e.ts > latest.ts) latest = e;
  const sid = latest?.session_id;
  if (!sid) return events;
  const scoped = events.filter((e) => e.session_id === sid);
  return scoped.length > 0 ? scoped : events;
}

const TAG = "[memory-tdai] [continuity]";
const RECAP_TYPE = "session_recap";

interface Logger {
  debug?: (m: string) => void;
  warn?: (m: string) => void;
}

export function captureSessionRecap(params: {
  store: IMemoryStore;
  sessionKey: string;
  now: string;
  logger?: Logger;
}): void {
  const { store, sessionKey, now, logger } = params;
  try {
    if (!sessionKey) return;
    if (typeof store.listEventsBySession !== "function" || typeof store.insertEvent !== "function") {
      logger?.debug?.(`${TAG} store lacks recap capabilities — skipping capture`);
      return;
    }

    const events = store.listEventsBySession(sessionKey);
    if (events.length === 0) return;

    // session_key is stable per project and aggregates MANY sessions (a month
    // of work). "Dove eravamo" must describe the session that JUST ended, so
    // scope to the most recent session_id (the ending session) before building.
    const sessionEvents = scopeToLatestSession(events);

    const input = selectThread(sessionEvents, now);
    const text = buildRecapText(input);
    if (!text) {
      logger?.debug?.(`${TAG} no anchored thread for session=${sessionKey} — no recap`);
      return;
    }

    const provenance = new Set<string>();
    for (const item of input.thread) for (const id of item.sourceMessageIds) provenance.add(id);
    if (input.nextStep) for (const id of input.nextStep.sourceMessageIds) provenance.add(id);

    store.insertEvent({
      ts: now,
      sessionKey,
      project: input.project,
      type: RECAP_TYPE,
      text,
      sourceMessageIds: [...provenance],
    });
    logger?.debug?.(`${TAG} session_recap captured for project=${input.project} session=${sessionKey}`);
  } catch (err) {
    logger?.warn?.(`${TAG} recap capture failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
