import { describe, it, expect, vi } from "vitest";
import { distillPrinciples } from "../principle-runner.js";
import type { KbEvent, KbEventInput } from "../../store/types.js";

function evt(p: Partial<KbEvent>): KbEvent {
  return {
    id: "e", ts: "2026-07-01T10:00:00.000Z", recorded_at: "r", session_key: "sA",
    session_id: "sid", namespace: "default", project: "sofia", type: "decision",
    text: "chose value pricing", language: "it", entities: ["ent_pricing"], source_message_ids: ["m1"], ...p,
  };
}

const okRunner = () => ({ run: vi.fn().mockResolvedValue('{"domain":"pricing","principle_text":"Prezza a valore.","confidence":0.8}') }) as any;

describe("distillPrinciples", () => {
  it("distils and writes a principle for a qualifying cross-session cluster", async () => {
    const inserted: KbEventInput[] = [];
    const events = [
      evt({ id: "d1", session_id: "chatA" }),
      evt({ id: "d2", session_id: "chatB", source_message_ids: ["m2"] }),
    ];
    const store = {
      listRecentEvents: () => events,
      insertEvent: (e: KbEventInput) => { inserted.push(e); return { ...e, id: "prc_1" } as any; },
      stampSalience: () => {},
    } as any;

    const stats = await distillPrinciples(store, okRunner(), { now: "2026-07-01T14:00:00.000Z" });
    expect(stats.candidates).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(inserted[0].type).toBe("principle");
    expect(inserted[0].text).toBe("Prezza a valore.");
  });

  it("is idempotent: skips a domain that already has a principle", async () => {
    const insert = vi.fn();
    const events = [
      evt({ id: "d1", session_id: "chatA" }),
      evt({ id: "d2", session_id: "chatB" }),
      evt({ id: "prc_old", type: "principle", entities: ["ent_pricing", "evidence:2"], text: "old principle" }),
    ];
    const store = { listRecentEvents: () => events, insertEvent: insert, stampSalience: () => {} } as any;

    const stats = await distillPrinciples(store, okRunner(), { now: "n" });
    expect(stats.skippedDuplicate).toBe(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it("no cluster → no LLM call (cheap by design)", async () => {
    const runner = okRunner();
    const store = { listRecentEvents: () => [evt({ id: "d1", session_key: "sA" })], insertEvent: vi.fn(), stampSalience: () => {} } as any;
    const stats = await distillPrinciples(store, runner, { now: "n" });
    expect(stats.candidates).toBe(0);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("never throws when the store lacks capabilities", async () => {
    await expect(distillPrinciples({} as any, okRunner(), { now: "n" })).resolves.toEqual(
      expect.objectContaining({ candidates: 0, inserted: 0 }),
    );
  });
});
