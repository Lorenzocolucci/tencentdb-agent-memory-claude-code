import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { defaultProvenance, withPendingGate } from "../../kb/provenance.js";

describe("rejectedOwnerKeys — Phase 4: a tombstoned memory is suppressed from injection", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-30T17:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-rejsup-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("reports the rejected owner key, not the clear/pending ones", () => {
    store.stampProvenance("ev-clear", "event", defaultProvenance(["a"]), now);
    store.stampProvenance(
      "ev-pending", "event",
      withPendingGate(defaultProvenance(["b"]), { stakes: "high", stakes_domain: "vision" }),
      now,
    );
    store.stampProvenance(
      "ev-rej", "event",
      withPendingGate(defaultProvenance(["c"]), { stakes: "high", stakes_domain: "payment" }),
      now,
    );
    store.rejectMemory({ ownerId: "ev-rej", ownerKind: "event", now });

    const rejected = store.rejectedOwnerKeys([
      { owner_id: "ev-clear", owner_kind: "event" },
      { owner_id: "ev-pending", owner_kind: "event" },
      { owner_id: "ev-rej", owner_kind: "event" },
    ]);

    expect(rejected.has("event:ev-rej")).toBe(true);
    expect(rejected.has("event:ev-clear")).toBe(false);
    expect(rejected.has("event:ev-pending")).toBe(false);
  });

  it("returns an empty set when nothing is rejected", () => {
    store.stampProvenance("ev-1", "event", defaultProvenance(["a"]), now);
    expect(store.rejectedOwnerKeys([{ owner_id: "ev-1", owner_kind: "event" }]).size).toBe(0);
  });
});
