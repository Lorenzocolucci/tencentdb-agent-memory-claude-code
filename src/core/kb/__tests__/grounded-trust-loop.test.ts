import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { applyKbDelta } from "../kb-writer.js";
import { renderGroundedTrustInterrupt } from "../grounded-trust-ask.js";
import { parseProvenance, gateStateOf } from "../provenance.js";
import { getLifecycle } from "../lifecycle-writer.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * The WHOLE child-and-fire loop, end to end, against a real DB. Seeds an uncertain
 * IBAN memory via the real KB writer → the recall-time gate marks it pending → the
 * interrupt is rendered → Lorenzo confirms → it becomes authoritative and is no
 * longer asked. The recall MATCH itself (FTS/vector) is existing, separately tested
 * functionality and is verified live via the gateway /recall smoke; here we feed
 * the seeded unit into the gate directly so the loop assertion is deterministic
 * (not subject to FTS tokenization).
 */
describe("grounded-trust full loop (seed → gate → interrupt → confirm → learned)", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-30T18:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gt-loop-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("uncertain IBAN → recall → pending → interrupt → confirm → learned", async () => {
    const db = (store as never as { db: never }).db;

    // 1. Seed an uncertain (unverified) high-stakes memory via the real writer.
    const seeded = await applyKbDelta(
      {
        language: "it",
        entities: [{ ref: "e1", type: "person", name: "Sofia" }],
        events: [{ ref: "ev1", type: "decision", ts: now,
                   text: "the Sofia payout IBAN is IT60X0542811101000000123456",
                   entity_refs: ["e1"], source_message_ids: ["l0_m1"] }],
        facts: [], relations: [],
      } as never,
      { store: store as never, namespace: "default", sessionKey: "s1", now, logger: silent },
    );
    const evId = seeded.events[0]!.id;

    // 2-3. The unit resurfaces at recall and passes through the recall-time gate,
    // which marks the uncertain high-stakes unit pending (operative: IBAN→payment).
    const recalledText = "the Sofia payout IBAN is IT60X0542811101000000123456";
    store.gateRecalledUnits([{ owner_id: evId, owner_kind: "event", text: recalledText }], now);

    // 4. The interrupt is produced for it.
    const asks = store.getPendingAsks(5);
    const block = renderGroundedTrustInterrupt(asks);
    expect(block).toContain("FERMATI prima di agire");
    expect(block).toContain("IT60X0542811101000000123456");
    expect(block).toContain(`owner_id:"${evId}"`);

    // 5. Lorenzo CONFIRMS → it becomes authoritative (learned forever).
    store.confirmMemory({ ownerId: evId, ownerKind: "event", now: "2026-06-30T19:00:00.000Z" });
    const prov = parseProvenance(getLifecycle(db, evId, "event")!.provenance_json);
    expect(prov.trust).toBe("trusted");
    expect(gateStateOf(prov)).toBe("clear"); // confirm clears the gate

    // 6. Next recall no longer gates it (trusted → shouldGate false) → no interrupt.
    store.gateRecalledUnits([{ owner_id: evId, owner_kind: "event", text: recalledText }], now);
    expect(store.getPendingAsks(5).find((a) => a.owner_id === evId)).toBeUndefined();
  });
});
