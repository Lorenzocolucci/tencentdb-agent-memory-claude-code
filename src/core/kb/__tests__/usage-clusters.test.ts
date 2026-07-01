/**
 * Slice B1 — behavioral USAGE clusters (Percorso B: implicit tendencies).
 *
 * The brain: cluster entity-less behavioral events by SEMANTIC similarity
 * (embeddings) — the second axis principle-clusters (per shared entity) misses.
 * Anti-anecdote guard: ≥2 events across ≥2 distinct SESSION_ID (not session_key,
 * which is stable per project). Pure, deterministic, no DB/LLM: embeddings are
 * injected so tests own the geometry.
 */

import { describe, it, expect } from "vitest";
import { selectUsageClusters } from "../usage-clusters.js";
import type { KbEvent } from "../../store/types.js";

/** Build a unit-ish 4-dim embedding from an angle so we control cosine. */
function vec(a: number, b: number, c = 0, d = 0): Float32Array {
  return new Float32Array([a, b, c, d]);
}

/** Minimal KbEvent factory — only the fields the clusterer reads. */
function evt(over: Partial<KbEvent>): KbEvent {
  return {
    id: over.id ?? "evt_x",
    ts: over.ts ?? "2026-07-01T00:00:00Z",
    recorded_at: over.recorded_at ?? "2026-07-01T00:00:00Z",
    session_key: over.session_key ?? "proj-A",
    session_id: over.session_id ?? "sess-1",
    namespace: over.namespace ?? "default",
    project: over.project ?? "tencentdb",
    type: over.type ?? "preference_stated",
    text: over.text ?? "some behavior",
    language: over.language ?? "it",
    entities: over.entities ?? [],
    source_message_ids: over.source_message_ids ?? [],
  };
}

describe("selectUsageClusters (B1 brain)", () => {
  it("clusters two semantically-close, ENTITY-LESS behaviors across 2 sessions", () => {
    const events = [
      evt({ id: "evt_a", session_id: "sess-1", text: "aspetta la mia risposta prima di procedere" }),
      evt({ id: "evt_b", session_id: "sess-2", text: "non partire finché non rispondo" }),
    ];
    const embeddings = new Map([
      ["evt_a", vec(1, 0)],
      ["evt_b", vec(0.99, 0.14)], // cosine ≈ 0.99 with evt_a
    ]);
    const clusters = selectUsageClusters(events, { embeddings });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].eventIds).toEqual(["evt_a", "evt_b"]);
    expect(clusters[0].sessionIds).toEqual(["sess-1", "sess-2"]);
  });

  it("ANECDOTE GUARD: two close behaviors in the SAME session do not cluster", () => {
    const events = [
      evt({ id: "evt_a", session_id: "sess-1" }),
      evt({ id: "evt_b", session_id: "sess-1" }),
    ];
    const embeddings = new Map([["evt_a", vec(1, 0)], ["evt_b", vec(1, 0)]]);
    expect(selectUsageClusters(events, { embeddings })).toHaveLength(0);
  });

  it("SESSION AXIS is session_id, not session_key: same project, different chats DO cluster", () => {
    // Both share session_key 'proj-A' (project is stable) but are distinct chats.
    // bug-clusters counts by session_key and would WRONGLY collapse these to 1
    // session → no cluster. B1 must count by session_id.
    const events = [
      evt({ id: "evt_a", session_key: "proj-A", session_id: "chat-1" }),
      evt({ id: "evt_b", session_key: "proj-A", session_id: "chat-2" }),
    ];
    const embeddings = new Map([["evt_a", vec(1, 0)], ["evt_b", vec(1, 0)]]);
    const clusters = selectUsageClusters(events, { embeddings });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sessionIds).toEqual(["chat-1", "chat-2"]);
  });

  it("does NOT cluster semantically distant behaviors", () => {
    const events = [
      evt({ id: "evt_a", session_id: "sess-1" }),
      evt({ id: "evt_b", session_id: "sess-2" }),
    ];
    const embeddings = new Map([["evt_a", vec(1, 0)], ["evt_b", vec(0, 1)]]); // orthogonal
    expect(selectUsageClusters(events, { embeddings })).toHaveLength(0);
  });

  it("excludes ineligible types (bugs belong to lessons, not usage)", () => {
    const events = [
      evt({ id: "evt_a", session_id: "sess-1", type: "bug" }),
      evt({ id: "evt_b", session_id: "sess-2", type: "bug" }),
    ];
    const embeddings = new Map([["evt_a", vec(1, 0)], ["evt_b", vec(1, 0)]]);
    expect(selectUsageClusters(events, { embeddings })).toHaveLength(0);
  });

  it("skips events without an embedding (no vector = not processable)", () => {
    const events = [
      evt({ id: "evt_a", session_id: "sess-1" }),
      evt({ id: "evt_b", session_id: "sess-2" }),
    ];
    const embeddings = new Map([["evt_a", vec(1, 0)]]); // evt_b missing
    expect(selectUsageClusters(events, { embeddings })).toHaveLength(0);
  });

  it("carries provenance and picks the dominant session_key + project", () => {
    const events = [
      evt({ id: "evt_a", session_id: "s1", session_key: "proj-A", project: "sofia", source_message_ids: ["m1"] }),
      evt({ id: "evt_b", session_id: "s2", session_key: "proj-A", project: "sofia", source_message_ids: ["m2"] }),
    ];
    const embeddings = new Map([["evt_a", vec(1, 0)], ["evt_b", vec(1, 0)]]);
    const [c] = selectUsageClusters(events, { embeddings });
    expect(c.sourceMessageIds.sort()).toEqual(["m1", "m2"]);
    expect(c.sessionKey).toBe("proj-A");
    expect(c.project).toBe("sofia");
    expect(c.texts).toHaveLength(2);
    expect(typeof c.theme).toBe("string");
  });

  it("never throws — returns [] on degenerate input", () => {
    expect(selectUsageClusters([], { embeddings: new Map() })).toEqual([]);
    // @ts-expect-error deliberately malformed
    expect(selectUsageClusters(null, { embeddings: new Map() })).toEqual([]);
  });
});
