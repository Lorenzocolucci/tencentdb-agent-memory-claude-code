/**
 * recap-builder — pure assembly of the "Dove eravamo" recap text.
 *
 * Every emitted line is anchored: thread items without provenance are dropped
 * (determinism over completeness). Returns "" when nothing anchorable remains.
 * Immutable: builds a new string, never mutates the input.
 */
import type { RecapInput, ThreadItem } from "./recap-types.js";

const MAX_THREAD = 6;
const MAX_TEXT = 240;

function anchorOf(item: ThreadItem): string | null {
  const ids = item.sourceMessageIds.filter((s) => typeof s === "string" && s.length > 0);
  return ids.length > 0 ? ids.join(",") : null;
}

function line(item: ThreadItem): string | null {
  const anchor = anchorOf(item);
  if (!anchor) return null;
  const text = item.text.trim().slice(0, MAX_TEXT);
  if (!text) return null;
  return `- (${item.type}) ${text}   [anchor: msg ${anchor}]`;
}

export function buildRecapText(input: RecapInput): string {
  const threadLines = input.thread
    .map(line)
    .filter((l): l is string => l !== null)
    .slice(-MAX_THREAD);

  const nextStepLine = input.nextStep ? line(input.nextStep) : null;

  if (!nextStepLine && threadLines.length === 0) return "";

  const date = input.sessionDateIso.slice(0, 10);
  const out: string[] = [`DOVE ERAVAMO — ${input.project} (${date})`, ""];

  if (nextStepLine) {
    out.push("PROSSIMO PASSO:");
    // Reuse the anchored formatting but with the friendlier label.
    out.push(nextStepLine.replace(/^- \([^)]*\) /, "- Prossimo passo: "));
    out.push("");
  }

  if (threadLines.length > 0) {
    out.push("FILO (ricostruito dalle nostre parole reali):");
    out.push(...threadLines);
  }

  return out.join("\n").trimEnd();
}
