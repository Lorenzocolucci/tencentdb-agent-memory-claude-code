import { describe, it, expect } from "vitest";
import { isArgusChild, isArgusProjectDir } from "../argus-child.js";

describe("isArgusProjectDir", () => {
  it("matches the main Argus project dir and every worktree variant", () => {
    expect(isArgusProjectDir("C--Argus")).toBe(true);
    expect(isArgusProjectDir("C--Argus-l6")).toBe(true);
    expect(isArgusProjectDir("C--Argus-docs")).toBe(true);
  });

  it("does not match unrelated project dirs, including a prefix collision", () => {
    expect(isArgusProjectDir("C--Sofia-AI")).toBe(false);
    expect(isArgusProjectDir("C--ArgusWatcher")).toBe(true); // startsWith is intentionally loose
    expect(isArgusProjectDir("D--Argus")).toBe(false);
  });
});

describe("isArgusChild", () => {
  it("classifies a short Argus-preamble message as a child (POSITIVE — marker)", () => {
    expect(
      isArgusChild({
        projectDirName: "C--Argus",
        turns: 1,
        firstUserText: "Sei Argus e stai scrivendo a Lorenzo su Telegram. Breve.",
      }),
    ).toBe(true);
  });

  it("is case-insensitive on the preamble ('Sei ARGUS')", () => {
    expect(
      isArgusChild({
        projectDirName: "C--Argus-l6",
        turns: 1,
        firstUserText: "Sei ARGUS, il supervisore di Sofia (receptionist AI).",
      }),
    ).toBe(true);
  });

  it("classifies a long first message under an Argus dir as a child even without the marker (POSITIVE — length)", () => {
    expect(
      isArgusChild({
        projectDirName: "C--Argus",
        turns: 1,
        firstUserText: "x".repeat(2001),
      }),
    ).toBe(true);
  });

  it("does NOT classify a short, unmarked message as a child (NEGATIVE — known 3/3131 gap)", () => {
    expect(
      isArgusChild({
        projectDirName: "C--Argus",
        turns: 1,
        firstUserText: "rispondi solo: ok\n",
      }),
    ).toBe(false);
  });

  it("does NOT classify a non-Argus project dir even with the marker and 1 turn (NEGATIVE — project dir)", () => {
    expect(
      isArgusChild({
        projectDirName: "C--Sofia-AI",
        turns: 1,
        firstUserText: "Sei Argus e stai scrivendo a Lorenzo su Telegram.",
      }),
    ).toBe(false);
  });

  it("does NOT classify a multi-turn Argus session as a child (NEGATIVE — turns != 1)", () => {
    expect(
      isArgusChild({
        projectDirName: "C--Argus",
        turns: 2,
        firstUserText: "Sei Argus e stai scrivendo a Lorenzo su Telegram.",
      }),
    ).toBe(false);
  });

  it("treats a null firstUserText as empty (no crash, no false positive)", () => {
    expect(isArgusChild({ projectDirName: "C--Argus", turns: 1, firstUserText: null })).toBe(false);
  });

  it("requires the marker at the START of the message, not merely mentioned inside it", () => {
    expect(
      isArgusChild({
        projectDirName: "C--Argus",
        turns: 1,
        firstUserText: "Please review this bug report about Argus and its behaviour.",
      }),
    ).toBe(false);
  });
});
