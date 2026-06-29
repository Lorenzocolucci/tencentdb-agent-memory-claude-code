import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { getLifecycle } from "../../kb/lifecycle-writer.js";
import { parseProvenance, defaultProvenance } from "../../kb/provenance.js";

describe("confirmMemory upgrades trust and records the trail", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-29T12:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-confirm-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    // Seed: a lifecycle row for an event, stamped unverified.
    store.stampProvenance("ev-1", "event", defaultProvenance(["l0_1"]), now);
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("flips provenance to trusted and writes exactly one audit row (actor=user)", () => {
    const db = (store as never as { db: never }).db;

    store.confirmMemory({ ownerId: "ev-1", ownerKind: "event", now: "2026-06-29T13:00:00.000Z" });

    const life = getLifecycle(db, "ev-1", "event");
    const prov = parseProvenance(life!.provenance_json);
    expect(prov.origin).toBe("lorenzo_confirmed");
    expect(prov.trust).toBe("trusted");
    expect(prov.confirmed_by).toBe("lorenzo");
    expect(prov.confirmed_at).toBe("2026-06-29T13:00:00.000Z");

    const audit = (db as unknown as {
      prepare: (s: string) => { all: (...a: unknown[]) => unknown[] };
    })
      .prepare("SELECT operation, actor FROM memory_audit WHERE owner_id = ? AND owner_kind = ?")
      .all("ev-1", "event") as Array<{ operation: string; actor: string }>;
    const confirmRows = audit.filter((r) => r.operation === "confirm");
    expect(confirmRows).toHaveLength(1);
    expect(confirmRows[0]!.actor).toBe("user");
  });
});
