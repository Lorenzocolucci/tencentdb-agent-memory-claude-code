/**
 * cornerstone-injection — formats the cornerstone block for session-start injection.
 *
 * Builds a `<cornerstone-memories>` XML block from the selected cornerstone memories.
 * This block is injected ALONGSIDE the existing heat-ranked scenes (not replacing them).
 *
 * Security: content is XML-escaped via the shared escapeXmlTags utility to prevent
 * injection attacks — a stored memory containing any known boundary closing tag
 * (including `</cornerstone-memories>`) cannot break out of its section.
 *
 * Immutable: pure function, returns a new string.
 */

import { escapeXmlTags } from "../../utils/sanitize.js";

const CORNERSTONE_TAG = "cornerstone-memories";
const MAX_CONTENT_CHARS = 300;

/** A single cornerstone ready to be injected. */
export interface InjectionCornerstone {
  readonly id: string;
  readonly content: string;
  /** Distinctiveness score in [0,1] — shown as a confidence hint. */
  readonly score: number;
}

/**
 * Build the session-start cornerstone injection block.
 *
 * Returns an empty string when the input is empty (caller skips injection
 * gracefully rather than emitting an empty tag).
 *
 * Each memory is rendered as a bullet with a trimmed content excerpt.
 * The entire block is wrapped in `<cornerstone-memories>` with an instruction
 * header so the model understands what these are.
 */
export function buildCornerstoneBlock(cornerstones: ReadonlyArray<InjectionCornerstone>): string {
  if (cornerstones.length === 0) return "";

  const lines: string[] = [
    `<${CORNERSTONE_TAG}>`,
    "Distinctive peak memories — rare, isolated events that human memory resurfaces " +
    "unbidden (von Restorff effect). Reference for context; these are NOT current tasks:",
  ];

  for (const cs of cornerstones) {
    // Truncate and sanitize content before embedding.
    const trimmed = cs.content.trim().slice(0, MAX_CONTENT_CHARS);
    const safe = escapeXmlTags(trimmed);
    lines.push(`- ${safe}`);
  }

  lines.push(`</${CORNERSTONE_TAG}>`);
  return lines.join("\n");
}
