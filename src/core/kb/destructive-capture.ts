/**
 * Destructive-success capture — the other half of the workshop view.
 *
 * WHY THIS EXISTS (CONTRACT point 1, 2026-09-05)
 * Friction capture (friction-capture.ts) only sees FAILED tool calls. The
 * commands that hurt most succeed: `git checkout -- .`, `rm -rf`, a force push.
 * Nothing in memory witnessed them, so when Lorenzo's next prompt said "no,
 * that was wrong", there was nothing to link the correction to. The plugin now
 * flags such calls with `tool_risk: "destructive"`; this module turns one into
 * an `observation` event (NOT a `bug` — it succeeded) and hands the caller the
 * per-session "last risky signature" a later correction can be linked to.
 *
 * Rules (mirroring friction capture so the two dedupe alike):
 *  - same signature inside DEDUPE_WINDOW_MS → one episode, no second event;
 *  - NEVER a loop warning: a repeated destructive success is not a thrash;
 *  - text is secret-redacted and bounded; a per-session cap bounds the flood;
 *  - pure + synchronous; the caller keeps it off the critical path.
 */

import { redactSecrets } from "../../utils/redact-secrets.js";
import { describeInput, normalizeForSignature, DEDUPE_WINDOW_MS } from "./friction-capture.js";

/** Max characters of event text kept. */
const MAX_TEXT = 400;
/** Max characters of the command output echoed into the event. */
const MAX_OUTPUT_SNIPPET = 120;
/** Hard cap of destructive observations recorded per session (flood guard). */
export const MAX_DESTRUCTIVE_PER_SESSION = 40;
/** Pseudo entity tags stamped on the event (queryable, like usage-src:). */
export const DESTRUCTIVE_STAKES_TAG = "stakes:destructive";
export const SIGNATURE_TAG_PREFIX = "signature:";

/** The most recent risky moment of a session — what a later correction links to. */
export interface RiskySignature {
  /** Stable signature (tool + normalized input [+ error line]). */
  signature: string;
  /** Human-readable input hint (command / file), already redacted. */
  label: string;
  toolName: string;
  /** "destructive": a flagged command that SUCCEEDED; "failed": a friction failure. */
  kind: "destructive" | "failed";
  atMs: number;
  /** Id of the recorded event, when one was written. */
  eventId?: string;
}

export interface DestructiveObservation {
  sessionKey: string;
  toolName: string;
  toolInput?: unknown;
  /** First chars of the command output (present even though it did not error). */
  outputText?: string;
  atMs: number;
}

export interface DestructiveEvent {
  type: "observation";
  text: string;
  signature: string;
  label: string;
  filePath?: string;
  /** Pseudo-entity tags to store in entities_json. */
  tags: string[];
}

/** Per-session dedupe window + flood budget (owned by the caller). */
export interface DestructiveState {
  /** signature → last epoch ms seen. */
  seen: Map<string, number>;
  count: number;
}

export function createDestructiveState(): DestructiveState {
  return { seen: new Map(), count: 0 };
}

/** The signature of a destructive call: tool + normalized input (no error line). */
export function destructiveSignature(toolName: string, label: string): string {
  return `${toolName}|${normalizeForSignature(label)}|ok`;
}

/**
 * Decide what to record for a destructive call that SUCCEEDED. Returns null
 * when it must be ignored (no usable input, a repeat inside the dedupe window,
 * or the session cap). MUTATES `state` (window map always when it emits).
 */
export function buildDestructiveEvent(
  obs: DestructiveObservation,
  state: DestructiveState,
): DestructiveEvent | null {
  if (!obs?.sessionKey || !obs.toolName) return null;

  const { label: rawLabel, filePath } = describeInput(obs.toolInput);
  const label = redactSecrets(rawLabel).trim();
  if (!label) return null;

  const signature = destructiveSignature(obs.toolName, rawLabel);

  const lastMs = state.seen.get(signature);
  if (lastMs !== undefined && obs.atMs - lastMs < DEDUPE_WINDOW_MS) {
    // Same episode: refresh the window, record nothing (and never warn).
    state.seen.set(signature, obs.atMs);
    return null;
  }
  if (state.count >= MAX_DESTRUCTIVE_PER_SESSION) return null;

  state.seen.set(signature, obs.atMs);
  state.count += 1;

  const snippet = redactSecrets((obs.outputText ?? "").trim())
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[0]
    ?.slice(0, MAX_OUTPUT_SNIPPET);

  const text = (
    `destructive command succeeded: ${obs.toolName} \`${label}\` — ${signature}` +
    (snippet ? ` | output: ${snippet}` : "")
  ).slice(0, MAX_TEXT);

  return {
    type: "observation",
    text,
    signature,
    label,
    filePath,
    tags: [DESTRUCTIVE_STAKES_TAG, `${SIGNATURE_TAG_PREFIX}${signature}`],
  };
}
