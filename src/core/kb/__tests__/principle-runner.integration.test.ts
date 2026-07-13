/**
 * Integration: the full principle pass against a REAL throwaway VectorStore
 * (never the live vectors.db). Proves capture→store→idempotency end-to-end on
 * the real store shape — the non-circular check that catches a green no-op.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { _resetUlidStateForTest } from "../kb-queries.js";
import { distillPrinciples } from "../principle-runner.js";

const DIMS = 4;
const okRunner = () => ({ run: vi.fn().mockResolvedValue('{"domain":"pricing","principle_text":"Prezza a valore, non a ora.","confidence":0.8}') }) as any;

describe("distillPrinciples — real store round-trip", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-principle-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isKbReady()).toBe(true);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function principleCount(): number {
    return store.listRecentEvents!("default", { limit: 1000 }).filter((e) => e.type === "principle").length;
  }

  it("writes one principle for a cross-session decision cluster, idempotent on re-run", async () => {
    store.insertEvent({ sessionKey: "sk-proj", sessionId: "A", ts: "2026-06-30T10:00:00.000Z", type: "decision", text: "prezzo a valore", entities: ["ent_pricing"], sourceMessageIds: ["m1"] });
    store.insertEvent({ sessionKey: "sk-proj", sessionId: "B", ts: "2026-07-01T09:00:00.000Z", type: "decision", text: "di nuovo a valore", entities: ["ent_pricing"], sourceMessageIds: ["m2"] });

    const s1 = await distillPrinciples(store, okRunner(), { now: "2026-07-01T14:00:00.000Z" });
    expect(s1.inserted).toBe(1);
    expect(principleCount()).toBe(1);

    const principle = store.listRecentEvents!("default", { limit: 1000 }).find((e) => e.type === "principle")!;
    expect(principle.text).toContain("Prezza a valore");
    expect(principle.entities).toContain("ent_pricing");
    expect(principle.entities).toContain("evidence:2");

    // Second pass sees the existing principle → no duplicate.
    const s2 = await distillPrinciples(store, okRunner(), { now: "2026-07-01T15:00:00.000Z" });
    expect(s2.skippedDuplicate).toBeGreaterThanOrEqual(1);
    expect(principleCount()).toBe(1);
  });

  it("does nothing when decisions are all in one session (anecdote guard)", async () => {
    store.insertEvent({ sessionKey: "sk-proj", sessionId: "A", ts: "2026-06-30T10:00:00.000Z", type: "decision", text: "x", entities: ["ent_y"] });
    store.insertEvent({ sessionKey: "sk-proj", sessionId: "A", ts: "2026-06-30T11:00:00.000Z", type: "decision", text: "x2", entities: ["ent_y"] });
    const s = await distillPrinciples(store, okRunner(), { now: "2026-07-01T14:00:00.000Z" });
    expect(s.candidates).toBe(0);
    expect(principleCount()).toBe(0);
  });
});
