/**
 * Secret redaction (SECURITY HIGH) — strip credentials BEFORE they are persisted
 * to L0/L1/KB or sent to the embedding provider. This is a memory engine for a
 * DEVELOPER: it stores file paths, commit SHAs, code and technical constants, so
 * redaction must be CONSERVATIVE — high-confidence secret shapes + keyword-
 * anchored assignments only. NEVER blanket-redact bare hex (git SHAs) or UUIDs.
 */

import { describe, it, expect } from "vitest";
import { redactSecrets, containsSecret } from "../redact-secrets.js";

describe("redactSecrets — high-confidence secret shapes", () => {
  it("redacts an OpenAI key (sk- / sk-proj-)", () => {
    expect(redactSecrets("my key is sk-proj-AbCd1234EfGh5678IjKl9012")).not.toContain("sk-proj-AbCd");
    expect(redactSecrets("sk-AbCd1234EfGh5678IjKlMnOp")).toContain("[REDACTED");
  });

  it("redacts an AWS access key id", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE here")).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36";
    expect(redactSecrets(`token ${jwt}`)).not.toContain(jwt);
  });

  it("redacts a Bearer token but keeps the scheme word", () => {
    const out = redactSecrets("Authorization: Bearer abcdef1234567890XYZ");
    expect(out).toContain("Bearer");
    expect(out).not.toContain("abcdef1234567890XYZ");
  });

  it("redacts a PEM private key block", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhk\n-----END PRIVATE KEY-----";
    expect(redactSecrets(pem)).not.toContain("MIIEvQIBADANBg");
  });

  it("redacts a Google API key and a Slack token", () => {
    expect(redactSecrets("AIzaSyA1234567890abcdefGHIJKLMNOPQRSTUV")).toContain("[REDACTED");
    expect(redactSecrets("xoxb-123456789012-abcdefABCDEF")).toContain("[REDACTED");
  });
});

describe("redactSecrets — keyword-anchored assignments", () => {
  it("redacts the value of password/secret/token/api_key assignments, keeps the key", () => {
    const out = redactSecrets('password = "hunter2supersecret"');
    expect(out).toContain("password");
    expect(out).not.toContain("hunter2supersecret");

    const out2 = redactSecrets("api_key: 9f8e7d6c5b4a3f2e1d0c");
    expect(out2).toContain("api_key");
    expect(out2).not.toContain("9f8e7d6c5b4a3f2e1d0c");
  });
});

describe("redactSecrets — must NOT corrupt legitimate developer content", () => {
  it("leaves a git commit SHA untouched", () => {
    const sha = "commit faf4d09e1234567890abcdef1234567890abcdef";
    expect(redactSecrets(sha)).toBe(sha);
  });

  it("leaves a UUID untouched", () => {
    const u = "id 550e8400-e29b-41d4-a716-446655440000";
    expect(redactSecrets(u)).toBe(u);
  });

  it("leaves file paths and ordinary prose untouched", () => {
    const t = "Edit src/core/hooks/principles.ts at line 42 — the loadPrinciples fix.";
    expect(redactSecrets(t)).toBe(t);
  });

  it("leaves technical constants like UTF-8 / HTTP-2 untouched", () => {
    const t = "encoding UTF-8 over HTTP-2 protocol";
    expect(redactSecrets(t)).toBe(t);
  });

  it("is empty-safe", () => {
    expect(redactSecrets("")).toBe("");
  });
});

describe("containsSecret", () => {
  it("detects when redaction would change the text", () => {
    expect(containsSecret("sk-AbCd1234EfGh5678IjKlMnOp")).toBe(true);
    expect(containsSecret("just normal text with a SHA faf4d09")).toBe(false);
  });
});
