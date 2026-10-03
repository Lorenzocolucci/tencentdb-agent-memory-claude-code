import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../lib/hook.js";
import type { GatewayClient, RecallResult } from "../lib/gateway-client.js";
import { raiseAlarm, readAlarms } from "../lib/alarm.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tdai-ups-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    recall: vi.fn(async (): Promise<RecallResult> => ({ context: "recalled", error: null })),
    searchConversations: vi.fn(async () => ({ results: "", total: 0 })),
    captureTurn: vi.fn(async () => ({ l0_recorded: 2, scheduler_notified: true })),
    ...overrides,
  } as unknown as GatewayClient;
}

const stdinFor = (prompt: string, sid = "s1") =>
  JSON.stringify({ session_id: sid, cwd: "/tmp/p", prompt });

async function ups(client: GatewayClient, prompt: string, extra: Record<string, unknown> = {}) {
  return handleHook("user-prompt-submit", { stdin: stdinFor(prompt), client, dataDir: dir, ...extra });
}

describe("UPS: alarms survive until the output is written", () => {
  it("does not delete alarms.json while an afterWrite hook is pending", async () => {
    await raiseAlarm(dir, "capture-failed", "boom");
    const afterWrite: Array<() => Promise<void>> = [];
    const out = await ups(fakeClient(), "hi", { afterWrite });
    expect(JSON.parse(out).systemMessage).toContain("boom");
    expect(await readAlarms(dir)).toHaveLength(1);
    for (const f of afterWrite) await f();
    expect(await readAlarms(dir)).toHaveLength(0);
  });
});

describe("UPS: single deadline", () => {
  it("on expiry prints the alarm line, logs it, and does not hang", async () => {
    await raiseAlarm(dir, "capture-failed", "boom");
    const client = fakeClient({ recall: vi.fn(() => new Promise<RecallResult>(() => {})) } as Partial<GatewayClient>);
    const t0 = Date.now();
    const out = await ups(client, "hi", { upsDeadlineMs: 120 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(JSON.parse(out).systemMessage).toContain("boom");
    expect(await readFile(join(dir, "hook.log"), "utf-8")).toContain("recall: deadline exceeded");
  });

  it("on expiry with no alarm prints nothing", async () => {
    const client = fakeClient({ recall: vi.fn(() => new Promise<RecallResult>(() => {})) } as Partial<GatewayClient>);
    expect(await ups(client, "hi", { upsDeadlineMs: 100 })).toBe("");
  });
});

describe("UPS: recall-timeout alarm after 3 consecutive misses", () => {
  const timeoutClient = () =>
    fakeClient({ recall: vi.fn(async () => ({ context: "", error: "timeout" as const })) } as Partial<GatewayClient>);

  it("raises on the 3rd miss, not before", async () => {
    for (let i = 0; i < 2; i++) await ups(timeoutClient(), `p${i}`);
    expect((await readAlarms(dir)).map((a) => a.code)).not.toContain("recall-timeout");
    await ups(timeoutClient(), "p3");
    expect((await readAlarms(dir)).map((a) => a.code)).toContain("recall-timeout");
  });

  it("a success resets the counter and clears the alarm", async () => {
    for (let i = 0; i < 3; i++) await ups(timeoutClient(), `p${i}`);
    await ups(fakeClient(), "ok");
    expect((await readAlarms(dir)).map((a) => a.code)).not.toContain("recall-timeout");
    await ups(timeoutClient(), "x1");
    await ups(timeoutClient(), "x2");
    expect((await readAlarms(dir)).map((a) => a.code)).not.toContain("recall-timeout");
  });

  it("deadline expiry counts as a miss", async () => {
    const hang = () =>
      fakeClient({ recall: vi.fn(() => new Promise<RecallResult>(() => {})) } as Partial<GatewayClient>);
    for (let i = 0; i < 3; i++) await ups(hang(), `h${i}`, { upsDeadlineMs: 50 });
    expect((await readAlarms(dir)).map((a) => a.code)).toContain("recall-timeout");
  });
});

describe("UPS: fallbacks", () => {
  it("fallback 1 is skipped after a recall timeout", async () => {
    const searchConversations = vi.fn(async () => ({ results: "x", total: 1 }));
    const client = fakeClient({
      recall: vi.fn(async () => ({ context: "", error: "timeout" as const })),
      searchConversations,
    } as Partial<GatewayClient>);
    await ups(client, "q");
    expect(searchConversations).not.toHaveBeenCalled();
  });

  it("fallback 1 is skipped with <1.5 s left", async () => {
    const searchConversations = vi.fn(async () => ({ results: "x", total: 1 }));
    const client = fakeClient({
      recall: vi.fn(async () => ({ context: "", error: null })),
      searchConversations,
    } as Partial<GatewayClient>);
    await ups(client, "q", { upsDeadlineMs: 1_000 });
    expect(searchConversations).not.toHaveBeenCalled();
  });

  it("fallback 1 gets timeout = remaining - 0.3 s", async () => {
    const searchConversations = vi.fn(async (_q: string, _o?: { timeoutMs?: number }) => ({ results: "x", total: 1 }));
    const client = fakeClient({
      recall: vi.fn(async () => ({ context: "", error: null })),
      searchConversations,
    } as Partial<GatewayClient>);
    await ups(client, "q", { upsDeadlineMs: 5_800 });
    const t = searchConversations.mock.calls[0][1]?.timeoutMs ?? 0;
    expect(t).toBeGreaterThan(5_000);
    expect(t).toBeLessThanOrEqual(5_500);
  });

  it("fallback 2 reads the RESOLVED dataDir (not TDAI_DATA_DIR) and runs after a timeout", async () => {
    const conv = join(dir, "conversations");
    await mkdir(conv, { recursive: true });
    const sessionKey = "sk-fb2";
    await writeFile(
      join(conv, "2026-10-01.jsonl"),
      JSON.stringify({ sessionKey, role: "assistant", content: "kubernetes operator notes", recordedAt: "t" }),
    );
    vi.stubEnv("TDAI_SESSION_KEY", sessionKey);
    vi.stubEnv("TDAI_DATA_DIR", join(dir, "does-not-exist"));
    const client = fakeClient({
      recall: vi.fn(async () => ({ context: "", error: "timeout" as const })),
    } as Partial<GatewayClient>);
    const out = await ups(client, "kubernetes operator");
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("kubernetes operator notes");
  });

  it("fallback 2 only scans the newest 3 files", async () => {
    const conv = join(dir, "conversations");
    await mkdir(conv, { recursive: true });
    const sessionKey = "sk-fb2b";
    vi.stubEnv("TDAI_SESSION_KEY", sessionKey);
    const { utimes } = await import("node:fs/promises");
    for (let i = 0; i < 5; i++) {
      const f = join(conv, `f${i}.jsonl`);
      await writeFile(f, JSON.stringify({ sessionKey, role: "user", content: `needle-${i} here`, recordedAt: "t" }));
      const when = new Date(Date.now() - (5 - i) * 60_000); // f4 newest
      await utimes(f, when, when);
    }
    const client = fakeClient({
      recall: vi.fn(async () => ({ context: "", error: "timeout" as const })),
    } as Partial<GatewayClient>);
    const out = JSON.parse(await ups(client, "needle"));
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("needle-4");
    expect(ctx).toContain("needle-2");
    expect(ctx).not.toContain("needle-1");
    expect(ctx).not.toContain("needle-0");
  });
});

describe("UPS: recall is skipped for automated prompts", () => {
  it.each([
    ["<task-notification>done</task-notification>"],
    ["Another Claude session sent a message: ping"],
  ])("skips %s but still prints alarms", async (prompt) => {
    await raiseAlarm(dir, "capture-failed", "boom");
    const client = fakeClient();
    const out = await ups(client, prompt);
    expect(client.recall).not.toHaveBeenCalled();
    expect(JSON.parse(out).systemMessage).toContain("boom");
  });

  it("skips an identical prompt in the same session within 15 min, not a different one", async () => {
    const client = fakeClient();
    await ups(client, "cron tick");
    expect(client.recall).toHaveBeenCalledTimes(1);
    const out = await ups(client, "cron tick");
    expect(client.recall).toHaveBeenCalledTimes(1);
    expect(out).toBe("");
    await ups(client, "something else");
    expect(client.recall).toHaveBeenCalledTimes(2);
  });

  it("an identical prompt in ANOTHER session still recalls", async () => {
    const client = fakeClient();
    await ups(client, "same text");
    await handleHook("user-prompt-submit", { stdin: stdinFor("same text", "other"), client, dataDir: dir });
    expect(client.recall).toHaveBeenCalledTimes(2);
  });
});

describe("Stop: capture contract", () => {
  async function runStop(client: GatewayClient) {
    const tp = join(dir, "t.jsonl");
    await writeFile(
      tp,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } }),
      ].join("\n"),
    );
    const stdin = JSON.stringify({ session_id: "sess-1", transcript_path: tp, cwd: "/tmp/p" });
    return handleHook("stop", { stdin, client, dataDir: dir });
  }

  it("sends idempotency_key = sha1(session_id:lastSent:turns)", async () => {
    const captureTurn = vi.fn(async (_p: { idempotency_key?: string }) => ({ l0_recorded: 2, scheduler_notified: true }));
    await runStop(fakeClient({ captureTurn } as Partial<GatewayClient>));
    const key = captureTurn.mock.calls[0][0].idempotency_key;
    expect(key).toBe(createHash("sha1").update("sess-1:0:1").digest("hex"));
  });

  it("failure alarm says the save is unconfirmed and will be retried", async () => {
    await runStop(fakeClient({ captureTurn: vi.fn(async () => null) } as Partial<GatewayClient>));
    const [alarm] = await readAlarms(dir);
    expect(alarm.message).toContain("salvataggio non confermato — verrà ritentato");
    expect(alarm.message).not.toContain("persi");
  });
});
