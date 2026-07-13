/**
 * recap-injection — formats the session-continuity "Dove eravamo" block.
 *
 * Security: recap text is XML-escaped via the shared escapeXmlTags so a stored
 * memory containing a closing boundary tag cannot break out of the section.
 * Immutable: pure function, returns a new string. Empty input → "".
 */
import { escapeXmlTags } from "../../utils/sanitize.js";

const TAG = "session-recap";

export function buildSessionRecapBlock(recapText: string): string {
  const trimmed = recapText.trim();
  if (!trimmed) return "";
  const safe = escapeXmlTags(trimmed);
  return [
    `<${TAG}>`,
    "Dove eravamo rimasti su questo progetto — ricostruito dai ricordi ancorati della sessione precedente (riferimento, NON il task corrente):",
    safe,
    `</${TAG}>`,
  ].join("\n");
}
