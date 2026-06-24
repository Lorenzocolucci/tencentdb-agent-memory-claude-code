/**
 * Error-signature extractor (B2a, pure, no I/O).
 *
 * Extracts deterministic, typed signals from a bug event's text so that
 * clusterTrigger can compute the COMMON error signatures across a cluster.
 *
 * What we capture (documented — no over-claiming):
 *   1. CamelCase names ending in "Error" or "Exception" with ≥1 leading
 *      CamelCase segment (e.g. TypeError, NullPointerException).
 *      Plain "Error" alone is NOT captured — it is too generic.
 *   2. ERR_* codes (Node.js style, e.g. ERR_MODULE_NOT_FOUND).
 *   3. POSIX-style errno codes: ENOENT, ECONNREFUSED, EACCES, etc.
 *      Pattern: uppercase E followed by ≥2 uppercase letters/digits.
 *   4. HTTP error status codes (4xx + 5xx) — normalised as "HTTP_<code>".
 *   5. Short quoted strings (≤60 chars, single or double quotes) that
 *      look like error messages (contain "error", "fail", "refused",
 *      "denied", "timeout", or "not found" case-insensitively).
 *
 * Returns a sorted, deduplicated array of string signatures.
 * Never throws: any unexpected input degrades to [].
 */

// ── Patterns (compiled once at module load) ───────────────────────────────────

/**
 * CamelCase Error/Exception names: must start with a capital letter followed
 * by at least one lowercase letter, then end with "Error" or "Exception".
 * Matches: TypeError, ReferenceError, NullPointerException, CircuitBreakerError.
 * Does NOT match plain "Error" or "Exception" alone (too generic).
 */
const CAMEL_ERROR_RE = /\b([A-Z][a-z]+[A-Za-z]*(?:Error|Exception))\b/g;

/** Node.js ERR_* codes (all-caps with underscores). */
const ERR_CODE_RE = /\bERR_[A-Z0-9_]+\b/g;

/**
 * POSIX errno codes: uppercase E followed by ≥2 uppercase letters/digits.
 * Does NOT match plain E followed by a lowercase word.
 */
const ERRNO_RE = /\bE[A-Z]{2,}\b/g;

/** HTTP 4xx and 5xx codes, optionally preceded by "HTTP" / "status" / "code". */
const HTTP_STATUS_RE = /\b(?:HTTP[/ ]?)?([45]\d{2})\b/g;

/** Short quoted strings ≤60 chars (single or double). */
const QUOTED_RE = /"([^"]{1,60})"|'([^']{1,60})'/g;

/** Keywords that make a quoted string look like an error message. */
const ERROR_KEYWORDS_RE = /error|fail|refused|denied|timeout|not found/i;

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract error/type signatures from a single bug event text.
 * Returns a sorted, deduplicated string[]. Never throws.
 */
export function extractErrorSignatures(text: string): string[] {
  if (!text) return [];

  try {
    const found = new Set<string>();

    // 1. CamelCase Error/Exception names
    for (const m of text.matchAll(CAMEL_ERROR_RE)) {
      found.add(m[1]);
    }

    // 2. ERR_* codes
    for (const m of text.matchAll(ERR_CODE_RE)) {
      found.add(m[0]);
    }

    // 3. POSIX errno codes (skip any that also matched ERR_* — already added)
    for (const m of text.matchAll(ERRNO_RE)) {
      // Exclude ERR_ prefix matches (those are longer and already captured)
      if (!m[0].startsWith("ERR_")) {
        found.add(m[0]);
      }
    }

    // 4. HTTP 4xx/5xx status codes → normalise to "HTTP_<code>"
    for (const m of text.matchAll(HTTP_STATUS_RE)) {
      found.add(`HTTP_${m[1]}`);
    }

    // 5. Short quoted strings that look like error messages
    for (const m of text.matchAll(QUOTED_RE)) {
      const inner = (m[1] ?? m[2]).trim();
      if (inner && ERROR_KEYWORDS_RE.test(inner)) {
        // Re-wrap in double quotes for a canonical form
        found.add(`"${inner}"`);
      }
    }

    return [...found].sort();
  } catch {
    return [];
  }
}
