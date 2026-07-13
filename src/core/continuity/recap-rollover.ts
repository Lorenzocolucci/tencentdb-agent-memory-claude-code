/**
 * recap-rollover — "changing of the guard" capture.
 *
 * The desktop app never fires a reliable session-end for how Lorenzo works
 * (a new chat = the previous session ends, no /clear, no /compact). The one
 * event guaranteed on every new chat is the FIRST recall turn. At that instant
 * the events of the session that JUST ended are already in the store, while the
 * new session has not produced thread events yet. So we capture the PREVIOUS
 * session's `session_recap` here, and the injection right after surfaces it.
 *
 * Local + fast (no LLM, no embeddings): safe to run inline on the recall path.
 * Idempotent: the recap carries the described session_id, and we skip when one
 * already exists. Off the critical path: every failure is swallowed.
 */
import type { IMemoryStore, KbEvent } from "../store/types.js";
import { selectThread } from "./recap-selector.js";
import { buildRecapText } from "./recap-builder.js";

const TAG = "[memory-tdai] [continuity]";
const RECAP_TYPE = "session_recap";

interface Logger {
  debug?: (m: string) => void;
  warn?: (m: string) => void;
}

/**
 * The session_id of the most recent NON-recap event whose session differs from
 * the one just opened — i.e. the session that just ended. `undefined` when there
 * is no such prior session.
 */
function previousSessionId(events: readonly KbEvent[], currentSessionId?: string): string | undefined {
  let bestId: string | undefined;
  let bestTs = "";
  for (const e of events) {
    if (e.type === RECAP_TYPE) continue; // recaps are our own output, not a session
    const sid = e.session_id;
    if (!sid || sid === currentSessionId) continue;
    if (e.ts > bestTs) { bestTs = e.ts; bestId = sid; }
  }
  return bestId;
}

export function captureRolloverRecap(params: {
  store: IMemoryStore;
  sessionKey: string;
  currentSessionId?: string;
  now: string;
  logger?: Logger;
}): void {
  const { store, sessionKey, currentSessionId, now, logger } = params;
  try {
    if (!sessionKey) return;
    if (typeof store.listEventsBySession !== "function" || typeof store.insertEvent !== "function") {
      logger?.debug?.(`${TAG} store lacks rollover capabilities — skipping`);
      return;
    }

    const events = store.listEventsBySession(sessionKey);
    if (events.length === 0) return;

    const prevId = previousSessionId(events, currentSessionId);
    if (!prevId) return; // no prior session to snapshot

    const scoped = events.filter((e) => e.session_id === prevId && e.type !== RECAP_TYPE);
    if (scoped.length === 0) return; // nothing to describe

    // Idempotent, BUT refresh when the session accumulated events AFTER its last
    // recap. A plain "recap exists → skip" freezes a session whose recap was
    // captured early (e.g. a mid-session rollover), losing later work. Re-capture
    // only when there is something newer to describe.
    let latestEventTs = "";
    for (const e of scoped) if (e.ts > latestEventTs) latestEventTs = e.ts;
    let latestRecapTs = "";
    for (const e of events) {
      if (e.type === RECAP_TYPE && e.session_id === prevId && e.ts > latestRecapTs) latestRecapTs = e.ts;
    }
    if (latestRecapTs && latestRecapTs >= latestEventTs) {
      logger?.debug?.(`${TAG} rollover recap up-to-date for session=${prevId} — skipping`);
      return;
    }

    const input = selectThread(scoped, now);
    const text = buildRecapText(input);
    if (!text) {
      logger?.debug?.(`${TAG} no anchored thread for prior session=${prevId} — no recap`);
      return;
    }

    const provenance = new Set<string>();
    for (const item of input.thread) for (const id of item.sourceMessageIds) provenance.add(id);
    if (input.nextStep) for (const id of input.nextStep.sourceMessageIds) provenance.add(id);

    store.insertEvent({
      ts: now,
      sessionKey,
      sessionId: prevId, // idempotency key: the session this recap describes
      project: input.project,
      type: RECAP_TYPE,
      text,
      sourceMessageIds: [...provenance],
    });
    logger?.debug?.(`${TAG} rollover session_recap captured for prior session=${prevId}`);
  } catch (err) {
    logger?.warn?.(`${TAG} rollover capture failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
