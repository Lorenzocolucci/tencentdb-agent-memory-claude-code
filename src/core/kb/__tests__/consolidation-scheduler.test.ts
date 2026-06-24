/**
 * Phase A — live wiring: fire-and-forget consolidation scheduler.
 *
 * The scheduler is the policy seam between the deterministic consolidation pass
 * (runConsolidation, already unit-tested) and the session-end hook. It must:
 *   - defer the (synchronous) pass to a macrotask so the caller's response is
 *     sent BEFORE the sweep runs
 *   - register the in-flight task so a shutdown drain can await it, and remove
 *     it again when done
 *   - NEVER throw on the session-end path — a failing pass is logged, swallowed
 *   - no-op when the store cannot consolidate (TCVDB backend / degraded / no key)
 */

import { describe, it, expect, vi } from "vitest";
import { scheduleConsolidation, type ConsolidatableStore } from "../consolidation-scheduler.js";

const SESSION = "sessA";
const NOW = "2026-06-24T01:00:00.000Z";

function fakeStore(over: Partial<ConsolidatableStore> = {}): ConsolidatableStore {
  return {
    consolidateSession: vi.fn(() => ({ eventsReinforced: 2, factsReinforced: 1, staled: 0 })),
    isDegraded: () => false,
    ...over,
  };
}

describe("scheduleConsolidation", () => {
  it("defers, runs the pass once with the session key + now, and resolves", async () => {
    const store = fakeStore();
    const task = scheduleConsolidation({ store, sessionKey: SESSION, now: NOW });
    expect(task).not.toBeNull();
    // Deferred: the synchronous pass has NOT run yet on the same tick.
    expect(store.consolidateSession).not.toHaveBeenCalled();
    await task;
    expect(store.consolidateSession).toHaveBeenCalledTimes(1);
    expect(store.consolidateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: SESSION, now: NOW }),
    );
  });

  it("registers the task and unregisters it after completion", async () => {
    const store = fakeStore();
    const register = vi.fn();
    const unregister = vi.fn();
    const task = scheduleConsolidation({ store, sessionKey: SESSION, now: NOW, register, unregister });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(task);
    expect(unregister).not.toHaveBeenCalled();
    await task;
    expect(unregister).toHaveBeenCalledWith(task);
  });

  it("swallows a failing pass (logs warn, resolves, still unregisters)", async () => {
    const boom = vi.fn(() => {
      throw new Error("disk full");
    });
    const store = fakeStore({ consolidateSession: boom });
    const unregister = vi.fn();
    const warn = vi.fn();
    const task = scheduleConsolidation({
      store,
      sessionKey: SESSION,
      now: NOW,
      unregister,
      logger: { warn },
    });
    await expect(task).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledWith(task);
  });

  it("no-ops (returns null) when the session key is empty", () => {
    const store = fakeStore();
    expect(scheduleConsolidation({ store, sessionKey: "", now: NOW })).toBeNull();
    expect(store.consolidateSession).not.toHaveBeenCalled();
  });

  it("no-ops when the store is absent or cannot consolidate", () => {
    expect(scheduleConsolidation({ store: undefined, sessionKey: SESSION, now: NOW })).toBeNull();
    // Store without the optional method (e.g. TCVDB backend).
    expect(
      scheduleConsolidation({ store: { isDegraded: () => false }, sessionKey: SESSION, now: NOW }),
    ).toBeNull();
  });

  it("no-ops when the store is degraded", () => {
    const store = fakeStore({ isDegraded: () => true });
    expect(scheduleConsolidation({ store, sessionKey: SESSION, now: NOW })).toBeNull();
    expect(store.consolidateSession).not.toHaveBeenCalled();
  });
});
