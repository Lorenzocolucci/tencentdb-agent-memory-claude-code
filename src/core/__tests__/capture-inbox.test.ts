/**
 * The durable capture inbox (2026-09-06): the parcel is signed for as soon as
 * it is on disk; unpacking happens afterwards, one at a time, in order, and a
 * restart replays what was left. Everything runs in an ephemeral temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CaptureInbox } from "../capture-inbox.js";

interface Body { n: number; messages: string[] }

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-inbox-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const noYield = async (): Promise<void> => {};

describe("CaptureInbox", () => {
  it("enqueue returns as soon as the file is on disk, before the processor runs (the 12s fix)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const seen: number[] = [];
    const inbox = new CaptureInbox<Body>({
      dir,
      process: async (item) => { await gate; seen.push(item.body.n); },
      yieldToLoop: noYield,
    });
    await inbox.start();

    const t0 = Date.now();
    const { id } = await inbox.enqueue({ n: 1, messages: ["a", "b"] });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(true);
    expect(seen).toEqual([]); // still unpacking — the client already has its answer

    release();
    await inbox.idle();
    expect(seen).toEqual([1]);
    expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(false); // consumed
  });

  it("processes items strictly in enqueue order", async () => {
    const seen: number[] = [];
    let clock = 1_000_000;
    const inbox = new CaptureInbox<Body>({
      dir,
      process: async (item) => { seen.push(item.body.n); },
      yieldToLoop: noYield,
      now: () => clock++,
    });
    await inbox.start();
    await Promise.all([1, 2, 3, 4, 5].map((n) => inbox.enqueue({ n, messages: [] })));
    await inbox.idle();
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("replays files left on disk by a previous process, oldest first", async () => {
    // Simulate a crash: files exist, no inbox instance ever processed them.
    fs.writeFileSync(path.join(dir, "000000000000002-000001-aa.json"), JSON.stringify({ id: "b", body: { n: 2, messages: [] } }));
    fs.writeFileSync(path.join(dir, "000000000000001-000001-aa.json"), JSON.stringify({ id: "a", body: { n: 1, messages: [] } }));
    const seen: number[] = [];
    const inbox = new CaptureInbox<Body>({ dir, process: async (i) => { seen.push(i.body.n); }, yieldToLoop: noYield });
    await inbox.start();
    await inbox.idle();
    expect(seen).toEqual([1, 2]);
    expect((await inbox.status()).pending).toBe(0);
  });

  it("retries a failing item and parks it in failed/ after maxAttempts, with the error next to it", async () => {
    const attempts: number[] = [];
    const inbox = new CaptureInbox<Body>({
      dir,
      process: async (item) => { attempts.push(item.body.n); throw new Error("SQLITE_BUSY simulated"); },
      maxAttempts: 3,
      retryDelayMs: 1,
      yieldToLoop: noYield,
    });
    await inbox.start();
    await inbox.enqueue({ n: 7, messages: [] });
    // Three attempts spaced by the 1ms retry timer.
    await vi.waitFor(async () => {
      expect((await inbox.status()).failed).toBe(1);
    }, { timeout: 5_000, interval: 5 });
    expect(attempts).toEqual([7, 7, 7]);
    const failed = fs.readdirSync(path.join(dir, "failed"));
    expect(failed.some((f) => f.endsWith(".json"))).toBe(true);
    const errFile = failed.find((f) => f.endsWith(".error.txt"))!;
    expect(fs.readFileSync(path.join(dir, "failed", errFile), "utf-8")).toContain("SQLITE_BUSY simulated");
    expect((await inbox.status()).pending).toBe(0);
  });

  it("a poison item does not block the ones behind it forever", async () => {
    const seen: number[] = [];
    const inbox = new CaptureInbox<Body>({
      dir,
      process: async (item) => { if (item.body.n === 1) throw new Error("poison"); seen.push(item.body.n); },
      maxAttempts: 2,
      retryDelayMs: 1,
      yieldToLoop: noYield,
    });
    let clock = 5_000_000;
    (inbox as unknown as { now: () => number }).now = () => clock++;
    await inbox.start();
    await inbox.enqueue({ n: 1, messages: [] });
    await inbox.enqueue({ n: 2, messages: [] });
    await vi.waitFor(async () => {
      expect(seen).toEqual([2]);
    }, { timeout: 5_000, interval: 5 });
    expect((await inbox.status()).failed).toBe(1);
  });

  it("status reports the backlog and the age of the oldest pending item", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let clock = Date.now();
    const inbox = new CaptureInbox<Body>({
      dir,
      process: async () => { await gate; },
      yieldToLoop: noYield,
      now: () => clock,
    });
    await inbox.start();
    await inbox.enqueue({ n: 1, messages: [] });
    await inbox.enqueue({ n: 2, messages: [] });
    clock += 120_000; // two minutes later, still stuck on item 1
    const s = await inbox.status();
    expect(s.pending).toBe(2);
    expect(s.oldestPendingAgeS).toBeGreaterThanOrEqual(119);
    expect(s.draining).toBe(true);
    release();
    await inbox.idle();
    expect((await inbox.status()).pending).toBe(0);
  });

  it("never leaves a half-written file: enqueue writes tmp then renames", async () => {
    const inbox = new CaptureInbox<Body>({ dir, process: async () => {}, yieldToLoop: noYield });
    // Not started: nothing drains, so the file must sit there complete.
    const { id } = await inbox.enqueue({ n: 9, messages: ["x".repeat(10_000)] });
    const names = fs.readdirSync(dir);
    expect(names).toEqual([`${id}.json`]);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf-8")) as { id: string; body: Body };
    expect(parsed.body.messages[0]).toHaveLength(10_000);
  });
});
