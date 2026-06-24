/**
 * B2a — error-signature extractor tests (TDD: RED first, then GREEN).
 *
 * Mandatory pins:
 *   T1  Given bug text with CamelCase Error/Exception names → extracted.
 *   T2  Given ERR_* / E_* codes → extracted.
 *   T3  Given HTTP status codes (4xx, 5xx) → extracted.
 *   T4  Given quoted error strings → extracted.
 *   T5  Given plain prose (no patterns) → returns [].
 *   T6  Results are deduplicated and sorted.
 */

import { describe, it, expect } from "vitest";
import { extractErrorSignatures } from "../error-signature-extractor.js";

describe("extractErrorSignatures", () => {
  // T1 — CamelCase Error/Exception names
  it("extracts CamelCase names ending in Error", () => {
    const sigs = extractErrorSignatures("Crashed with TypeError and ReferenceError in loop");
    expect(sigs).toContain("TypeError");
    expect(sigs).toContain("ReferenceError");
  });

  it("extracts CamelCase names ending in Exception", () => {
    const sigs = extractErrorSignatures("java.lang.NullPointerException thrown");
    expect(sigs).toContain("NullPointerException");
  });

  it("extracts short known single-word error names (Error, Exception)", () => {
    const sigs = extractErrorSignatures("An Error occurred");
    // "Error" alone does not qualify — requires at least one preceding CamelCase segment
    expect(sigs).not.toContain("Error");
  });

  // T2 — ERR_* / E* codes (Node.js style)
  it("extracts ERR_* codes", () => {
    const sigs = extractErrorSignatures("Node threw ERR_MODULE_NOT_FOUND and ERR_SOCKET_TIMEOUT");
    expect(sigs).toContain("ERR_MODULE_NOT_FOUND");
    expect(sigs).toContain("ERR_SOCKET_TIMEOUT");
  });

  it("extracts ENOENT / ECONNREFUSED style codes", () => {
    const sigs = extractErrorSignatures("ENOENT: no such file, ECONNREFUSED at 127.0.0.1");
    expect(sigs).toContain("ENOENT");
    expect(sigs).toContain("ECONNREFUSED");
  });

  // T3 — HTTP status codes (4xx, 5xx)
  it("extracts HTTP 4xx status codes", () => {
    const sigs = extractErrorSignatures("Server returned HTTP 404 and then HTTP 401");
    expect(sigs).toContain("HTTP_404");
    expect(sigs).toContain("HTTP_401");
  });

  it("extracts HTTP 5xx status codes", () => {
    const sigs = extractErrorSignatures("Got status 500 and 503 from upstream");
    expect(sigs).toContain("HTTP_500");
    expect(sigs).toContain("HTTP_503");
  });

  it("does NOT extract non-error HTTP codes (2xx, 3xx)", () => {
    const sigs = extractErrorSignatures("Got 200 OK and 302 redirect");
    expect(sigs).not.toContain("HTTP_200");
    expect(sigs).not.toContain("HTTP_302");
  });

  // T4 — Quoted error strings (short, useful as fingerprints)
  it("extracts short quoted error strings", () => {
    const sigs = extractErrorSignatures('Failed with "connection refused" and "auth failed"');
    expect(sigs).toContain('"connection refused"');
    expect(sigs).toContain('"auth failed"');
  });

  it("ignores quoted strings longer than 60 chars (too specific, not a signal)", () => {
    const longStr = '"this is a very long message that should not be captured as a signature for fingerprinting"';
    const sigs = extractErrorSignatures(`Error: ${longStr}`);
    expect(sigs).not.toContain(longStr);
  });

  // T5 — Plain prose → []
  it("returns [] for plain prose with no error patterns", () => {
    const sigs = extractErrorSignatures("The build was slow today and the tests passed eventually");
    expect(sigs).toHaveLength(0);
  });

  it("returns [] for an empty string", () => {
    expect(extractErrorSignatures("")).toHaveLength(0);
  });

  // T6 — Dedup + sort
  it("deduplicates repeated signatures", () => {
    const sigs = extractErrorSignatures("TypeError again TypeError and TypeError");
    const count = sigs.filter((s) => s === "TypeError").length;
    expect(count).toBe(1);
  });

  it("returns signatures in sorted order", () => {
    const sigs = extractErrorSignatures("ZeroDivisionError and AttributeError in ERR_TIMEOUT");
    expect(sigs).toEqual([...sigs].sort());
  });
});
