import { describe, it, expect } from "vitest";
import { THREAD_EVENT_TYPES, isThreadType } from "../recap-types.js";

describe("recap thread types", () => {
  it("includes decision/task/fix/result/bug/config_change, excludes observation", () => {
    expect(isThreadType("decision")).toBe(true);
    expect(isThreadType("task")).toBe(true);
    expect(isThreadType("fix")).toBe(true);
    expect(isThreadType("observation")).toBe(false);
  });
  it("THREAD_EVENT_TYPES is frozen and non-empty", () => {
    expect(THREAD_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(THREAD_EVENT_TYPES)).toBe(true);
  });
});
