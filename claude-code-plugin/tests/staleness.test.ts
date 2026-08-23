/**
 * The hole detector, tested against the REAL numbers of the 2026-08-13 → 08-22
 * outage and against the holiday that must NOT trigger it.
 */

import { describe, it, expect } from "vitest";
import { assessStaleness, describeStaleness, STALE_GAP_MS } from "../lib/staleness.js";

const DAY = 24 * 60 * 60 * 1000;

describe("assessStaleness", () => {
  it("fires on the real outage: last memory 12/08, work continued to 22/08", () => {
    const lastCapture = "2026-08-12T23:13:39.566Z";
    const newestSession = Date.parse("2026-08-22T17:05:00.000Z");
    const now = Date.parse("2026-08-22T19:00:00.000Z");
    const v = assessStaleness(lastCapture, newestSession, now);
    expect(v.stale).toBe(true);
    expect(Math.round(v.gapMs / DAY)).toBe(10);
    expect(describeStaleness(v)).toContain("BUCO");
  });

  it("stays SILENT during a holiday — no sessions, no memory, no alarm", () => {
    // Memory stops because work stops. Both clocks freeze together.
    const lastCapture = "2026-08-12T23:13:39.566Z";
    const newestSession = Date.parse("2026-08-12T23:14:00.000Z");
    const now = Date.parse("2026-08-22T19:00:00.000Z");
    expect(assessStaleness(lastCapture, newestSession, now).stale).toBe(false);
  });

  it("tolerates a normal working day (gap under the threshold)", () => {
    const now = Date.parse("2026-08-22T19:00:00.000Z");
    const v = assessStaleness(
      new Date(now - 6 * 60 * 60 * 1000).toISOString(),
      now - 60_000,
      now,
    );
    expect(v.stale).toBe(false);
  });

  it("treats unknowns as healthy — a false alarm would poison every real one", () => {
    const now = Date.now();
    expect(assessStaleness(null, now, now).stale).toBe(false);
    expect(assessStaleness(undefined, now, now).stale).toBe(false);
    expect(assessStaleness("not-a-date", now, now).stale).toBe(false);
    // No transcripts readable at all.
    expect(assessStaleness(new Date(0).toISOString(), 0, now).stale).toBe(false);
  });

  it("ignores transcript mtimes in the future (clock skew)", () => {
    const now = Date.parse("2026-08-22T19:00:00.000Z");
    const v = assessStaleness(
      new Date(now - 60_000).toISOString(),
      now + 30 * DAY, // a file dated a month ahead
      now,
    );
    expect(v.stale).toBe(false);
  });

  it("uses the configured threshold", () => {
    const now = Date.parse("2026-08-22T19:00:00.000Z");
    const capture = new Date(now - 2 * DAY).toISOString();
    expect(assessStaleness(capture, now, now, STALE_GAP_MS).stale).toBe(true);
    expect(assessStaleness(capture, now, now, 7 * DAY).stale).toBe(false);
  });
});
