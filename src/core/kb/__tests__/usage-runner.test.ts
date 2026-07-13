/**
 * Slice B2+A3 — distillUsage wiring (fake store + injected embedding reader +
 * injected LLM gate). Proves: semantic cluster → LLM confirm → usage atom with
 * cleaned text; LLM rejects noise → no write; anecdote guard; idempotency;
 * cheap when nothing clusters; never throws.
 */
import { describe, it, expect, vi } from "vitest";
import { distillUsage } from "../usage-runner.js";
import { fakeEmbeddingReader } from "../bug-embeddings.js";
import type { KbEvent, KbEventInput } from "../../store/types.js";

function evt(p: Partial<KbEvent>): KbEvent {
  return {
    id: "e", ts: "2026-07-01T10:00:00.000Z", recorded_at: "r", session_key: "sA",
    session_id: "sid", namespace: "default", project: "sofia", type: "preference_stated",
    text: "aspetta la mia risposta", language: "it", entities: [], source_message_ids: ["m1"], ...p,
  };
}

const reader = (m: Record<string, Float32Array>) => fakeEmbeddingReader(new Map(Object.entries(m)));
const V = (...xs: number[]) => new Float32Array(xs);
// Candidate TAU default is 0.60 → cosine ≈ 0.99 (α·0.99=0.84) links easily.
const confirmRunner = (text = "Tende ad attendere la conferma prima di procedere.") =>
  ({ run: vi.fn().mockResolvedValue(`{"is_tendency": true, "tendency_text": "${text}", "confidence": 0.8}`) }) as any;
const rejectRunner = () =>
  ({ run: vi.fn().mockResolvedValue('{"is_tendency": false, "tendency_text": "", "confidence": 0.1}') }) as any;

describe("distillUsage", () => {
  it("writes a usage atom with the LLM-cleaned tendency for a confirmed cluster", async () => {
    const inserted: KbEventInput[] = [];
    const events = [
      evt({ id: "b1", session_id: "chatA", text: "aspetta la mia risposta" }),
      evt({ id: "b2", session_id: "chatB", text: "non partire finché non rispondo", source_message_ids: ["m2"] }),
    ];
    const store = {
      listRecentEvents: () => events,
      insertEvent: (e: KbEventInput) => { inserted.push(e); return { ...e, id: "usg_1" } as any; },
      stampSalience: vi.fn(),
    } as any;

    const stats = await distillUsage(store, reader({ b1: V(1, 0), b2: V(0.99, 0.14) }), confirmRunner(), { now: "2026-07-01T14:00:00.000Z" });
    expect(stats.candidates).toBe(1);
    expect(stats.confirmed).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(inserted[0].type).toBe("usage");
    expect(inserted[0].text).toContain("attendere la conferma"); // cleaned text, not raw theme
    expect(inserted[0].entities).toContain("usage-src:b1");
    expect(inserted[0].entities).toContain("usage-confidence:0.80");
  });

  it("LLM rejects noise → candidate found but NOT written", async () => {
    const insert = vi.fn();
    const events = [
      evt({ id: "b1", session_id: "chatA", type: "observation", text: "postcall_state 42703 ancora rotto" }),
      evt({ id: "b2", session_id: "chatB", type: "observation", text: "postcall_state 42703 rotto di nuovo" }),
    ];
    const store = { listRecentEvents: () => events, insertEvent: insert, stampSalience: () => {} } as any;
    const stats = await distillUsage(store, reader({ b1: V(1, 0), b2: V(1, 0) }), rejectRunner(), { now: "n" });
    expect(stats.candidates).toBe(1);
    expect(stats.confirmed).toBe(0);
    expect(stats.skippedRejected).toBe(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it("anecdote guard: same session → no candidate, no LLM call", async () => {
    const runner = confirmRunner();
    const events = [evt({ id: "b1", session_id: "chatA" }), evt({ id: "b2", session_id: "chatA" })];
    const store = { listRecentEvents: () => events, insertEvent: vi.fn(), stampSalience: () => {} } as any;
    const stats = await distillUsage(store, reader({ b1: V(1, 0), b2: V(1, 0) }), runner, { now: "n" });
    expect(stats.candidates).toBe(0);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("is idempotent: skips a cluster a usage atom already covers (before the LLM)", async () => {
    const runner = confirmRunner();
    const events = [
      evt({ id: "b1", session_id: "chatA" }),
      evt({ id: "b2", session_id: "chatB" }),
      evt({ id: "usg_old", type: "usage", entities: ["evidence:2", "usage-src:b1", "usage-src:b2"], text: "[modo d'uso ricorrente] ..." }),
    ];
    const store = { listRecentEvents: () => events, insertEvent: vi.fn(), stampSalience: () => {} } as any;
    const stats = await distillUsage(store, reader({ b1: V(1, 0), b2: V(1, 0) }), runner, { now: "n" });
    expect(stats.skippedDuplicate).toBe(1);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("cheap: no cluster → no LLM call", async () => {
    const runner = confirmRunner();
    const store = { listRecentEvents: () => [evt({ id: "b1" })], insertEvent: vi.fn(), stampSalience: () => {} } as any;
    const stats = await distillUsage(store, reader({ b1: V(1, 0) }), runner, { now: "n" });
    expect(stats.candidates).toBe(0);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("never throws when the store lacks capabilities", async () => {
    await expect(distillUsage({} as any, reader({}), confirmRunner(), { now: "n" })).resolves.toEqual(
      expect.objectContaining({ candidates: 0, inserted: 0 }),
    );
  });
});
