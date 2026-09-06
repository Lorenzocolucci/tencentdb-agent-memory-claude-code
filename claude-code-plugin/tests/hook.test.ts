import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../lib/hook.js";
import type { GatewayClient, RecallResult } from "../lib/gateway-client.js";

type ObservePayload = Parameters<GatewayClient["observe"]>[0];
/** A typed observe fake so `mock.calls[0][0]` is the payload, not `undefined`. */
function fakeObserve(result = "") {
  return vi.fn(async (_p: ObservePayload) => result);
}

function makeFakeClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    health: vi.fn(async () => true),
    // Staleness tripwire (2026-08-22) reads /health's body.
    healthDetailed: vi.fn(async () => ({
      status: "ok" as const,
      embedding: "ok" as const,
      last_capture_at: new Date().toISOString(),
      reachable: true,
    })),
    recall: vi.fn(async (): Promise<RecallResult> => ({ context: "recalled" })),
    captureTurn: vi.fn(async () => ({ l0_recorded: 1, scheduler_notified: true })),
    // Friction capture (2026-08-07): handlePostToolUse calls client.observe.
    // The fake was never given one, so post-tool-use threw "not a function".
    observe: vi.fn(async () => ""),
    searchMemories: vi.fn(async () => ({ results: "m", total: 1 })),
    searchConversations: vi.fn(async () => ({ results: "c", total: 1 })),
    sessionEnd: vi.fn(async () => {}),
    // Grounded-trust confirm/reject from Claude Code (2026-09-05).
    resolveGatedMemory: vi.fn(async () => ({ ok: true, text: "applied" })),
    ...overrides,
  } as unknown as GatewayClient;
}

/**
 * A captureTurn fake that reports a REAL write. `async () => null` means
 * "capture failed" to the implementation, which then deliberately does not
 * advance the cursor — so a fake returning null can never satisfy a test about
 * cursor progress. Assertions are unchanged; only the fake tells the truth.
 */
function fakeCaptureOk() {
  return vi.fn(async () => ({ l0_recorded: 2, scheduler_notified: true }));
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

  it("emits empty string when all fallbacks return nothing (no TDAI_DATA_DIR)", async () => {
    const orig = process.env.TDAI_DATA_DIR;
    delete process.env.TDAI_DATA_DIR;
    try {
      const client = makeFakeClient({
        recall: vi.fn(async () => ({ context: "" })),
        searchConversations: vi.fn(async () => ({ results: "", total: 0 })),
      } as Partial<GatewayClient>);
      const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "q" });
      const out = await handleHook("user-prompt-submit", { stdin, client });
      expect(out).toBe("");
    } finally {
      if (orig !== undefined) process.env.TDAI_DATA_DIR = orig;
    }
  });

  it("falls back to L0 jsonl direct search when daemon search returns nothing", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = path.join(os.tmpdir(), `tdai-hook-test-${Date.now()}`);
    const convDir = path.join(tmpDir, "conversations");
    await fs.mkdir(convDir, { recursive: true });

    const sessionKey = "abc123";
    const records = [
      JSON.stringify({ sessionKey, role: "user", content: "我用 Go 写 Kubernetes operator", recordedAt: "2026-05-15T06:00:00Z" }),
      JSON.stringify({ sessionKey, role: "assistant", content: "K8s operator 用 Go 是主流", recordedAt: "2026-05-15T06:00:01Z" }),
      JSON.stringify({ sessionKey: "other", role: "user", content: "unrelated stuff", recordedAt: "2026-05-15T06:00:02Z" }),
    ];
    await fs.writeFile(path.join(convDir, "2026-05-15.jsonl"), records.join("\n"));

    const orig = process.env.TDAI_DATA_DIR;
    process.env.TDAI_DATA_DIR = tmpDir;
    try {
      const client = makeFakeClient({
        recall: vi.fn(async () => ({ context: "" })),
        searchConversations: vi.fn(async () => ({ results: "", total: 0 })),
      } as Partial<GatewayClient>);
      // sessionKey in getSessionKey("/tmp/p") won't match "abc123", so we
      // need cwd that hashes to "abc123" — easier: just mock getSessionKey.
      // Instead, directly use a prompt that matches and set cwd so sessionKey
      // matches the records. We'll use TDAI_SESSION_KEY override.
      const origSK = process.env.TDAI_SESSION_KEY;
      process.env.TDAI_SESSION_KEY = sessionKey;
      try {
        const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "K8s operator" });
        const out = await handleHook("user-prompt-submit", { stdin, client });
        expect(out).not.toBe("");
        const parsed = JSON.parse(out);
        expect(parsed.hookSpecificOutput.additionalContext).toContain("Past conversations");
        expect(parsed.hookSpecificOutput.additionalContext).toContain("Kubernetes operator");
        // "unrelated stuff" from other session should NOT appear
        expect(parsed.hookSpecificOutput.additionalContext).not.toContain("unrelated");
      } finally {
        if (origSK !== undefined) process.env.TDAI_SESSION_KEY = origSK;
        else delete process.env.TDAI_SESSION_KEY;
      }
    } finally {
      if (orig !== undefined) process.env.TDAI_DATA_DIR = orig;
      else delete process.env.TDAI_DATA_DIR;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to L0 conversation search when /recall returns empty context", async () => {
    const searchConversations = vi.fn(async () => ({
      results: "Found 1 matching message(s):\n---\n**[user]** ...",
      total: 1,
    }));
    const client = makeFakeClient({
      recall: vi.fn(async () => ({ context: "" })),
      searchConversations,
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "k8s operator" });
    const out = await handleHook("user-prompt-submit", { stdin, client });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Past conversations");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Found 1 matching");
    // L0 fallback should be scoped to the current project (sessionKey).
    const call = searchConversations.mock.calls[0];
    expect(call[1]?.sessionKey).toBeTruthy();
    expect(call[1]?.limit).toBe(3);
  });

  it("skips L0 fallback when /recall already returns context", async () => {
    const searchConversations = vi.fn(async () => ({ results: "should-not-be-called", total: 1 }));
    const client = makeFakeClient({
      recall: vi.fn(async () => ({ context: "primary-recall" })),
      searchConversations,
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "q" });
    const out = await handleHook("user-prompt-submit", { stdin, client });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toBe("primary-recall");
    expect(searchConversations).not.toHaveBeenCalled();
  });
});

describe("handleHook: stop", () => {
  // Stop now persists a per-session cursor to $CLAUDE_PLUGIN_DATA/cursors/.
  // Isolate it to a tmpdir per test so cursor state never leaks across runs
  // (a previously-written cursor would make the next run see lastSent>0 and
  // suppress the captureTurn call this test asserts on).
  let cursorDir: string;
  beforeEach(async () => {
    cursorDir = await mkdtemp(join(tmpdir(), "tdai-stop-cursor-"));
    vi.stubEnv("CLAUDE_PLUGIN_DATA", cursorDir);
  });
  afterEach(async () => {
    await rm(cursorDir, { recursive: true, force: true });
  });

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
    const out = await handleHook("stop", { stdin, client, dataDir: cursorDir });
    expect(out).toBe("");
    expect(captureTurn).not.toHaveBeenCalled();
  });

  it("calls captureTurn when stop_hook_active is false", async () => {
    const captureTurn = fakeCaptureOk();
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
      await handleHook("stop", { stdin, client, dataDir: cursorDir });
      expect(captureTurn).toHaveBeenCalledOnce();
      const call = captureTurn.mock.calls[0][0];
      expect(call.user_content).toBe("q");
      expect(call.assistant_content).toBe("a");
    } finally {
      await fs.unlink(tmp);
    }
  });

  it("only sends new turns on the second Stop (cursor incremental capture)", async () => {
    // Two-turn transcript, fire Stop once. Then append a third turn and fire
    // Stop again. The second call must POST only the new turn — without the
    // cursor a long session would re-write every turn on each Stop.
    const captureTurn = fakeCaptureOk();
    const client = makeFakeClient({
      captureTurn,
    } as Partial<GatewayClient>);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = path.join(os.tmpdir(), `tx-cursor-${Date.now()}.jsonl`);
    const lines = [
      '{"type":"user","message":{"role":"user","content":"q1"},"uuid":"u1"}',
      '{"type":"assistant","message":{"role":"assistant","content":"a1"},"uuid":"a1"}',
      '{"type":"user","message":{"role":"user","content":"q2"},"uuid":"u2"}',
      '{"type":"assistant","message":{"role":"assistant","content":"a2"},"uuid":"a2"}',
    ];
    await fs.writeFile(tmp, lines.join("\n"));
    try {
      const stdin = JSON.stringify({
        session_id: "cursor-test",
        transcript_path: tmp,
        cwd: "/tmp/proj",
        stop_hook_active: false,
      });
      await handleHook("stop", { stdin, client, dataDir: cursorDir });
      expect(captureTurn).toHaveBeenCalledTimes(1);
      const first = captureTurn.mock.calls[0][0];
      expect(first.messages).toHaveLength(4); // 2 turns × (user + assistant)

      // Append a third turn and fire Stop again.
      await fs.appendFile(
        tmp,
        "\n" +
          [
            '{"type":"user","message":{"role":"user","content":"q3"},"uuid":"u3"}',
            '{"type":"assistant","message":{"role":"assistant","content":"a3"},"uuid":"a3"}',
          ].join("\n"),
      );
      await handleHook("stop", { stdin, client, dataDir: cursorDir });
      expect(captureTurn).toHaveBeenCalledTimes(2);
      const second = captureTurn.mock.calls[1][0];
      // Cursor should have skipped the first 2 turns — only q3/a3 sent.
      expect(second.messages).toHaveLength(2);
      expect(second.user_content).toBe("q3");
      expect(second.assistant_content).toBe("a3");
    } finally {
      await fs.unlink(tmp);
    }
  });

  it("skips captureTurn when no new turns since last cursor", async () => {
    const captureTurn = fakeCaptureOk();
    const client = makeFakeClient({
      captureTurn,
    } as Partial<GatewayClient>);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = path.join(os.tmpdir(), `tx-nochange-${Date.now()}.jsonl`);
    await fs.writeFile(
      tmp,
      [
        '{"type":"user","message":{"role":"user","content":"q"},"uuid":"u"}',
        '{"type":"assistant","message":{"role":"assistant","content":"a"},"uuid":"a"}',
      ].join("\n"),
    );
    try {
      const stdin = JSON.stringify({
        session_id: "nochange-test",
        transcript_path: tmp,
        cwd: "/tmp/proj",
        stop_hook_active: false,
      });
      await handleHook("stop", { stdin, client, dataDir: cursorDir });
      await handleHook("stop", { stdin, client, dataDir: cursorDir });
      // Second Stop sees the same transcript → cursor already at end → no call.
      expect(captureTurn).toHaveBeenCalledTimes(1);
    } finally {
      await fs.unlink(tmp);
    }
  });

  it("caps first capture at MAX_CAPTURE_TURNS (50) when transcript is long", async () => {
    const captureTurn = fakeCaptureOk();
    const client = makeFakeClient({
      captureTurn,
    } as Partial<GatewayClient>);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = path.join(os.tmpdir(), `tx-cap-${Date.now()}.jsonl`);
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(`{"type":"user","message":{"role":"user","content":"q${i}"},"uuid":"u${i}"}`);
      lines.push(`{"type":"assistant","message":{"role":"assistant","content":"a${i}"},"uuid":"a${i}"}`);
    }
    await fs.writeFile(tmp, lines.join("\n"));
    try {
      const stdin = JSON.stringify({
        session_id: "cap-test",
        transcript_path: tmp,
        cwd: "/tmp/proj",
        stop_hook_active: false,
      });
      await handleHook("stop", { stdin, client, dataDir: cursorDir });
      expect(captureTurn).toHaveBeenCalledTimes(1);
      const call = captureTurn.mock.calls[0][0];
      // Capped at 50 turns × (user + assistant) = 100 messages.
      expect(call.messages).toHaveLength(100);
      // Cap takes the LAST 50 turns; lastTurn is q59/a59.
      expect(call.user_content).toBe("q59");
      expect(call.assistant_content).toBe("a59");
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

describe("handleHook: post-tool-use — destructive command on SUCCESS", () => {
  it("tags a successful destructive Bash command and forwards ≤400 chars of its output", async () => {
    const observe = fakeObserve();
    const client = makeFakeClient({ observe } as Partial<GatewayClient>);
    const longOutput = "x".repeat(1_000);
    const stdin = JSON.stringify({
      session_id: "s",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "git worktree remove ../wt" },
      tool_response: longOutput,
    });
    await handleHook("post-tool-use", { stdin, client });
    expect(observe).toHaveBeenCalledTimes(1);
    const payload = observe.mock.calls[0][0];
    expect(payload.toolName).toBe("Bash");
    expect(payload.toolRisk).toBe("destructive");
    expect(payload.toolOutputIsError).toBeUndefined();
    expect(payload.toolOutputText?.length).toBe(400);
  });

  it("sends no tool_risk for an ordinary Bash success", async () => {
    const observe = fakeObserve();
    const client = makeFakeClient({ observe } as Partial<GatewayClient>);
    const stdin = JSON.stringify({
      session_id: "s",
      tool_name: "Bash",
      tool_input: { command: "git worktree list" },
      tool_response: "C:/x  abc [main]",
    });
    await handleHook("post-tool-use", { stdin, client });
    const payload = observe.mock.calls[0][0];
    expect(payload.toolRisk).toBeUndefined();
    expect(payload.toolOutputText).toBeUndefined();
  });

  it("never tags a non-Bash tool even if its input mentions a destructive command", async () => {
    const observe = fakeObserve();
    const client = makeFakeClient({ observe } as Partial<GatewayClient>);
    const stdin = JSON.stringify({
      session_id: "s",
      tool_name: "Write",
      tool_input: { file_path: "cleanup.sh", command: "rm -rf build" },
      tool_response: { success: true },
    });
    await handleHook("post-tool-use", { stdin, client });
    const payload = observe.mock.calls[0][0];
    expect(payload.toolRisk).toBeUndefined();
  });
});

describe("handleHook: post-tool-use-failure", () => {
  it("reaches observe with toolOutputIsError true and the error text", async () => {
    const observe = fakeObserve();
    const client = makeFakeClient({ observe } as Partial<GatewayClient>);
    // Shape of Claude Code 2.1.198's PostToolUseFailure stdin.
    const stdin = JSON.stringify({
      session_id: "s",
      cwd: "/tmp/proj",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_use_id: "toolu_1",
      error: "Exit code 2\nsrc/x.ts(3,1): error TS2304: Cannot find name 'foo'.",
      error_type: "tool_error",
      is_interrupt: false,
      duration_ms: 1234,
    });
    const out = await handleHook("post-tool-use-failure", { stdin, client });
    expect(out).toBe("");
    expect(observe).toHaveBeenCalledTimes(1);
    const payload = observe.mock.calls[0][0];
    expect(payload.toolName).toBe("Bash");
    expect(payload.toolInput).toEqual({ command: "npm run build" });
    expect(payload.toolOutputIsError).toBe(true);
    expect(payload.toolOutputText).toContain("error TS2304");
    expect(payload.toolRisk).toBeUndefined();
  });

  it("bounds the error text to 2000 chars and falls back to error_type when error is empty", async () => {
    const observe = fakeObserve();
    const client = makeFakeClient({ observe } as Partial<GatewayClient>);
    await handleHook("post-tool-use-failure", {
      stdin: JSON.stringify({ tool_name: "Edit", tool_input: {}, error: "e".repeat(5_000) }),
      client,
    });
    expect(observe.mock.calls[0][0].toolOutputText?.length).toBe(2_000);

    await handleHook("post-tool-use-failure", {
      stdin: JSON.stringify({ tool_name: "Edit", tool_input: {}, error: "", error_type: "timeout" }),
      client,
    });
    expect(observe.mock.calls[1][0].toolOutputText).toBe("timeout");
  });

  it("renders the gateway's context as PostToolUseFailure additionalContext", async () => {
    const client = makeFakeClient({
      observe: vi.fn(async () => "⚠️ LOOP: 3× same failure"),
    } as Partial<GatewayClient>);
    const out = await handleHook("post-tool-use-failure", {
      stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "x" }, error: "boom" }),
      client,
    });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("LOOP");
  });

  it("skips a user interrupt (not friction) and a payload without tool_name", async () => {
    const observe = fakeObserve();
    const client = makeFakeClient({ observe } as Partial<GatewayClient>);
    await handleHook("post-tool-use-failure", {
      stdin: JSON.stringify({ tool_name: "Bash", tool_input: {}, error: "x", is_interrupt: true }),
      client,
    });
    await handleHook("post-tool-use-failure", { stdin: JSON.stringify({ error: "x" }), client });
    expect(observe).not.toHaveBeenCalled();
  });
});

describe("handleHook: confirm / reject (grounded trust)", () => {
  it("confirm reads the id from stdin, infers fact kind, prints the gateway text", async () => {
    const resolveGatedMemory = vi.fn(async () => ({ ok: true, text: "Memoria confermata." }));
    const client = makeFakeClient({ resolveGatedMemory } as Partial<GatewayClient>);
    const out = await handleHook("confirm", { stdin: "fact_01KWT3SMSB0000M87KKS\n", client });
    expect(resolveGatedMemory).toHaveBeenCalledWith("confirm", "fact_01KWT3SMSB0000M87KKS", "fact");
    expect(out).toBe("Memoria confermata.");
  });

  it("reject infers event kind from the event_ prefix", async () => {
    const resolveGatedMemory = vi.fn(async () => ({ ok: true, text: "Memoria rifiutata." }));
    const client = makeFakeClient({ resolveGatedMemory } as Partial<GatewayClient>);
    const out = await handleHook("reject", { stdin: "  event_01ABCDEF  ", client });
    expect(resolveGatedMemory).toHaveBeenCalledWith("reject", "event_01ABCDEF", "event");
    expect(out).toBe("Memoria rifiutata.");
  });

  it("refuses an id with an unknown prefix without calling the gateway", async () => {
    const resolveGatedMemory = vi.fn(async () => ({ ok: true, text: "x" }));
    const client = makeFakeClient({ resolveGatedMemory } as Partial<GatewayClient>);
    const out = await handleHook("confirm", { stdin: "01KWT3SMSB0000M87KKS", client });
    expect(resolveGatedMemory).not.toHaveBeenCalled();
    expect(out).toContain('"fact_" or "event_"');
    expect(out).toContain("01KWT3SMSB0000M87KKS");
  });

  it("refuses an id that carries shell-looking characters (stdin is data, not a command)", async () => {
    const resolveGatedMemory = vi.fn(async () => ({ ok: true, text: "x" }));
    const client = makeFakeClient({ resolveGatedMemory } as Partial<GatewayClient>);
    const out = await handleHook("reject", { stdin: "fact_01ABC; rm -rf /", client });
    expect(resolveGatedMemory).not.toHaveBeenCalled();
    expect(out).toContain("Cannot reject");
  });

  it("prints a usage line on empty stdin", async () => {
    const client = makeFakeClient();
    const out = await handleHook("confirm", { stdin: "   ", client });
    expect(out).toContain("Usage");
    expect(out).toContain("/memory-confirm");
  });

  it("says NOT applied when the gateway is unreachable (null)", async () => {
    const client = makeFakeClient({
      resolveGatedMemory: vi.fn(async () => null),
    } as Partial<GatewayClient>);
    const out = await handleHook("confirm", { stdin: "fact_01ABC", client });
    expect(out).toContain("NOT applied");
    expect(out).toContain("fact_01ABC");
  });

  it("surfaces the 409 text when the store could not apply", async () => {
    const client = makeFakeClient({
      resolveGatedMemory: vi.fn(async () => ({ ok: false, text: "Nessuna memoria in attesa." })),
    } as Partial<GatewayClient>);
    const out = await handleHook("reject", { stdin: "fact_01ABC", client });
    expect(out).toBe("Nessuna memoria in attesa.");
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
