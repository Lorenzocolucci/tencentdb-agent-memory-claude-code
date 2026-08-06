/**
 * Friction capture — pure unit tests (no DB, no network).
 *
 * Pins the guarantees that let this run on the live tool path safely:
 * only failures, secrets redacted, retry-loops de-duplicated, session capped,
 * and the SAME failure produces the SAME signature across sessions (which is
 * what makes cross-session clustering — and therefore lessons — possible).
 */
import { describe, it, expect } from "vitest";
import {
  buildFrictionEvent,
  createFrictionState,
  MAX_PER_SESSION,
  DEDUPE_WINDOW_MS,
} from "../friction-capture.js";

const base = {
  sessionKey: "proj-a",
  toolName: "Bash",
  atMs: 1_000_000,
};

describe("buildFrictionEvent", () => {
  it("records a failed command as a bug event", () => {
    const st = createFrictionState();
    const ev = buildFrictionEvent(
      { ...base, toolInput: { command: "npm test" }, errorText: "FAIL src/a.test.ts\nError: expected 1 got 2" },
      st,
    );
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("bug");
    expect(ev!.text).toContain("Bash failed");
    expect(ev!.text).toContain("npm test");
    expect(ev!.text.toLowerCase()).toContain("error");
    expect(st.count).toBe(1);
  });

  it("ignores anything without error text (successes never reach memory)", () => {
    const st = createFrictionState();
    expect(buildFrictionEvent({ ...base, toolInput: { command: "npm test" }, errorText: "" }, st)).toBeNull();
    expect(buildFrictionEvent({ ...base, toolInput: { command: "npm test" } }, st)).toBeNull();
    expect(st.count).toBe(0); // rejected failures never consume the budget
  });

  it("REDACTS secrets before they can be stored", () => {
    const st = createFrictionState();
    const ev = buildFrictionEvent(
      {
        ...base,
        toolInput: { command: "curl -H 'Authorization: Bearer sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'" },
        errorText: "Error: request failed with key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
      },
      st,
    );
    expect(ev).not.toBeNull();
    expect(ev!.text).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
  });

  it("de-duplicates a retry loop inside the window, then allows it again after", () => {
    const st = createFrictionState();
    const f = { ...base, toolInput: { command: "npm run build" }, errorText: "Error: ENOENT missing file" };
    expect(buildFrictionEvent({ ...f, atMs: 1000 }, st)).not.toBeNull();
    // same failure, hammered 5 more times → all collapsed
    for (let i = 1; i <= 5; i++) {
      expect(buildFrictionEvent({ ...f, atMs: 1000 + i * 1000 }, st)).toBeNull();
    }
    expect(st.count).toBe(1);
    // well after the window → recorded again (it is a genuine recurrence)
    expect(buildFrictionEvent({ ...f, atMs: 1000 + DEDUPE_WINDOW_MS + 1 }, st)).not.toBeNull();
    expect(st.count).toBe(2);
  });

  it("gives the SAME signature to the same failure across sessions (enables clustering)", () => {
    const a = createFrictionState();
    const b = createFrictionState();
    const mk = (line: number, session: string) =>
      buildFrictionEvent(
        {
          ...base,
          sessionKey: session,
          toolInput: { command: "npx tsc --noEmit" },
          errorText: `src/foo.ts(${line},7): error TS2345: Argument of type X is not assignable`,
          atMs: 5_000,
        },
        session === "s1" ? a : b,
      );
    const e1 = mk(120, "s1");
    const e2 = mk(377, "s2"); // different line number = same underlying failure
    expect(e1).not.toBeNull();
    expect(e2).not.toBeNull();
    expect(e2!.signature).toBe(e1!.signature);
  });

  it("distinguishes genuinely different failures", () => {
    const st = createFrictionState();
    const e1 = buildFrictionEvent(
      { ...base, toolInput: { command: "npm test" }, errorText: "Error: timeout" },
      st,
    );
    const e2 = buildFrictionEvent(
      { ...base, toolInput: { command: "npm test" }, errorText: "Error: connection refused" },
      st,
    );
    expect(e1!.signature).not.toBe(e2!.signature);
  });

  it("caps how much one session can write (flood guard)", () => {
    const st = createFrictionState();
    // Genuinely different failures: digits alone would be normalised away on
    // purpose (same error at a different line = same failure), so vary the WORDS.
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu apple beetle cactus dahlia ember fjord glacier harbor igloo jungle kettle lantern meadow nebula".split(" ");
    for (let i = 0; i < MAX_PER_SESSION + 15; i++) {
      const w = `${words[i % words.length]}${i >= words.length ? "x" : ""}`;
      buildFrictionEvent(
        { ...base, toolInput: { command: `run ${w}` }, errorText: `Error: cannot resolve ${w}`, atMs: i * 60_000 },
        st,
      );
    }
    expect(st.count).toBe(MAX_PER_SESSION);
  });

  it("carries the file path when the failing tool acted on a file", () => {
    const st = createFrictionState();
    const ev = buildFrictionEvent(
      { ...base, toolName: "Edit", toolInput: { file_path: "src/core/foo.ts" }, errorText: "Error: string not found" },
      st,
    );
    expect(ev!.filePath).toBe("src/core/foo.ts");
  });
});
