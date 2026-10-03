/**
 * grounded-trust-ask.ts — the ask-loop renderer (Phase 3).
 *
 * When an uncertain, high-stakes memory resurfaces (gate_state =
 * pending_confirmation), the pillar must NOT obey it blindly nor silently drop
 * it — it must ASK Lorenzo, like the burned child asking "papà, il fuoco brucia
 * vero?". Lorenzo chose the INTERRUPT model (2026-06-30): the question is a block
 * the agent MUST raise before acting on that memory, not a soft note it may skip.
 * The conservative-high stakes gate keeps these rare, so the interrupt is a
 * protector, not a nag.
 *
 * Pure & total: renders a string from data, no side effects, never throws.
 * The agent re-binds Lorenzo's answer with the owner id carried in each line:
 * on OpenClaw via the tdai_confirm_memory / tdai_reject_memory tools, on Claude
 * Code via the plugin skills `/memory-confirm <owner_id>` /
 * `/memory-reject <owner_id>` (which POST /memory/confirm | /memory/reject).
 */

import { escapeXmlTags } from "../../utils/sanitize.js";
import type { ProvenanceOrigin, StakesDomain } from "./provenance.js";

export interface PendingAsk {
  owner_id: string;
  owner_kind: "fact" | "event";
  /** Display text of the memory (event text, or fact "attribute: value"). */
  text: string;
  origin: ProvenanceOrigin;
  stakes_domain: StakesDomain | null;
}

const BLOCK_OPEN = '<grounded-trust-interrupt priority="block-before-acting">';
const BLOCK_CLOSE = "</grounded-trust-interrupt>";

const REDACTED = "[dato sensibile omesso]";

/**
 * Payment / identity values never appear in the question: the agent needs to know THAT
 * a payment fact is unconfirmed, not to be handed the IBAN again every turn. Removes
 * IBANs, card numbers, Italian fiscal codes and (for payment/credential domains) any
 * long digit run or digit-bearing token. Pure.
 */
export function redactSensitiveValues(text: string, domain?: StakesDomain | null): string {
  let out = text
    .replace(/\b[A-Za-z]{2}\d{2}(?:\s?[A-Za-z0-9]{4}){3,7}(?:\s?[A-Za-z0-9]{1,3})?\b/g, REDACTED) // IBAN
    .replace(/\b(?:\d[ -]?){13,19}\b/g, REDACTED) // card / long account numbers
    .replace(/\b[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z]\d{3}[A-Za-z]\b/g, REDACTED); // codice fiscale
  if (domain === "payment" || domain === "credential") {
    out = out
      .replace(/\b\d[\d.,/ -]{5,}\d\b/g, REDACTED)
      .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{9,}\b/g, REDACTED);
  }
  return out;
}

/**
 * Remembers which asks were already put to the user in a session, so the same
 * question is raised ONCE per session instead of on every turn. In-memory, bounded.
 */
export class AskedTracker {
  private readonly sessions = new Map<string, Set<string>>();

  constructor(private readonly maxSessions = 200) {}

  /** The asks not yet raised in this session (all of them when the session is unknown). */
  fresh<T extends { owner_id: string }>(sessionId: string | undefined, asks: readonly T[]): T[] {
    if (!sessionId) return [...asks];
    const seen = this.sessions.get(sessionId);
    return asks.filter((a) => !seen?.has(a.owner_id));
  }

  /** Record that these asks were raised in this session. */
  mark(sessionId: string | undefined, asks: ReadonlyArray<{ owner_id: string }>): void {
    if (!sessionId || asks.length === 0) return;
    const seen = this.sessions.get(sessionId) ?? new Set<string>();
    for (const a of asks) seen.add(a.owner_id);
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, seen);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}

/** The slice of the store the ask block needs (structural, so tests can fake it). */
export interface AskStore {
  getPendingAsks?: (limit?: number, opts?: { project?: string }) => PendingAsk[];
}

/**
 * Build the grounded-trust interrupt block for ONE turn: pending asks of the CURRENT
 * project only (a payment memory of another project is not this session's business),
 * each raised once per session, sensitive values redacted. "" when there is nothing
 * (new) to ask. Marks what it returns as raised.
 */
export function buildGroundedTrustBlock(
  store: AskStore,
  opts: { project?: string; sessionId?: string; tracker?: AskedTracker; limit?: number },
): string {
  if (typeof store.getPendingAsks !== "function") return "";
  const all = store.getPendingAsks(opts.limit ?? 5, { project: opts.project });
  const asks = opts.tracker ? opts.tracker.fresh(opts.sessionId, all) : all;
  if (asks.length === 0) return "";
  opts.tracker?.mark(opts.sessionId, asks);
  return renderGroundedTrustInterrupt(asks);
}

/** Human-readable origin hint for the question (why this is uncertain). */
function originHint(origin: ProvenanceOrigin): string {
  switch (origin) {
    case "conversation":
      return "appreso da una conversazione, mai confermato";
    case "tool_output":
      return "da output di tool, mai confermato";
    default:
      return "origine incerta, mai confermato";
  }
}

/**
 * Render the interrupt block for a set of pending memories. Returns "" when there
 * is nothing to ask (so the caller injects nothing). Each line carries the exact
 * confirm/reject tool calls the agent must use to re-bind Lorenzo's answer.
 */
export function renderGroundedTrustInterrupt(asks: readonly PendingAsk[]): string {
  if (!asks || asks.length === 0) return "";

  const lines = asks.map((a, i) => {
    const n = i + 1;
    const domain = a.stakes_domain ?? "high";
    const text = escapeXmlTags(redactSensitiveValues(a.text, a.stakes_domain));
    return (
      `${n}. [${domain}] «${text}» — ${originHint(a.origin)}.\n` +
      `   → se Lorenzo CONFERMA: in Claude Code esegui la skill /memory-confirm ${a.owner_id}` +
      ` — su OpenClaw: tdai_confirm_memory(owner_kind:"${a.owner_kind}", owner_id:"${a.owner_id}")\n` +
      `   → se Lorenzo NEGA:     in Claude Code esegui la skill /memory-reject ${a.owner_id}` +
      ` — su OpenClaw: tdai_reject_memory(owner_kind:"${a.owner_kind}", owner_id:"${a.owner_id}")`
    );
  });

  return (
    `${BLOCK_OPEN}\n` +
    `⚠️ FERMATI prima di agire su ${asks.length === 1 ? "questo ricordo" : "questi ricordi"}: ` +
    `${asks.length === 1 ? "è" : "sono"} ad alto rischio e NON confermato da Lorenzo.\n` +
    `NON agire sul loro contenuto finché Lorenzo non risponde. Porta la domanda a Lorenzo ORA, ` +
    `poi registra l'esito con la skill o il tool indicato (così la volta dopo non te lo richiede):\n` +
    `${lines.join("\n")}\n` +
    `${BLOCK_CLOSE}`
  );
}
