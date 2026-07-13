import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { applyKbDelta } from "../../kb/kb-writer.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("getPendingAsks — surfaces gated memories with their text", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-30T16:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-pending-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns an event marked pending with its real text + origin + domain", async () => {
    const result = await applyKbDelta(
      {
        language: "it",
        entities: [{ ref: "e1", type: "person", name: "Lorenzo" }],
        events: [{ ref: "ev1", type: "decision", ts: now,
                   text: "the payout IBAN is IT60X0542811101000000123456",
                   entity_refs: ["e1"], source_message_ids: ["l0_m1"] }],
        facts: [], relations: [],
      } as never,
      { store: store as never, namespace: "default", sessionKey: "s1", now, logger: silent },
    );
    const evId = result.events[0]!.id;

    // Recall-gate it (operative: IBAN → payment), then it should surface.
    store.gateRecalledUnits(
      [{ owner_id: evId, owner_kind: "event", text: "the payout IBAN is IT60X0542811101000000123456" }],
      now,
    );

    const asks = store.getPendingAsks(10);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.owner_id).toBe(evId);
    expect(asks[0]!.owner_kind).toBe("event");
    expect(asks[0]!.text).toContain("IT60X0542811101000000123456");
    expect(asks[0]!.origin).toBe("conversation");
    expect(asks[0]!.stakes_domain).toBe("payment");
  });

  it("does NOT surface a confirmed (trusted) or a benign clear memory", async () => {
    const result = await applyKbDelta(
      {
        language: "it",
        entities: [{ ref: "e1", type: "person", name: "Lorenzo" }],
        events: [{ ref: "ev1", type: "observation", ts: now, text: "the build is green",
                   entity_refs: ["e1"], source_message_ids: ["l0_m2"] }],
        facts: [], relations: [],
      } as never,
      { store: store as never, namespace: "default", sessionKey: "s1", now, logger: silent },
    );
    const evId = result.events[0]!.id;
    store.gateRecalledUnits([{ owner_id: evId, owner_kind: "event", text: "the build is green" }], now);

    expect(store.getPendingAsks(10)).toHaveLength(0);
  });
});
