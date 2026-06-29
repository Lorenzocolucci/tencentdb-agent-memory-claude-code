import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { applyKbDelta } from "../kb-writer.js";
import { kbRecall } from "../retrieval.js";
import { renderGroundedTrustInterrupt } from "../grounded-trust-ask.js";
import { parseProvenance, gateStateOf } from "../provenance.js";
import { getLifecycle } from "../lifecycle-writer.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * The WHOLE child-and-fire loop, end to end, against a real DB with NO embedding
 * service (FTS recall path). Seeds an uncertain IBAN memory → recalls it → the
 * gate marks it pending → the interrupt is rendered → Lorenzo confirms → it
 * becomes authoritative and is no longer asked. This is the integrated proof the
 * unit tests cover only in pieces.
 */
describe("grounded-trust full loop (e2e, FTS recall, no embeddings)", () => {
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

    // 2. Recall it for real (FTS path — no embedding service supplied).
    const recalled = await kbRecall("Sofia payout IBAN", { store: store as never, maxResults: 5, logger: silent });
    const hit = recalled.find((r) => r.owner_id === evId);
    expect(hit, "the seeded IBAN memory must be recalled").toBeTruthy();

    // 3. The recall-time gate marks the uncertain high-stakes unit pending.
    store.gateRecalledUnits(
      recalled.map((r) => ({ owner_id: r.owner_id, owner_kind: r.owner_kind, text: r.text })),
      now,
    );

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
    store.gateRecalledUnits([{ owner_id: evId, owner_kind: "event", text: hit!.text }], now);
    expect(store.getPendingAsks(5).find((a) => a.owner_id === evId)).toBeUndefined();
  });
});
