/** Rolling 10 s window of the event-loop monitor, with ISO timestamps. */
import { describe, it, expect, afterEach } from "vitest";
import {
  startEventLoopMonitor,
  readEventLoopLag,
  sampleEventLoopLag,
  formatEventLoopLag,
  resetEventLoopLag,
  WINDOW_MS,
  _resetEventLoopMonitorForTest,
} from "../event-loop-monitor.js";

function blockFor(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* synchronous stall */ }
}
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("event-loop-monitor rolling window", () => {
  afterEach(() => _resetEventLoopMonitorForTest());

  it("reports window bounds as ISO timestamps", () => {
    startEventLoopMonitor(10);
    const now = Date.parse("2026-10-03T12:00:10.000Z");
    const lag = readEventLoopLag(now)!;
    expect(lag.windowEnd).toBe("2026-10-03T12:00:10.000Z");
    expect(lag.windowStart).toBe("2026-10-03T12:00:00.000Z");
  });

  it("a stall stays visible with its timestamp for 10 s, then ages out (no reset needed)", async () => {
    startEventLoopMonitor(10);
    await tick(30);
    blockFor(250);
    await tick(30);
    const t0 = Date.now();
    sampleEventLoopLag(t0);

    const during = readEventLoopLag(t0 + 5_000)!;
    expect(during.maxMs).toBeGreaterThan(150);
    expect(during.worstAt).toBe(new Date(t0).toISOString());

    sampleEventLoopLag(t0 + WINDOW_MS + 1_000);
    const after = readEventLoopLag(t0 + WINDOW_MS + 1_000)!;
    expect(after.maxMs).toBe(0);
    expect(after.worstAt).toBeUndefined();
  });

  it("reset clears the window", async () => {
    startEventLoopMonitor(10);
    await tick(30);
    blockFor(150);
    await tick(30);
    sampleEventLoopLag();
    resetEventLoopLag();
    expect(readEventLoopLag()!.maxMs).toBe(0);
  });

  it("format appends worst_at and the window only when present", () => {
    expect(
      formatEventLoopLag({
        maxMs: 5000, p99Ms: 4000, meanMs: 10,
        worstAt: "2026-10-03T12:00:05.000Z",
        windowStart: "2026-10-03T12:00:00.000Z",
        windowEnd: "2026-10-03T12:00:10.000Z",
      }),
    ).toBe(
      "lag_max=5000ms lag_p99=4000ms lag_mean=10ms worst_at=2026-10-03T12:00:05.000Z window=2026-10-03T12:00:00.000Z..2026-10-03T12:00:10.000Z",
    );
  });
});
