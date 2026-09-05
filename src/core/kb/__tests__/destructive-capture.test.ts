/**
 * Destructive-success capture — pure unit tests (no DB, no network).
 * CONTRACT point 1 (2026-09-05): a flagged command that SUCCEEDED is an
 * `observation` (not a bug), deduped on the friction window, never a loop warning.
 */
import { describe, it, expect } from "vitest";
import {
  buildDestructiveEvent,
  createDestructiveState,
  destructiveSignature,
  MAX_DESTRUCTIVE_PER_SESSION,
  DESTRUCTIVE_STAKES_TAG,
  SIGNATURE_TAG_PREFIX,
} from "../destructive-capture.js";
import { DEDUPE_WINDOW_MS } from "../friction-capture.js";

const base = { sessionKey: "proj-a", toolName: "Bash", atMs: 1_000_000 };

describe("buildDestructiveEvent", () => {
  it("records a successful destructive command as an observation with the contract text and tags", () => {
    const st = createDestructiveState();
    const ev = buildDestructiveEvent(
      { ...base, toolInput: { command: "git checkout -- src/a.ts" }, outputText: "Updated 1 path from the index\nmore" },
      st,
    );
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("observation");
    expect(ev!.text.startsWith("destructive command succeeded: Bash `git checkout -- src/a.ts` — ")).toBe(true);
    expect(ev!.text).toContain(ev!.signature);
    expect(ev!.text).toContain("output: Updated 1 path from the index");
    expect(ev!.text).not.toContain("more");
    expect(ev!.signature).toBe(destructiveSignature("Bash", "git checkout -- src/a.ts"));
    expect(ev!.tags).toEqual([DESTRUCTIVE_STAKES_TAG, `${SIGNATURE_TAG_PREFIX}${ev!.signature}`]);
    expect(st.count).toBe(1);
    // No warning field exists: a destructive success never talks back.
    expect("warning" in ev!).toBe(false);
  });

  it("dedupes the same command inside the 10-minute window, new episode after it", () => {
    const st = createDestructiveState();
    const input = { command: "rm -rf dist" };
    expect(buildDestructiveEvent({ ...base, toolInput: input }, st)).not.toBeNull();
    expect(buildDestructiveEvent({ ...base, toolInput: input, atMs: base.atMs + 1000 }, st)).toBeNull();
    // Repeats refresh the window: still inside it relative to the LAST call.
    expect(buildDestructiveEvent({ ...base, toolInput: input, atMs: base.atMs + DEDUPE_WINDOW_MS }, st)).toBeNull();
    expect(
      buildDestructiveEvent({ ...base, toolInput: input, atMs: base.atMs + DEDUPE_WINDOW_MS * 2 + 1 }, st),
    ).not.toBeNull();
    expect(st.count).toBe(2);
  });

  it("volatile bits (numbers, hashes) do not split the signature", () => {
    const st = createDestructiveState();
    expect(buildDestructiveEvent({ ...base, toolInput: { command: "git reset --hard deadbeefcafe" } }, st)).not.toBeNull();
    expect(
      buildDestructiveEvent({ ...base, toolInput: { command: "git reset --hard cafebabedead" }, atMs: base.atMs + 5 }, st),
    ).toBeNull();
    expect(buildDestructiveEvent({ ...base, toolInput: { command: "kill -9 12345" } }, st)).not.toBeNull();
    expect(buildDestructiveEvent({ ...base, toolInput: { command: "kill -9 99" }, atMs: base.atMs + 5 }, st)).toBeNull();
  });

  it("REDACTS secrets in the command and the output before they can be stored", () => {
    const st = createDestructiveState();
    const key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    const ev = buildDestructiveEvent(
      { ...base, toolInput: { command: `curl -H 'Authorization: Bearer ${key}' -X DELETE https://x` }, outputText: `deleted with ${key}` },
      st,
    );
    expect(ev).not.toBeNull();
    expect(ev!.text).not.toContain(key);
    expect(ev!.label).not.toContain(key);
  });

  it("ignores empty input, and enforces the per-session cap", () => {
    const st = createDestructiveState();
    expect(buildDestructiveEvent({ ...base, toolInput: undefined }, st)).toBeNull();
    expect(buildDestructiveEvent({ ...base, toolInput: { command: "   " } }, st)).toBeNull();
    for (let i = 0; i < MAX_DESTRUCTIVE_PER_SESSION; i++) {
      expect(buildDestructiveEvent({ ...base, toolInput: { command: `rm -rf dir${"x".repeat(i + 1)}` } }, st)).not.toBeNull();
    }
    expect(buildDestructiveEvent({ ...base, toolInput: { command: "rm -rf one-more" } }, st)).toBeNull();
    expect(st.count).toBe(MAX_DESTRUCTIVE_PER_SESSION);
  });

  it("carries the file path when the input names one", () => {
    const st = createDestructiveState();
    const ev = buildDestructiveEvent({ ...base, toolName: "Write", toolInput: { file_path: "C:\\repo\\src\\a.ts" } }, st);
    expect(ev!.filePath).toBe("C:\\repo\\src\\a.ts");
  });
});
