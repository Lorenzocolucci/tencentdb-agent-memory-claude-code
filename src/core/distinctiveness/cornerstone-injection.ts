/**
 * cornerstone-injection — formats the cornerstone block for session-start injection.
 *
 * Builds a `<cornerstone-memories>` XML block from the selected cornerstone memories.
 * This block is injected ALONGSIDE the existing heat-ranked scenes (not replacing them).
 *
 * Security: content is XML-escaped to prevent injection attacks (a stored memory
 * containing closing tags cannot break out of the section boundary).
 *
 * Immutable: pure function, returns a new string.
 */

// We intentionally do NOT use escapeXmlTags from sanitize.ts here because it
// only escapes a fixed allow-list of known boundary tags and `cornerstone-memories`
// is not in that list (adding it would require modifying sanitize.ts, which is
// out of scope). Instead we apply a targeted escape for the cornerstone boundary
// tag inside content only — wrapping tags are constructed from literal strings.
function escapeCornerstone(text: string): string {
  return text.replace(/<\/?cornerstone-memories>/gi, (m) =>
    m.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
}

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
    const safe = escapeCornerstone(trimmed);
    lines.push(`- ${safe}`);
  }

  lines.push(`</${CORNERSTONE_TAG}>`);
  return lines.join("\n");
}
