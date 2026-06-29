import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { getLifecycle } from "../../kb/lifecycle-writer.js";
import {
  parseProvenance,
  defaultProvenance,
  gateStateOf,
} from "../../kb/provenance.js";

describe("gateRecalledUnits — recall-time operative gate (marks, never silences)", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-30T14:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gate-recall-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("gates an unverified IBAN-bearing recalled unit → pending_confirmation", () => {
    const db = (store as never as { db: never }).db;
    store.stampProvenance("ev-iban", "event", defaultProvenance(["l0_1"]), now);

    store.gateRecalledUnits(
      [{ owner_id: "ev-iban", owner_kind: "event", text: "the payout IBAN is IT60X0542811101000000123456" }],
      "2026-06-30T15:00:00.000Z",
    );

    const prov = parseProvenance(getLifecycle(db, "ev-iban", "event")!.provenance_json);
    expect(gateStateOf(prov)).toBe("pending_confirmation");
    expect(prov.stakes_domain).toBe("payment");
  });

  it("does NOT gate a benign unverified unit", () => {
    const db = (store as never as { db: never }).db;
    store.stampProvenance("ev-benign", "event", defaultProvenance(["l0_2"]), now);

    store.gateRecalledUnits(
      [{ owner_id: "ev-benign", owner_kind: "event", text: "the build is green" }],
      "2026-06-30T15:00:00.000Z",
    );

    const prov = parseProvenance(getLifecycle(db, "ev-benign", "event")!.provenance_json);
    expect(gateStateOf(prov)).toBe("clear");
  });

  it("does NOT gate a TRUSTED unit even if it bears an IBAN (already confirmed)", () => {
    const db = (store as never as { db: never }).db;
    store.stampProvenance("ev-trusted", "event", defaultProvenance(["l0_3"]), now);
    store.confirmMemory({ ownerId: "ev-trusted", ownerKind: "event", now });

    store.gateRecalledUnits(
      [{ owner_id: "ev-trusted", owner_kind: "event", text: "IBAN IT60X0542811101000000123456" }],
      "2026-06-30T15:00:00.000Z",
    );

    const prov = parseProvenance(getLifecycle(db, "ev-trusted", "event")!.provenance_json);
    expect(gateStateOf(prov)).toBe("clear"); // trusted → not gated
  });
});
