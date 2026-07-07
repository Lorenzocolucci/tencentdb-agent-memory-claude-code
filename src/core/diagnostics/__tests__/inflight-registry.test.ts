/**
 * Unit tests for the in-flight heavy-task registry.
 *
 * Deterministic: we assert STRUCTURE and ATTRIBUTION (who is active, who just
 * finished, ring bound, immutability) — never wall-clock millisecond values.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  beginHeavyTask,
  endHeavyTask,
  snapshotHeavyTasks,
  formatHeavyTaskSnapshot,
  _resetHeavyTasksForTest,
} from "../inflight-registry.js";

describe("inflight-registry", () => {
  beforeEach(() => _resetHeavyTasksForTest());

  it("an active task appears in snapshot.active and not in recent", () => {
    beginHeavyTask("consolidation");
    const snap = snapshotHeavyTasks();
    expect(snap.active.map((a) => a.name)).toEqual(["consolidation"]);
    expect(snap.recent).toHaveLength(0);
    expect(snap.active[0].runningMs).toBeGreaterThanOrEqual(0);
  });

  it("ending a task moves it from active to recent", () => {
    const token = beginHeavyTask("l0-index");
    endHeavyTask(token);
    const snap = snapshotHeavyTasks();
    expect(snap.active).toHaveLength(0);
    expect(snap.recent.map((r) => r.name)).toEqual(["l0-index"]);
    expect(snap.recent[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(snap.recent[0].endedAgoMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks multiple concurrent active tasks independently", () => {
    const a = beginHeavyTask("consolidation");
    beginHeavyTask("l0-index");
    endHeavyTask(a);
    const snap = snapshotHeavyTasks();
    expect(snap.active.map((x) => x.name)).toEqual(["l0-index"]);
    expect(snap.recent.map((x) => x.name)).toEqual(["consolidation"]);
  });

  it("recent is bounded to the ring size (no unbounded growth)", () => {
    for (let i = 0; i < 60; i++) {
      endHeavyTask(beginHeavyTask(`task-${i}`));
    }
    const snap = snapshotHeavyTasks();
    expect(snap.recent.length).toBeLessThanOrEqual(24);
    // Most recent finisher must be present (ordered nearest-first).
    expect(snap.recent[0].name).toBe("task-59");
  });

  it("endHeavyTask is a no-op for undefined / unknown tokens (never throws)", () => {
    expect(() => endHeavyTask(undefined)).not.toThrow();
    expect(() => endHeavyTask({ id: 99999, name: "ghost" })).not.toThrow();
    expect(snapshotHeavyTasks().recent).toHaveLength(0);
  });

  it("snapshot arrays are fresh copies (caller cannot mutate internal state)", () => {
    beginHeavyTask("consolidation");
    const first = snapshotHeavyTasks();
    (first.active as unknown as unknown[]).push({ name: "injected", runningMs: 0 });
    const second = snapshotHeavyTasks();
    expect(second.active.map((a) => a.name)).toEqual(["consolidation"]);
  });

  it("formatHeavyTaskSnapshot renders active + recent names, or 'none'", () => {
    expect(formatHeavyTaskSnapshot({ active: [], recent: [] })).toBe("active=[none] recent=[none]");
    const token = beginHeavyTask("consolidation");
    endHeavyTask(token);
    beginHeavyTask("l0-index");
    const line = formatHeavyTaskSnapshot(snapshotHeavyTasks());
    expect(line).toContain("l0-index(running");
    expect(line).toContain("consolidation(");
  });
});
