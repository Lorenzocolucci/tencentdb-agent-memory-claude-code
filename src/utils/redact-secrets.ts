/**
 * Secret redaction (SECURITY HIGH).
 *
 * Strips credentials from text BEFORE it is persisted (L0 JSONL, L1 records,
 * KB facts/events + FTS) or sent to the embedding/LLM provider. Without this a
 * secret a user pastes in chat is stored in cleartext on disk AND egresses to
 * OpenAI for embedding (confirmed by the 2026-06-24 secret-leak audit).
 *
 * DESIGN — CONSERVATIVE ON PURPOSE. This is a memory engine for a developer: it
 * stores file paths, commit SHAs, UUIDs, code and technical constants. Blanket
 * hex/entropy redaction would corrupt legitimate memories, so we redact ONLY
 * high-confidence secret shapes and keyword-anchored `key: value` assignments.
 * Bare hex (git SHAs), UUIDs and technical constants (UTF-8, HTTP-2) are left
 * untouched. Each rule replaces the secret with a typed `[REDACTED:...]` marker
 * so the memory still reads sensibly ("the api key is [REDACTED:api-key]").
 */

const PLACEHOLDER = (kind: string): string => `[REDACTED:${kind}]`;

/** One redaction rule: a pattern and the replacement it produces. */
interface Rule {
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

// Order matters: the most specific / multi-line rules run first so a JWT or PEM
// block is consumed whole before narrower rules can nibble at its pieces.
const RULES: Rule[] = [
  // PEM private key block (multi-line).
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => PLACEHOLDER("private-key"),
  },
  // JWT: three base64url segments.
  {
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    replace: () => PLACEHOLDER("jwt"),
  },
  // OpenAI-style keys: sk- / sk-proj-.
  {
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
    replace: () => PLACEHOLDER("api-key"),
  },
  // Google API key.
  {
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => PLACEHOLDER("google-key"),
  },
  // Slack token.
  {
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => PLACEHOLDER("slack-token"),
  },
  // AWS access key id.
  {
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => PLACEHOLDER("aws-key"),
  },
  // Bearer token — keep the scheme word, redact the credential.
  {
    re: /\bBearer\s+[A-Za-z0-9._-]{10,}/g,
    replace: () => `Bearer ${PLACEHOLDER("token")}`,
  },
  // Keyword-anchored assignment: password/secret/token/api_key/... = <value>.
  // Requires the keyword + a separator, so a bare hex/UUID is never matched.
  {
    re: /\b(password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|api[_-]?key|apikey)\b(\s*[:=]\s*)(["']?)([^\s"']{6,})\3/gi,
    replace: (_m, key: string, sep: string, quote: string) =>
      `${key}${sep}${quote}${PLACEHOLDER("secret")}${quote}`,
  },
];

/**
 * Redact secrets from a string. Returns the text with credentials replaced by
 * typed `[REDACTED:...]` markers. Non-secret text (paths, SHAs, UUIDs, prose) is
 * returned unchanged. Empty/whitespace input is returned as-is.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    // Reset lastIndex defensively (global regexes are stateful when reused).
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/** True when {@link redactSecrets} would change the text (i.e. a secret is present). */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
