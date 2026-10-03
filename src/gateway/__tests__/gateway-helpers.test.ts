/** Unit tests for the small gateway helpers: lock file, recall deadline, crash log, log stamp. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireGatewayLock, GatewayLockHeldError, GATEWAY_LOCK_FILE } from "../gateway-lock.js";
import { resolveRecallTimeoutMs } from "../recall-deadline.js";
import { installCrashHandlers, writeCrashLog, CRASH_LOG_FILE } from "../crash-log.js";
import { stampLogLine } from "../server.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gw-helpers-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("acquireGatewayLock", () => {
  it("creates the lock with our pid and releases it", async () => {
    const lock = await acquireGatewayLock(dir, { pid: 111 });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, GATEWAY_LOCK_FILE), "utf-8")) as { pid: number };
    expect(onDisk.pid).toBe(111);
    await lock.release();
    expect(fs.existsSync(path.join(dir, GATEWAY_LOCK_FILE))).toBe(false);
  });

  it("refuses while the owner is alive", async () => {
    await acquireGatewayLock(dir, { pid: 111, isAlive: () => true });
    await expect(acquireGatewayLock(dir, { pid: 222, isAlive: () => true })).rejects.toMatchObject({
      name: "GatewayLockHeldError",
      ownerPid: 111,
    });
  });

  it("takes over when the owner pid is dead", async () => {
    await acquireGatewayLock(dir, { pid: 111 });
    const lock = await acquireGatewayLock(dir, { pid: 222, isAlive: () => false });
    const onDisk = JSON.parse(fs.readFileSync(lock.path, "utf-8")) as { pid: number };
    expect(onDisk.pid).toBe(222);
  });

  it("treats a fresh unreadable lock as held (writer mid-write) and an old one as stale", async () => {
    const p = path.join(dir, GATEWAY_LOCK_FILE);
    fs.writeFileSync(p, "");
    await expect(acquireGatewayLock(dir, { pid: 5 })).rejects.toBeInstanceOf(GatewayLockHeldError);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(p, old, old);
    await expect(acquireGatewayLock(dir, { pid: 5 })).resolves.toBeDefined();
  });

  it("release never removes a lock that now belongs to someone else", async () => {
    const lock = await acquireGatewayLock(dir, { pid: 111 });
    fs.writeFileSync(lock.path, JSON.stringify({ pid: 999 }));
    await lock.release();
    expect(fs.existsSync(lock.path)).toBe(true);
  });
});

describe("resolveRecallTimeoutMs", () => {
  it("uses min(configured, header - 500) with a 500 ms floor", () => {
    expect(resolveRecallTimeoutMs(5000, "4500")).toBe(4000);
    expect(resolveRecallTimeoutMs(5000, "60000")).toBe(5000);
    expect(resolveRecallTimeoutMs(5000, "700")).toBe(500);
    expect(resolveRecallTimeoutMs(5000, ["3500"])).toBe(3000);
  });

  it("ignores a missing or unusable header", () => {
    expect(resolveRecallTimeoutMs(5000, undefined)).toBeUndefined();
    expect(resolveRecallTimeoutMs(5000, "abc")).toBeUndefined();
    expect(resolveRecallTimeoutMs(5000, "-5")).toBeUndefined();
    expect(resolveRecallTimeoutMs(5000, "0")).toBeUndefined();
  });
});

describe("crash black box", () => {
  it("appends an ISO-stamped entry with the stack to gateway.crash.log", () => {
    writeCrashLog(dir, "uncaughtException", new Error("boom"));
    writeCrashLog(dir, "unhandledRejection", "plain reason");
    const text = fs.readFileSync(path.join(dir, CRASH_LOG_FILE), "utf-8");
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z pid=\d+ uncaughtException: Error: boom/);
    expect(text).toContain("unhandledRejection: plain reason");
    expect(text.trim().split("\n").filter((l) => /^\d{4}-/.test(l))).toHaveLength(2);
  });

  it("installed handlers write the log then exit 1", () => {
    const listeners = new Map<string, (err: unknown) => void>();
    const exit = vi.fn();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    installCrashHandlers(dir, exit, { on: (e, l) => { listeners.set(e, l); } });
    listeners.get("uncaughtException")!(new Error("forced"));
    stderr.mockRestore();
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.readFileSync(path.join(dir, CRASH_LOG_FILE), "utf-8")).toContain("forced");
    expect([...listeners.keys()].sort()).toEqual(["uncaughtException", "unhandledRejection"]);
  });
});

describe("stampLogLine", () => {
  it("prefixes an ISO timestamp", () => {
    expect(stampLogLine("hello", new Date("2026-10-03T10:11:12.345Z"))).toBe(
      "2026-10-03T10:11:12.345Z [tdai-gateway] hello",
    );
  });
});
