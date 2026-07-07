/**
 * Unit tests for the slow-recall breadcrumb composer.
 *
 * The breadcrumb is the deterministic attribution: given a slow elapsed time and
 * a heavy task in flight, the composed line must name that task.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { isSlowRecall, composeSlowRecallBreadcrumb, SLOW_RECALL_MS } from "../slow-recall.js";
import { beginHeavyTask, _resetHeavyTasksForTest } from "../inflight-registry.js";
import { _resetEventLoopMonitorForTest } from "../event-loop-monitor.js";

describe("slow-recall", () => {
  beforeEach(() => {
    _resetHeavyTasksForTest();
    _resetEventLoopMonitorForTest();
  });

  it("isSlowRecall trips at/above the threshold and not below", () => {
    expect(isSlowRecall(SLOW_RECALL_MS)).toBe(true);
    expect(isSlowRecall(SLOW_RECALL_MS + 1)).toBe(true);
    expect(isSlowRecall(SLOW_RECALL_MS - 1)).toBe(false);
    expect(isSlowRecall(0)).toBe(false);
  });

  it("isSlowRecall rejects non-finite input (NaN and Infinity are never valid elapsed times)", () => {
    expect(isSlowRecall(Number.NaN)).toBe(false);
    expect(isSlowRecall(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("breadcrumb names the heavy task that was in flight", () => {
    beginHeavyTask("consolidation");
    const line = composeSlowRecallBreadcrumb(3200);
    expect(line).toContain("SLOW RECALL 3200ms");
    expect(line).toContain("consolidation");
    expect(line).toContain("lag="); // monitor not started → lag=unavailable
  });

  it("breadcrumb still composes with no heavy tasks and no monitor", () => {
    const line = composeSlowRecallBreadcrumb(1800);
    expect(line).toContain("SLOW RECALL 1800ms");
    expect(line).toContain("active=[none]");
  });
});
