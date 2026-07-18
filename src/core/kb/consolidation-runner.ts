/**
 * Consolidation runner (Phase A / L4 v1) — the deterministic "sleep-time" pass.
 *
 * Runs after a session (fire-and-forget, wired separately to the session-end
 * hook). Three deterministic steps, NO LLM:
 *   1. REINFORCE everything the session touched — the events of this session and
 *      the facts derived from them. Repetition is what builds permanence
 *      (research: consolidation priority tracks cumulative replay).
 *   2. DECAY the stale — active memories not reinforced for a while fade down the
 *      tiers (forget the noise at the right time).
 *   3. CONTRADICTION CHECK — flag (never delete) active facts about the same
 *      entity+attribute that disagree on value (contradiction-detector.ts).
 *
 * The failure -> lesson clustering (Phase B, LLM-driven distillation sentence
 * over deterministic clusters) runs as a SEPARATE background task
 * (lessons-runner.ts, scheduled from tdai-core.ts) — this module stays
 * deterministic, synchronous, and unit-testable on its own.
 */

import type { DatabaseSync } from "node:sqlite";
import { reinforce } from "./lifecycle-writer.js";
import { applyStaleness } from "./lifecycle-decay.js";
import { detectContradictions } from "./contradiction-detector.js";

/** Default staleness horizon: 14 days. */
export const DEFAULT_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export interface RunConsolidationParams {
  sessionKey: string;
  now: string;
  staleAfterMs?: number;
  namespace?: string;
}

export interface ConsolidationStats {
  eventsReinforced: number;
  factsReinforced: number;
  staled: number;
  /** Facts newly flagged (or re-flagged with a changed conflict set) this pass. */
  contradictionsFlagged: number;
  /** Facts whose contradiction flag was cleared because the conflict resolved. */
  contradictionsCleared: number;
}

/** Run one deterministic consolidation pass for a finished session. */
export function runConsolidation(db: DatabaseSync, params: RunConsolidationParams): ConsolidationStats {
  const { sessionKey, now } = params;
  const namespace = params.namespace;
  const staleAfterMs = params.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  // ── 1a. Reinforce the session's events ──
  const eventRows = db
    .prepare("SELECT id FROM events WHERE session_key = ?")
    .all(sessionKey) as Array<{ id: string }>;
  for (const e of eventRows) {
    reinforce(db, { ownerId: e.id, ownerKind: "event", now, namespace });
  }

  // ── 1b. Reinforce the facts derived from those events ──
  let factsReinforced = 0;
  if (eventRows.length > 0) {
    const placeholders = eventRows.map(() => "?").join(",");
    const factRows = db
      .prepare(`SELECT DISTINCT id FROM facts WHERE source_event_id IN (${placeholders})`)
      .all(...eventRows.map((e) => e.id)) as Array<{ id: string }>;
    for (const f of factRows) {
      reinforce(db, { ownerId: f.id, ownerKind: "fact", now, namespace });
      factsReinforced += 1;
    }
  }

  // ── 2. Decay the stale ──
  const staled = applyStaleness(db, { now, staleAfterMs, namespace });

  // ── 3. Contradiction check (flag only, never delete) ──
  const contradictions = detectContradictions(db, { now, namespace });

  return {
    eventsReinforced: eventRows.length,
    factsReinforced,
    staled,
    contradictionsFlagged: contradictions.factsFlagged,
    contradictionsCleared: contradictions.factsCleared,
  };
}
