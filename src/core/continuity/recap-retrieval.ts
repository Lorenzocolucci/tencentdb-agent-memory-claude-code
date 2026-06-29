/**
 * recap-retrieval — fetch the latest session_recap for a project and format it
 * for injection. Off the critical path: returns "" on any failure.
 */
import type { IMemoryStore } from "../store/types.js";
import { buildSessionRecapBlock } from "./recap-injection.js";

const RECAP_TYPE = "session_recap";

interface Logger {
  debug?: (m: string) => void;
  warn?: (m: string) => void;
}

export function latestRecapBlock(params: {
  store: IMemoryStore;
  sessionKey: string;
  logger?: Logger;
}): string {
  const { store, sessionKey, logger } = params;
  try {
    if (!sessionKey) return "";
    if (typeof store.latestEventBySessionKeyType !== "function") return "";
    const recap = store.latestEventBySessionKeyType(sessionKey, RECAP_TYPE);
    if (!recap) return "";
    return buildSessionRecapBlock(recap.text);
  } catch (err) {
    logger?.warn?.(
      `[memory-tdai] [continuity] recap retrieval failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return "";
  }
}
