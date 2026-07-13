import { describe, it, expect } from "vitest";
import { selectPrincipleClusters } from "../principle-clusters.js";
import type { KbEvent } from "../../store/types.js";

function evt(p: Partial<KbEvent>): KbEvent {
  return {
    id: "e", ts: "2026-07-01T10:00:00.000Z", recorded_at: "r", session_key: "s1",
    session_id: "sid", namespace: "default", project: "proj", type: "decision",
    text: "chose X", language: "it", entities: ["ent_pricing"], source_message_ids: ["m1"], ...p,
  };
}

describe("selectPrincipleClusters", () => {
  it("clusters recurring decisions on the same entity across sessions (same project, distinct session_id)", () => {
    // Realistic shape: same session_key (per-project), DIFFERENT session_id per chat.
    const events = [
      evt({ id: "d1", session_key: "proj", session_id: "chatA", entities: ["ent_pricing"], text: "prezzo a valore", source_message_ids: ["m1"] }),
      evt({ id: "d2", session_key: "proj", session_id: "chatB", entities: ["ent_pricing"], text: "di nuovo a valore", source_message_ids: ["m2"] }),
    ];
    const clusters = selectPrincipleClusters(events, {});
    expect(clusters).toHaveLength(1);
    expect(clusters[0].domainEntity).toBe("ent_pricing");
    expect(clusters[0].eventIds).toEqual(["d1", "d2"]);
    expect(clusters[0].sessionIds).toEqual(["chatA", "chatB"]);
    expect(clusters[0].sessionKey).toBe("proj");
    expect(clusters[0].texts).toEqual(expect.arrayContaining(["prezzo a valore", "di nuovo a valore"]));
  });

  it("does NOT cluster when all recurrences are in ONE session (anecdote guard)", () => {
    const events = [
      evt({ id: "d1", session_id: "chatA", entities: ["ent_x"] }),
      evt({ id: "d2", session_id: "chatA", entities: ["ent_x"] }),
    ];
    expect(selectPrincipleClusters(events, {})).toHaveLength(0);
  });

  it("does NOT cluster below the evidence threshold (single occurrence)", () => {
    const events = [evt({ id: "d1", session_id: "chatA", entities: ["ent_x"] })];
    expect(selectPrincipleClusters(events, {})).toHaveLength(0);
  });

  it("excludes failure types (bug/fix belong to Pilastro A lessons)", () => {
    const events = [
      evt({ id: "b1", type: "bug", session_id: "chatA", entities: ["ent_x"] }),
      evt({ id: "b2", type: "fix", session_id: "chatB", entities: ["ent_x"] }),
    ];
    expect(selectPrincipleClusters(events, {})).toHaveLength(0);
  });

  it("ignores our own principle/session_recap atoms", () => {
    const events = [
      evt({ id: "p1", type: "principle", session_id: "chatA", entities: ["ent_x"] }),
      evt({ id: "r1", type: "session_recap", session_id: "chatB", entities: ["ent_x"] }),
    ];
    expect(selectPrincipleClusters(events, {})).toHaveLength(0);
  });

  it("is deterministic: clusters sorted by domainEntity, ids/sessions sorted", () => {
    const events = [
      evt({ id: "d2", session_id: "chatB", entities: ["ent_z"] }),
      evt({ id: "d1", session_id: "chatA", entities: ["ent_z"] }),
      evt({ id: "d3", session_id: "chatA", entities: ["ent_a"] }),
      evt({ id: "d4", session_id: "chatB", entities: ["ent_a"] }),
    ];
    const clusters = selectPrincipleClusters(events, {});
    expect(clusters.map((c) => c.domainEntity)).toEqual(["ent_a", "ent_z"]);
    expect(clusters[1].eventIds).toEqual(["d1", "d2"]);
  });
});
