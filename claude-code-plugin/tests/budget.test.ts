import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as budget from "../lib/budget.js";
import { RECALL_TIMEOUT_MS, CAPTURE_TIMEOUT_MS } from "../lib/gateway-client.js";

interface HooksFile {
  hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
}

const here = dirname(fileURLToPath(import.meta.url));
const hooksJson = JSON.parse(
  readFileSync(join(here, "..", "hooks", "hooks.json"), "utf-8"),
) as HooksFile;

function timeoutOf(event: string): number {
  return hooksJson.hooks[event][0].hooks[0].timeout;
}

describe("budget.ts vs hooks/hooks.json (drift guard)", () => {
  it("every hook timeout in hooks.json equals budget.ts", () => {
    expect(timeoutOf("SessionStart")).toBe(budget.HOOK_TIMEOUT_S.sessionStart);
    expect(timeoutOf("UserPromptSubmit")).toBe(budget.HOOK_TIMEOUT_S.userPromptSubmit);
    expect(timeoutOf("PostToolUse")).toBe(budget.HOOK_TIMEOUT_S.postToolUse);
    expect(timeoutOf("PostToolUseFailure")).toBe(budget.HOOK_TIMEOUT_S.postToolUseFailure);
    expect(timeoutOf("Stop")).toBe(budget.HOOK_TIMEOUT_S.stop);
  });

  it("matches the agreed budget table", () => {
    expect(budget.HOOK_TIMEOUT_S.userPromptSubmit).toBe(6.5);
    expect(budget.UPS_DEADLINE_MS).toBe(5_800);
    expect(budget.RECALL_TIMEOUT_MS).toBe(4_500);
    expect(budget.OBSERVE_TIMEOUT_MS).toBe(2_500);
    expect(budget.HOOK_TIMEOUT_S.postToolUse).toBe(4);
    expect(budget.HOOK_TIMEOUT_S.stop).toBe(45);
    expect(budget.STOP_DEADLINE_MS).toBe(40_000);
    expect(budget.CAPTURE_TIMEOUT_MS).toBe(12_000);
  });

  it("keeps every inner timeout strictly inside its hook timeout", () => {
    expect(budget.RECALL_TIMEOUT_MS).toBeLessThan(budget.UPS_DEADLINE_MS);
    expect(budget.UPS_DEADLINE_MS).toBeLessThan(budget.HOOK_TIMEOUT_S.userPromptSubmit * 1000);
    expect(budget.OBSERVE_TIMEOUT_MS).toBeLessThan(budget.HOOK_TIMEOUT_S.postToolUse * 1000);
    expect(budget.STOP_DEADLINE_MS).toBeLessThan(budget.HOOK_TIMEOUT_S.stop * 1000);
    // two capture attempts + the 2 s retry gap must fit the Stop deadline
    expect(budget.CAPTURE_TIMEOUT_MS * 2 + 2_000).toBeLessThan(budget.STOP_DEADLINE_MS);
  });

  it("gateway-client re-exports the budget values (no second copy)", () => {
    expect(RECALL_TIMEOUT_MS).toBe(budget.RECALL_TIMEOUT_MS);
    expect(CAPTURE_TIMEOUT_MS).toBe(budget.CAPTURE_TIMEOUT_MS);
  });
});
