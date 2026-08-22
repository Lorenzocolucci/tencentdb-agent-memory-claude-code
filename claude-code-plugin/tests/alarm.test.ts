/**
 * NO SILENT FAILURE — tests for the alarm channel and for the three tripwires
 * wired into the hook. Each test names the real outage it would have caught.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raiseAlarm, clearAlarm, drainAlarms, readAlarms, ALARM_FILE } from "../lib/alarm.js";
import { handleHook } from "../lib/hook.js";
import type { GatewayClient, RecallResult } from "../lib/gateway-client.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tdai-alarm-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeFakeClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    health: vi.fn(async () => true),
    // Staleness tripwire (2026-08-22) reads /health's body.
    healthDetailed: vi.fn(async () => ({ last_capture_at: new Date().toISOString() })),
    recall: vi.fn(async (): Promise<RecallResult> => ({ context: "" })),
    captureTurn: vi.fn(async () => ({ l0_recorded: 1, scheduler_notified: true })),
    observe: vi.fn(async () => ""),
    searchMemories: vi.fn(async () => ({ results: "", total: 0 })),
    searchConversations: vi.fn(async () => ({ results: "", total: 0 })),
    sessionEnd: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GatewayClient;
}

async function writeTranscript(): Promise<string> {
  const p = join(dir, "t.jsonl");
  await writeFile(
    p,
    [
      '{"type":"user","message":{"role":"user","content":"q"},"uuid":"u"}',
      '{"type":"assistant","message":{"role":"assistant","content":"a"},"uuid":"a"}',
    ].join("\n"),
  );
  return p;
}

describe("alarm store", () => {
  it("collapses repeats of the same code into one record with a counter", async () => {
    await raiseAlarm(dir, "gateway-unreachable", "giù", new Date("2026-08-13T08:00:00Z"));
    await raiseAlarm(dir, "gateway-unreachable", "giù", new Date("2026-08-14T08:00:00Z"));
    await raiseAlarm(dir, "gateway-unreachable", "giù", new Date("2026-08-15T08:00:00Z"));
    const all = await readAlarms(dir);
    expect(all).toHaveLength(1);
    expect(all[0].count).toBe(3);
    expect(all[0].firstSeen).toContain("2026-08-13");
  });

  it("keeps distinct codes separate and renders them in one line", async () => {
    await raiseAlarm(dir, "data-dir-lost", "cartella persa");
    await raiseAlarm(dir, "capture-failed", "sessione non salvata");
    const line = await drainAlarms(dir);
    expect(line).toContain("cartella persa");
    expect(line).toContain("sessione non salvata");
    expect(line).toContain("SINAPSYS");
  });

  it("drain clears the store so an alarm is shown once, not forever", async () => {
    await raiseAlarm(dir, "capture-failed", "x");
    expect(await drainAlarms(dir)).not.toBe("");
    expect(await drainAlarms(dir)).toBe("");
  });

  it("returns empty when healthy and never throws on a corrupt store", async () => {
    expect(await drainAlarms(dir)).toBe("");
    await writeFile(join(dir, ALARM_FILE), "{not json");
    expect(await readAlarms(dir)).toEqual([]);
    expect(await drainAlarms(dir)).toBe("");
  });

  it("clearAlarm removes only its own code", async () => {
    await raiseAlarm(dir, "data-dir-lost", "a");
    await raiseAlarm(dir, "capture-failed", "b");
    await clearAlarm(dir, "data-dir-lost");
    const all = await readAlarms(dir);
    expect(all.map((a) => a.code)).toEqual(["capture-failed"]);
  });
});

describe("tripwire: gateway unreachable (the 2026-08-13 → 08-18 outage)", () => {
  it("session-start raises an alarm when /health is unreachable", async () => {
    const client = makeFakeClient({
      health: vi.fn(async () => false),
      healthDetailed: vi.fn(async () => null),
    } as Partial<GatewayClient>);
    await handleHook("session-start", { stdin: "{}", client, dataDir: dir });
    const all = await readAlarms(dir);
    expect(all.map((a) => a.code)).toContain("gateway-unreachable");
  });

  it("session-start clears the alarm once the gateway answers again", async () => {
    await raiseAlarm(dir, "gateway-unreachable", "giù");
    const client = makeFakeClient();
    await handleHook("session-start", { stdin: "{}", client, dataDir: dir });
    expect(await readAlarms(dir)).toEqual([]);
  });
});

describe("tripwire: capture did not persist", () => {
  it("raises capture-failed and does NOT advance the cursor when capture returns null", async () => {
    const client = makeFakeClient({
      captureTurn: vi.fn(async () => null),
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({
      session_id: "s",
      transcript_path: await writeTranscript(),
      cwd: "/tmp/proj",
      stop_hook_active: false,
    });
    await handleHook("stop", { stdin, client, dataDir: dir });
    expect((await readAlarms(dir)).map((a) => a.code)).toContain("capture-failed");
    await expect(readFile(join(dir, "cursors", "s.json"), "utf-8")).rejects.toThrow();
  });

  it("raises capture-empty when the gateway answers OK but wrote 0 rows", async () => {
    const client = makeFakeClient({
      captureTurn: vi.fn(async () => ({ l0_recorded: 0, scheduler_notified: false })),
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({
      session_id: "s",
      transcript_path: await writeTranscript(),
      cwd: "/tmp/proj",
      stop_hook_active: false,
    });
    await handleHook("stop", { stdin, client, dataDir: dir });
    expect((await readAlarms(dir)).map((a) => a.code)).toContain("capture-empty");
    // Cursor must not advance, or the turns would be lost forever.
    await expect(readFile(join(dir, "cursors", "s.json"), "utf-8")).rejects.toThrow();
  });

  it("a successful capture clears previous capture alarms", async () => {
    await raiseAlarm(dir, "capture-failed", "vecchio");
    const client = makeFakeClient();
    const stdin = JSON.stringify({
      session_id: "s",
      transcript_path: await writeTranscript(),
      cwd: "/tmp/proj",
      stop_hook_active: false,
    });
    await handleHook("stop", { stdin, client, dataDir: dir });
    expect(await readAlarms(dir)).toEqual([]);
  });
});

describe("delivery: the user actually sees it", () => {
  it("user-prompt-submit surfaces pending alarms as a systemMessage", async () => {
    await raiseAlarm(dir, "capture-failed", "sessione NON salvata");
    const client = makeFakeClient();
    const out = await handleHook("user-prompt-submit", {
      stdin: JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "ciao" }),
      client,
      dataDir: dir,
    });
    expect(out).not.toBe("");
    expect(JSON.parse(out).systemMessage).toContain("sessione NON salvata");
  });

  it("an alarm outranks the 'I remember you' banner — no false reassurance", async () => {
    await raiseAlarm(dir, "capture-failed", "sessione NON salvata");
    const client = makeFakeClient({
      recall: vi.fn(async () => ({
        context: "<session-open-banner>\n🧠 mi ricordo di te\n</session-open-banner>\nresto",
      })),
    } as Partial<GatewayClient>);
    const out = await handleHook("user-prompt-submit", {
      stdin: JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "ciao" }),
      client,
      dataDir: dir,
    });
    const parsed = JSON.parse(out);
    expect(parsed.systemMessage).toContain("sessione NON salvata");
    expect(parsed.systemMessage).not.toContain("mi ricordo di te");
    // The recall context itself is still delivered to the model.
    expect(parsed.hookSpecificOutput.additionalContext).toContain("resto");
  });

  it("stays silent when everything is healthy", async () => {
    const client = makeFakeClient({
      recall: vi.fn(async () => ({ context: "roba" })),
    } as Partial<GatewayClient>);
    const out = await handleHook("user-prompt-submit", {
      stdin: JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "ciao" }),
      client,
      dataDir: dir,
    });
    expect(JSON.parse(out).systemMessage).toBeUndefined();
  });
});
