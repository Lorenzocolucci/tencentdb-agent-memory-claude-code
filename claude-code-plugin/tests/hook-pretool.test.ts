import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../lib/hook.js";
import { GatewayClient, type PretoolAnswer } from "../lib/gateway-client.js";
import { readAlarms } from "../lib/alarm.js";

let dir: string;
let server: http.Server | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tdai-pretool-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const CWD = join(tmpdir(), "my-project");

function client(pretool: (p: unknown) => Promise<PretoolAnswer | null>, observe = vi.fn(async () => "")): GatewayClient {
  return { pretool: vi.fn(pretool), observe } as unknown as GatewayClient;
}
const stdin = (toolName: string, toolInput: unknown) =>
  JSON.stringify({ session_id: "s1", cwd: CWD, tool_name: toolName, tool_input: toolInput });
const run = (c: GatewayClient, toolName: string, toolInput: unknown, extra: Record<string, unknown> = {}) =>
  handleHook("pre-tool-use", { stdin: stdin(toolName, toolInput), client: c, dataDir: dir, ...extra });

describe("PreToolUse hook (4.1)", () => {
  it("prints a warning as hookSpecificOutput.additionalContext", async () => {
    const c = client(async () => ({ decision: "warn", message: "Memory warning — x (lesson id les_1)", lessonId: "les_1" }));
    const out = JSON.parse(await run(c, "Edit", { file_path: "a.ts" }));
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "Memory warning — x (lesson id les_1)" },
    });
  });

  it("prints a stance-interrupt as permissionDecision deny + reason", async () => {
    const c = client(async () => ({ decision: "deny", message: "Memory stop: …", lessonId: "les_2" }));
    const out = JSON.parse(await run(c, "Bash", { command: "rm -rf dist" }));
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Memory stop: …",
    });
  });

  it("sends project (basename of cwd), cwd, and the one-way label from destructive-commands", async () => {
    const pretool = vi.fn(async (_p: unknown) => null);
    const c = { pretool } as unknown as GatewayClient;
    await run(c, "Bash", { command: "git reset --hard HEAD~1" });
    expect(pretool).toHaveBeenCalledWith(expect.objectContaining({
      project: "my-project", cwd: CWD, toolName: "Bash", oneWay: "git reset --hard",
    }));
    await run(c, "Bash", { command: "git status" });
    expect(pretool).toHaveBeenLastCalledWith(expect.objectContaining({ oneWay: null }));
    await run(c, "Edit", { file_path: "a.ts" });
    expect(pretool).toHaveBeenLastCalledWith(expect.objectContaining({ oneWay: null }));
  });

  it("silent when memory has nothing to say", async () => {
    expect(await run(client(async () => null), "Bash", { command: "ls" })).toBe("");
  });

  it("fails open when the client throws", async () => {
    const c = client(async () => { throw new Error("boom"); });
    expect(await run(c, "Bash", { command: "ls" })).toBe("");
    expect(await readAlarms(dir)).toHaveLength(0);
  });

  it("fails open when the gateway never answers (deadline), without alarms", async () => {
    const c = client(() => new Promise<PretoolAnswer | null>(() => {}));
    const t0 = Date.now();
    expect(await run(c, "Bash", { command: "ls" }, { preToolDeadlineMs: 80 })).toBe("");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await readAlarms(dir)).toHaveLength(0);
  });

  it("ignores events without a tool name", async () => {
    const pretool = vi.fn(async () => null);
    expect(await handleHook("pre-tool-use", { stdin: "{}", client: { pretool } as unknown as GatewayClient, dataDir: dir })).toBe("");
    expect(pretool).not.toHaveBeenCalled();
  });
});

describe("GatewayClient.pretool fails open", () => {
  async function stub(handler: http.RequestListener): Promise<GatewayClient> {
    const s = http.createServer(handler);
    server = s;
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return new GatewayClient({ baseUrl: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, token: "t" });
  }
  const payload = { sessionKey: "k", project: "my-project", toolName: "Bash", toolInput: { command: "x" } };

  it("returns the decision on 200 and posts the documented body", async () => {
    let body = "";
    const c = await stub((req, res) => {
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ decision: "warn", message: "m", lesson_id: "les_9" }));
      });
    });
    expect(await c.pretool(payload)).toEqual({ decision: "warn", message: "m", lessonId: "les_9" });
    expect(JSON.parse(body)).toMatchObject({ session_key: "k", project: "my-project", tool_name: "Bash", one_way: null });
  });

  it("503 starting → null", async () => {
    const c = await stub((_q, res) => { res.statusCode = 503; res.end('{"status":"starting"}'); });
    expect(await c.pretool(payload)).toBeNull();
  });

  it("decision none, garbage body, 500 → null", async () => {
    const none = await stub((_q, res) => res.end('{"decision":"none","message":""}'));
    expect(await none.pretool(payload)).toBeNull();
    server?.closeAllConnections?.();
    await new Promise<void>((r) => server!.close(() => r()));
    const bad = await stub((_q, res) => res.end("not json"));
    expect(await bad.pretool(payload)).toBeNull();
    server?.closeAllConnections?.();
    await new Promise<void>((r) => server!.close(() => r()));
    const err = await stub((_q, res) => { res.statusCode = 500; res.end("x"); });
    expect(await err.pretool(payload)).toBeNull();
  });

  it("connection refused → null", async () => {
    const c = new GatewayClient({ baseUrl: "http://127.0.0.1:1", token: "t" });
    expect(await c.pretool(payload)).toBeNull();
  });
});

describe("PostToolUse / PostToolUseFailure (4.3, 4.6)", () => {
  it("post-tool-use asks the gateway to skip the post-hoc file-memory and sends project + cwd", async () => {
    const observe = vi.fn(async (_p: unknown) => "");
    const c = { observe } as unknown as GatewayClient;
    await handleHook("post-tool-use", { stdin: stdin("Edit", { file_path: "a.ts" }), client: c, dataDir: dir });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ skipFileMemory: true, project: "my-project", cwd: CWD }));
  });

  it("post-tool-use-failure forwards project/cwd and returns the gateway's past-fix as additionalContext", async () => {
    const observe = vi.fn(async (_p: unknown) => "Memory warning — lesson … (lesson id les_3)");
    const c = { observe } as unknown as GatewayClient;
    const out = JSON.parse(await handleHook("post-tool-use-failure", {
      stdin: JSON.stringify({ cwd: CWD, tool_name: "Bash", tool_input: { command: "x" }, error: "ECONNREFUSED" }),
      client: c, dataDir: dir,
    }));
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      toolOutputIsError: true, project: "my-project", cwd: CWD, skipFileMemory: true,
    }));
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUseFailure" });
    expect(out.hookSpecificOutput.additionalContext).toContain("les_3");
  });
});
