/**
 * Friction capture — pure unit tests (no DB, no network).
 *
 * Pins the guarantees that let this run on the live tool path safely, and the
 * INTRA-SESSION LOOP behaviour that Lorenzo's correction (2026-08-07) exposed:
 * the cross-session clustering needs ≥2 sessions, so 5 identical failures inside
 * ONE session produced nothing at all. A loop must be seen and interrupted.
 */
import { describe, it, expect } from "vitest";
import {
  buildFrictionEvent,
  createFrictionState,
  MAX_PER_SESSION,
  DEDUPE_WINDOW_MS,
  LOOP_THRESHOLD,
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
    expect(ev!.repeatCount).toBe(1);
    expect(ev!.isLoop).toBe(false);
    expect(ev!.warning).toBeUndefined();
    expect(st.count).toBe(1);
  });

  it("ignores anything without error text (successes never reach memory)", () => {
    const st = createFrictionState();
    expect(buildFrictionEvent({ ...base, toolInput: { command: "npm test" }, errorText: "" }, st)).toBeNull();
    expect(buildFrictionEvent({ ...base, toolInput: { command: "npm test" } }, st)).toBeNull();
    expect(st.count).toBe(0);
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

  // ── THE CASE LORENZO REPORTED ──────────────────────────────────────────────
  it("DETECTS an intra-session loop: the same failure 5x in ONE session is seen and warned about", () => {
    const st = createFrictionState();
    const f = {
      ...base,
      toolInput: { file_path: "src/foo.ts" },
      toolName: "Edit",
      errorText: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
    };

    const events = [];
    for (let i = 0; i < 5; i++) {
      const ev = buildFrictionEvent({ ...f, atMs: 1000 + i * 5000 }, st);
      if (ev) events.push(ev);
    }

    // 1st = normal record; 3rd = loop milestone. 2nd/4th/5th stay quiet.
    expect(events.length).toBe(2);
    expect(events[0].isLoop).toBe(false);

    const loop = events[1];
    expect(loop.isLoop).toBe(true);
    expect(loop.repeatCount).toBe(LOOP_THRESHOLD);
    expect(loop.text).toContain("LOOP");
    expect(loop.text).toContain("3x in one session");
    // The warning is what actually stops the thrash mid-turn.
    expect(loop.warning).toBeDefined();
    expect(loop.warning).toContain("3 volte");
    expect(loop.warning!.toLowerCase()).toContain("fermati");
  });

  it("keeps nagging on a long thrash without emitting one event per repeat", () => {
    const st = createFrictionState();
    const f = { ...base, toolInput: { command: "npm run build" }, errorText: "Error: ENOENT missing file" };
    let loops = 0;
    let total = 0;
    for (let i = 0; i < 29; i++) {          // the real 29x thrash found in the transcripts
      const ev = buildFrictionEvent({ ...f, atMs: 1000 + i * 5000 }, st);
      if (ev) { total++; if (ev.isLoop) loops++; }
    }
    expect(loops).toBeGreaterThanOrEqual(3);   // it re-fires periodically…
    expect(total).toBeLessThan(15);            // …but never once per repeat
  });

  it("a failure returning after a long gap starts a NEW episode (recurrence, not thrash)", () => {
    const st = createFrictionState();
    const f = { ...base, toolInput: { command: "npm test" }, errorText: "Error: timeout" };
    const first = buildFrictionEvent({ ...f, atMs: 1000 }, st);
    expect(first!.repeatCount).toBe(1);
    const later = buildFrictionEvent({ ...f, atMs: 1000 + DEDUPE_WINDOW_MS + 1 }, st);
    expect(later).not.toBeNull();
    expect(later!.repeatCount).toBe(1);
    expect(later!.isLoop).toBe(false);
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
    expect(e1!.signature).toBe(e2!.signature);
  });

  it("distinguishes genuinely different failures", () => {
    const st = createFrictionState();
    const e1 = buildFrictionEvent({ ...base, toolInput: { command: "npm test" }, errorText: "Error: timeout" }, st);
    const e2 = buildFrictionEvent({ ...base, toolInput: { command: "npm test" }, errorText: "Error: connection refused" }, st);
    expect(e1!.signature).not.toBe(e2!.signature);
  });

  it("caps how much one session can write (flood guard)", () => {
    const st = createFrictionState();
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
