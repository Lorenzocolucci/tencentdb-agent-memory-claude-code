/**
 * Capture inbox idempotency + lock-owner drain (2026-10-03). The plugin retries
 * a Stop whose ack it never saw; the same idempotency_key must not store the
 * session twice, whether the first copy is queued, in flight, or already written.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CaptureInbox } from "../capture-inbox.js";

interface Body { n: number }

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-inbox-idem-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const noYield = async (): Promise<void> => {};

describe("CaptureInbox idempotency", () => {
  it("skips a key that is already queued (nothing drains yet)", async () => {
    const seen: number[] = [];
    const inbox = new CaptureInbox<Body>({
      dir, process: async (i) => { seen.push(i.body.n); }, yieldToLoop: noYield, isOwner: () => false,
    });
    await inbox.start();
    const a = await inbox.enqueue({ n: 1 }, { idempotencyKey: "k1" });
    const b = await inbox.enqueue({ n: 2 }, { idempotencyKey: "k1" });
    expect(a.duplicate).toBe(false);
    expect(b).toEqual({ id: a.id, duplicate: true });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    expect(a.id.endsWith("-k1")).toBe(true);
  });

  it("skips a key that was already written, also after a restart", async () => {
    const seen: number[] = [];
    const make = () => new CaptureInbox<Body>({
      dir, process: async (i) => { seen.push(i.body.n); }, yieldToLoop: noYield,
    });
    const first = make();
    await first.start();
    await first.enqueue({ n: 1 }, { idempotencyKey: "k1" });
    await first.idle();
    await first.stop();

    const second = make();
    await second.start();
    const dup = await second.enqueue({ n: 1 }, { idempotencyKey: "k1" });
    await second.idle();
    expect(dup.duplicate).toBe(true);
    expect(seen).toEqual([1]);
  });

  it("does not write twice when a crash left the file behind after the write", async () => {
    const seen: number[] = [];
    const first = new CaptureInbox<Body>({ dir, process: async () => {}, yieldToLoop: noYield });
    await first.start();
    await first.enqueue({ n: 1 }, { idempotencyKey: "k9" });
    await first.idle();
    // Simulate: processed, recorded, but the file removal never happened.
    fs.writeFileSync(
      path.join(dir, "000000000000001-000001-aaaaaa-k9.json"),
      JSON.stringify({ id: "x-k9", body: { n: 1 }, key: "k9" }),
    );
    const second = new CaptureInbox<Body>({ dir, process: async (i) => { seen.push(i.body.n); }, yieldToLoop: noYield });
    await second.start();
    await second.idle();
    expect(seen).toEqual([]);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(0);
  });

  it("keeps distinct keys and keyless captures independent", async () => {
    const seen: number[] = [];
    const inbox = new CaptureInbox<Body>({ dir, process: async (i) => { seen.push(i.body.n); }, yieldToLoop: noYield });
    await inbox.start();
    await inbox.enqueue({ n: 1 }, { idempotencyKey: "a" });
    await inbox.enqueue({ n: 2 }, { idempotencyKey: "b" });
    await inbox.enqueue({ n: 3 });
    await inbox.enqueue({ n: 4 });
    await inbox.idle();
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("bounds the processed-id record", async () => {
    const inbox = new CaptureInbox<Body>({ dir, process: async () => {}, yieldToLoop: noYield, processedCap: 3 });
    await inbox.start();
    for (let i = 0; i < 6; i++) await inbox.enqueue({ n: i }, { idempotencyKey: `k${i}` });
    await inbox.idle();
    const lines = fs.readFileSync(path.join(dir, "processed-ids.log"), "utf-8").split("\n").filter(Boolean);
    expect(lines).toEqual(["k3", "k4", "k5"]);
  });

  it("sanitizes hostile keys into a safe file name", async () => {
    const inbox = new CaptureInbox<Body>({ dir, process: async () => {}, yieldToLoop: noYield, isOwner: () => false });
    await inbox.start();
    const { id } = await inbox.enqueue({ n: 1 }, { idempotencyKey: "../../etc/passwd" });
    expect(id).not.toMatch(/[\\/.]/);
    expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(true);
  });
});

describe("CaptureInbox lock-owner drain", () => {
  it("does not drain while not the owner, and drains once ownership is true", async () => {
    let owner = false;
    const seen: number[] = [];
    const inbox = new CaptureInbox<Body>({
      dir, process: async (i) => { seen.push(i.body.n); }, yieldToLoop: noYield, isOwner: () => owner,
    });
    await inbox.start();
    await inbox.enqueue({ n: 1 });
    await inbox.idle();
    expect(seen).toEqual([]);
    expect((await inbox.status()).pending).toBe(1);

    owner = true;
    await inbox.enqueue({ n: 2 });
    await inbox.idle();
    expect(seen).toEqual([1, 2]);
  });
});
