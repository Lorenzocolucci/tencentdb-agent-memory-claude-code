/**
 * session_projects registry — sessionKey → project name.
 * Recall writes it (it knows both); the background extractor reads it to tag new
 * events by project. NON-circular: we set a mapping then assert get returns it,
 * and that it is per-sessionKey (distinct keys → distinct projects).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";

describe("VectorStore session_projects registry", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-sessproj-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("stores and returns a per-sessionKey project", () => {
    store.setSessionProject("keyA", "Sofia-AI");
    store.setSessionProject("keyB", "Tutor-Agent");
    expect(store.getSessionProject("keyA")).toBe("Sofia-AI");
    expect(store.getSessionProject("keyB")).toBe("Tutor-Agent");
    expect(store.getSessionProject("unknown")).toBeUndefined();
  });

  it("upserts (a re-mapped sessionKey takes the new project)", () => {
    store.setSessionProject("k", "old");
    store.setSessionProject("k", "new");
    expect(store.getSessionProject("k")).toBe("new");
  });

  it("no-ops on empty inputs (never throws)", () => {
    expect(() => store.setSessionProject("", "x")).not.toThrow();
    expect(() => store.setSessionProject("k", "")).not.toThrow();
    expect(store.getSessionProject("")).toBeUndefined();
  });
});
