import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { getLifecycle } from "../../kb/lifecycle-writer.js";
import {
  parseProvenance,
  defaultProvenance,
  withPendingGate,
  gateStateOf,
} from "../../kb/provenance.js";

describe("rejectMemory tombstones a memory (no hard-delete)", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-30T12:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-reject-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    // Seed: an event already pending confirmation (high/payment).
    const pending = withPendingGate(defaultProvenance(["l0_1"]), {
      stakes: "high",
      stakes_domain: "payment",
    });
    store.stampProvenance("ev-1", "event", pending, now);
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("marks rejected + records rejected_at, the row SURVIVES, audit operation=reject (actor=user)", () => {
    const db = (store as never as { db: never }).db;

    store.rejectMemory({ ownerId: "ev-1", ownerKind: "event", now: "2026-06-30T13:00:00.000Z" });

    const life = getLifecycle(db, "ev-1", "event");
    expect(life, "row must STILL exist — tombstone, not delete").not.toBeNull();
    const prov = parseProvenance(life!.provenance_json);
    expect(gateStateOf(prov)).toBe("rejected");
    expect(prov.rejected_at).toBe("2026-06-30T13:00:00.000Z");

    const audit = (db as unknown as {
      prepare: (s: string) => { all: (...a: unknown[]) => unknown[] };
    })
      .prepare("SELECT operation, actor FROM memory_audit WHERE owner_id = ? AND owner_kind = ?")
      .all("ev-1", "event") as Array<{ operation: string; actor: string }>;
    const rejectRows = audit.filter((r) => r.operation === "reject");
    expect(rejectRows).toHaveLength(1);
    expect(rejectRows[0]!.actor).toBe("user");
  });
});
