import { describe, it, expect, vi } from "vitest";
import { handleHook } from "../lib/hook.js";
import type { GatewayClient, RecallResult } from "../lib/gateway-client.js";

function makeFakeClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    health: vi.fn(async () => true),
    recall: vi.fn(async (): Promise<RecallResult> => ({ context: "recalled" })),
    captureTurn: vi.fn(async () => ({ l0_recorded: 1, scheduler_notified: true })),
    searchMemories: vi.fn(async () => ({ results: "m", total: 1 })),
    searchConversations: vi.fn(async () => ({ results: "c", total: 1 })),
    sessionEnd: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GatewayClient;
}

describe("handleHook: user-prompt-submit", () => {
  it("emits hookSpecificOutput with additionalContext from /recall", async () => {
    const client = makeFakeClient();
    const stdin = JSON.stringify({
      session_id: "s1",
      cwd: "/tmp/proj",
      prompt: "what did we do?",
    });
    const out = await handleHook("user-prompt-submit", { stdin, client });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("recalled");
  });

  it("truncates additionalContext over 10000 chars", async () => {
    const big = "x".repeat(20_000);
    const client = makeFakeClient({
      recall: vi.fn(async () => ({ context: big })),
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "q" });
    const out = await handleHook("user-prompt-submit", { stdin, client });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("truncated");
  });

  it("emits empty string when recall returns no context", async () => {
    const client = makeFakeClient({
      recall: vi.fn(async () => ({ context: "" })),
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "q" });
    const out = await handleHook("user-prompt-submit", { stdin, client });
    expect(out).toBe("");
  });
});

describe("handleHook: stop", () => {
  it("exits silently when stop_hook_active is true", async () => {
    const captureTurn = vi.fn();
    const client = makeFakeClient({
      captureTurn,
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({
      session_id: "s",
      transcript_path: "/tmp/t.jsonl",
      stop_hook_active: true,
    });
    const out = await handleHook("stop", { stdin, client });
    expect(out).toBe("");
    expect(captureTurn).not.toHaveBeenCalled();
  });

  it("calls captureTurn when stop_hook_active is false", async () => {
    const captureTurn = vi.fn(async () => null);
    const client = makeFakeClient({
      captureTurn,
    } as Partial<GatewayClient>);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = path.join(os.tmpdir(), `tx-${Date.now()}.jsonl`);
    await fs.writeFile(
      tmp,
      [
        '{"type":"user","message":{"role":"user","content":"q"},"uuid":"u"}',
        '{"type":"assistant","message":{"role":"assistant","content":"a"},"uuid":"a"}',
      ].join("\n"),
    );
    try {
      const stdin = JSON.stringify({
        session_id: "s",
        transcript_path: tmp,
        cwd: "/tmp/proj",
        stop_hook_active: false,
      });
      await handleHook("stop", { stdin, client });
      expect(captureTurn).toHaveBeenCalledOnce();
      const call = captureTurn.mock.calls[0][0];
      expect(call.user_content).toBe("q");
      expect(call.assistant_content).toBe("a");
    } finally {
      await fs.unlink(tmp);
    }
  });
});

describe("handleHook: post-tool-use", () => {
  it("fire-and-forget — does not throw on success", async () => {
    const client = makeFakeClient();
    const stdin = JSON.stringify({
      session_id: "s",
      tool_name: "Read",
      tool_use_id: "t1",
    });
    await expect(
      handleHook("post-tool-use", { stdin, client }),
    ).resolves.not.toThrow();
  });
});

describe("handleHook: session-start", () => {
  it("invokes health probe, succeeds silently", async () => {
    const client = makeFakeClient();
    const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", source: "startup" });
    await expect(
      handleHook("session-start", { stdin, client }),
    ).resolves.not.toThrow();
  });
});

describe("handleHook: search (slash command)", () => {
  it("returns formatted memory search output", async () => {
    const client = makeFakeClient({
      searchMemories: vi.fn(async () => ({ results: "MEMORY_RESULTS", total: 3 })),
    } as Partial<GatewayClient>);
    const out = await handleHook("search", { stdin: "", client, args: ["my", "query"] });
    expect(out).toContain("MEMORY_RESULTS");
  });
});

describe("handleHook: invalid event", () => {
  it("returns empty string on unknown event", async () => {
    const client = makeFakeClient();
    const out = await handleHook("nonsense" as never, {
      stdin: "{}",
      client,
    });
    expect(out).toBe("");
  });
});
