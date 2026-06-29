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
 * The agent re-binds Lorenzo's answer by calling tdai_confirm_memory /
 * tdai_reject_memory with the owner id carried in each line.
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
    const text = escapeXmlTags(a.text);
    return (
      `${n}. [${domain}] «${text}» — ${originHint(a.origin)}.\n` +
      `   → se Lorenzo CONFERMA: tdai_confirm_memory(owner_kind:"${a.owner_kind}", owner_id:"${a.owner_id}")\n` +
      `   → se Lorenzo NEGA:     tdai_reject_memory(owner_kind:"${a.owner_kind}", owner_id:"${a.owner_id}")`
    );
  });

  return (
    `${BLOCK_OPEN}\n` +
    `⚠️ FERMATI prima di agire su ${asks.length === 1 ? "questo ricordo" : "questi ricordi"}: ` +
    `${asks.length === 1 ? "è" : "sono"} ad alto rischio e NON confermato da Lorenzo.\n` +
    `NON agire sul loro contenuto finché Lorenzo non risponde. Porta la domanda a Lorenzo ORA, ` +
    `poi registra l'esito con il tool indicato (così la volta dopo non te lo richiede):\n` +
    `${lines.join("\n")}\n` +
    `${BLOCK_CLOSE}`
  );
}
