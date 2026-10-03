/**
 * A recall the gateway answered with "nothing relevant, on purpose" is SILENCE — the
 * hook must not fill it with its L0 fallbacks (that would put the noise back into the
 * turns selective recall decided to leave alone). A plain empty answer keeps the fallbacks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../lib/hook.js";
import type { GatewayClient, RecallResult } from "../lib/gateway-client.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tdai-silent-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function client(recall: RecallResult) {
  const searchConversations = vi.fn(async () => ({ results: "una conversazione vecchia", total: 1 }));
  return {
    c: { recall: vi.fn(async () => recall), searchConversations } as unknown as GatewayClient,
    searchConversations,
  };
}

const run = (c: GatewayClient, prompt: string) =>
  handleHook("user-prompt-submit", {
    stdin: JSON.stringify({ session_id: "s1", cwd: "/tmp/p", prompt }),
    client: c,
    dataDir: dir,
  });

describe("UPS: silent recall", () => {
  it("silent:true → no L0 search, nothing injected", async () => {
    const { c, searchConversations } = client({ context: "", error: null, silent: true });
    expect(await run(c, "ok procedi")).toBe("");
    expect(searchConversations).not.toHaveBeenCalled();
  });

  it("an empty answer that is NOT marked silent still falls back to the L0 search", async () => {
    const { c, searchConversations } = client({ context: "", error: null });
    const out = await run(c, "ok procedi");
    expect(searchConversations).toHaveBeenCalled();
    expect(out).toContain("una conversazione vecchia");
  });
});
