/**
 * Live 04/10/2026: `C:\Tutor-Agent\frontend` is a separate repository nested inside
 * `C:\Tutor-Agent`, and `C:\Tutor-Agent\.worktrees\fe-homework` is a worktree of
 * that nested repository. Both are the same product as Tutor-Agent; "frontend" as
 * a project name would also collide across unrelated products.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProjectName } from "../lib/session-key.js";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-project-nested-"));
  fs.mkdirSync(path.join(root, "Shop", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "Shop", "frontend", ".git", "worktrees", "fe-x"), { recursive: true });
  fs.mkdirSync(path.join(root, "Shop", "frontend", "app"), { recursive: true });
  const wt = path.join(root, "Shop", ".worktrees", "fe-x");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, "Shop", "frontend", ".git", "worktrees", "fe-x")}\n`);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("nested repositories belong to the outer product", () => {
  it("a folder of a repository nested inside another → the outer repository", () => {
    expect(getProjectName(path.join(root, "Shop", "frontend"))).toBe("Shop");
    expect(getProjectName(path.join(root, "Shop", "frontend", "app"))).toBe("Shop");
  });
  it("a worktree of the nested repository → the outer repository", () => {
    expect(getProjectName(path.join(root, "Shop", ".worktrees", "fe-x"))).toBe("Shop");
  });
});
