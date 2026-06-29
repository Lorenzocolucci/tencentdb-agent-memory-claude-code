/**
 * recap-capture — session-end glue that turns a finished session into a
 * first-class `session_recap` KbEvent. Reads the session's own events, selects
 * the anchored thread, builds the recap text, and inserts it.
 *
 * Off the critical path: every failure is swallowed (memory must never break
 * the conversation). No-ops when the store lacks the required capabilities.
 */
import type { IMemoryStore } from "../store/types.js";
import { selectThread } from "./recap-selector.js";
import { buildRecapText } from "./recap-builder.js";

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

    const input = selectThread(events, now);
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
