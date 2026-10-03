/**
 * Phase 3.10 — "close the loop correctly". Reinforcement used to reward RETRIEVAL
 * ("autoavvia: no" reinforced 1,515 times, used 0). It now happens only when the
 * ledger judged the memory USED by the agent's reply.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../../store/sqlite.js";

const NOW = "2026-10-02T10:00:00.000Z";
let dir: string;
let store: VectorStore;
let db: DatabaseSync;

const count = (id: string, kind: string): number =>
  (db.prepare("SELECT reinforcement_count AS n FROM memory_lifecycle WHERE owner_id = ? AND owner_kind = ?").get(id, kind) as { n: number } | undefined)?.n ?? 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-reinforce-use-"));
  store = new VectorStore(path.join(dir, "vectors.db"), 4);
  store.init({ provider: "openai", model: "text-embedding-3-small" });
  db = (store as unknown as { db: DatabaseSync }).db;
  store.recordRecallInjections({
    sessionKey: "sk", sessionId: "cc-1", now: NOW,
    injections: [
      { ownerId: "m-used", ownerKind: "fact", score: 0.9, associative: false, memoryText: "[fact] gateway — tokenPath: la porta 8421 e il file token" },
      { ownerId: "m-ignored", ownerKind: "event", score: 0.8, associative: true, memoryText: "[event] DeepInfra Qwen3-Embedding-4B a 1024 dimensioni" },
    ],
  });
});
afterEach(() => {
  try { store.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("judgePendingRecalls reinforces only what was used", () => {
  it("recall (injection) alone reinforces nothing", () => {
    expect(count("m-used", "fact")).toBe(0);
    expect(count("m-ignored", "event")).toBe(0);
  });

  it("a memory the reply drew on is reinforced; the injected-and-ignored one is not", () => {
    const r = store.judgePendingRecalls({
      sessionKey: "sk", userText: "riprendi", now: NOW,
      assistantText: "Il gateway sta sulla porta 8421 e legge il tokenPath dal file.",
    });
    expect(r.used).toBe(1);
    expect(r.usedOwners).toEqual([{ ownerId: "m-used", ownerKind: "fact" }]);
    expect(count("m-used", "fact")).toBe(1);
    expect(count("m-ignored", "event")).toBe(0);
  });

  it("a second judging of the same rows does not reinforce again (settled once)", () => {
    const p = { sessionKey: "sk", userText: "riprendi", now: NOW, assistantText: "porta 8421 tokenPath" };
    store.judgePendingRecalls(p);
    store.judgePendingRecalls(p);
    expect(count("m-used", "fact")).toBe(1);
  });
});
