import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raiseAlarm, peekAlarms, readAlarms } from "../lib/alarm.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdai-peek-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("peekAlarms", () => {
  it("returns the line WITHOUT deleting anything", async () => {
    await raiseAlarm(dir, "capture-failed", "boom");
    const peek = await peekAlarms(dir);
    expect(peek.line).toContain("boom");
    expect(await readAlarms(dir)).toHaveLength(1);
  });

  it("ack() removes exactly the alarms that were shown", async () => {
    await raiseAlarm(dir, "capture-failed", "boom");
    const peek = await peekAlarms(dir);
    await raiseAlarm(dir, "memory-stale", "raised after the peek");
    await peek.ack();
    const left = await readAlarms(dir);
    expect(left.map((a) => a.code)).toEqual(["memory-stale"]);
  });

  it("is empty and ack is a no-op when healthy", async () => {
    const peek = await peekAlarms(dir);
    expect(peek.line).toBe("");
    await expect(peek.ack()).resolves.toBeUndefined();
  });
});
