/**
 * Unit tests for the event-loop lag monitor.
 *
 * We test the wrapper contract we own (null-before-start, shape-after-start,
 * idempotent start, formatter) — not the accuracy of libuv's histogram, which
 * is Node's responsibility.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  startEventLoopMonitor,
  readEventLoopLag,
  resetEventLoopLag,
  formatEventLoopLag,
  _resetEventLoopMonitorForTest,
} from "../event-loop-monitor.js";

describe("event-loop-monitor", () => {
  afterEach(() => _resetEventLoopMonitorForTest());

  it("returns null before the monitor is started", () => {
    expect(readEventLoopLag()).toBeNull();
  });

  it("returns a numeric lag shape after start", () => {
    startEventLoopMonitor();
    const lag = readEventLoopLag();
    expect(lag).not.toBeNull();
    expect(typeof lag!.maxMs).toBe("number");
    expect(typeof lag!.meanMs).toBe("number");
    expect(typeof lag!.p99Ms).toBe("number");
  });

  it("start is idempotent (second call does not throw or replace)", () => {
    startEventLoopMonitor();
    expect(() => startEventLoopMonitor()).not.toThrow();
    expect(readEventLoopLag()).not.toBeNull();
  });

  it("reset does not throw whether or not the monitor is running", () => {
    expect(() => resetEventLoopLag()).not.toThrow();
    startEventLoopMonitor();
    expect(() => resetEventLoopLag()).not.toThrow();
  });

  it("formatEventLoopLag handles null and finite/non-finite values", () => {
    expect(formatEventLoopLag(null)).toBe("lag=unavailable");
    expect(formatEventLoopLag({ maxMs: 1234, p99Ms: 900, meanMs: 12 })).toBe(
      "lag_max=1234ms lag_p99=900ms lag_mean=12ms",
    );
    expect(formatEventLoopLag({ maxMs: NaN, p99Ms: NaN, meanMs: NaN })).toBe(
      "lag_max=?ms lag_p99=?ms lag_mean=?ms",
    );
  });
});
