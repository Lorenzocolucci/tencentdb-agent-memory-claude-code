/**
 * Live 04/10/2026: sessions in `C:\Tutor-Agent\backend` were labelled "backend" and
 * sessions in `C:\Argus\.claude\worktrees\agent-…` "agent-…". Hard project scope then
 * hid their memories from the repo they belong to. The project is the REPOSITORY, for
 * any project, without per-project configuration.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProjectName } from "../lib/session-key.js";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-project-name-"));
  // main repo with a subfolder
  fs.mkdirSync(path.join(root, "Shop", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "Shop", "backend", "src"), { recursive: true });
  // linked worktree inside the repo (how Claude Code creates agent worktrees)
  const wt = path.join(root, "Shop", ".claude", "worktrees", "agent-abc123");
  fs.mkdirSync(path.join(wt, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "Shop", ".git", "worktrees", "agent-abc123"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, "Shop", ".git", "worktrees", "agent-abc123").replace(/\\/g, "/")}\n`);
  // linked worktree OUTSIDE the repo (C:\Argus-a style)
  const sib = path.join(root, "Shop-b");
  fs.mkdirSync(sib, { recursive: true });
  fs.writeFileSync(path.join(sib, ".git"), `gitdir: ${path.join(root, "Shop", ".git", "worktrees", "Shop-b")}\n`);
  // submodule: its own project
  const sub = path.join(root, "Shop", "vendor", "lib-x");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../../.git/modules/lib-x\n");
  // no repository at all
  fs.mkdirSync(path.join(root, "loose", "notes"), { recursive: true });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("getProjectName resolves the repository, not the folder", () => {
  it("repo root → repo name", () => {
    expect(getProjectName(path.join(root, "Shop"))).toBe("Shop");
  });
  it("a subfolder of the repo → repo name", () => {
    expect(getProjectName(path.join(root, "Shop", "backend", "src"))).toBe("Shop");
  });
  it("a worktree inside the repo (and its subfolders) → the main repo name", () => {
    expect(getProjectName(path.join(root, "Shop", ".claude", "worktrees", "agent-abc123"))).toBe("Shop");
    expect(getProjectName(path.join(root, "Shop", ".claude", "worktrees", "agent-abc123", "lib"))).toBe("Shop");
  });
  it("a worktree living next to the repo → the main repo name", () => {
    expect(getProjectName(path.join(root, "Shop-b"))).toBe("Shop");
  });
  it("a submodule is its own project", () => {
    expect(getProjectName(path.join(root, "Shop", "vendor", "lib-x"))).toBe("lib-x");
  });
  it("outside any repository the folder name is kept (old behaviour)", () => {
    expect(getProjectName(path.join(root, "loose", "notes"))).toBe("notes");
  });
});
