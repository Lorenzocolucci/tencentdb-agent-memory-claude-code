/**
 * Context Fingerprint (Idea 1) — the inject half.
 *
 * Given the current situation + the stored fingerprints, surface the memories
 * that mattered in the most similar past situation. Two-tier voice (Lorenzo's
 * choice): a STRONG match speaks assertively, a MEDIUM match speaks tentatively,
 * anything weaker stays silent. Owners already shown this session are deduped.
 */

import { describe, it, expect } from "vitest";
import { buildSituationInjection } from "../fingerprint-injection.js";
import type { StoredFingerprint } from "../../kb/fingerprint-writer.js";
import type { IMemoryStore } from "../../store/types.js";

/** Minimal store stub: only the two read primitives the builder uses. */
function fakeStore(entities: Record<string, { name: string; fact?: string }>): IMemoryStore {
  return {
    queryEntityById: (id: string) => {
      const e = entities[id];
      return e ? ({ id, name: e.name } as never) : null;
    },
    queryHeadFacts: (id: string) => {
      const e = entities[id];
      return e?.fact ? ([{ attribute: "note", value: e.fact }] as never) : ([] as never);
    },
  } as unknown as IMemoryStore;
}

const stored = (over: Partial<StoredFingerprint>): StoredFingerprint => ({
  id: "fp_1",
  session_key: "s0",
  ts: "2026-06-24T09:00:00.000Z",
  fileKeys: ["file:a.ts"],
  errorSignatures: [],
  taskType: "",
  toolNames: [],
  matchedOwnerIds: ["ent_1"],
  namespace: "default",
  ...over,
});

describe("buildSituationInjection", () => {
  const store = fakeStore({ ent_1: { name: "circuit-breaker.ts", fact: "retries capped at 3" } });

  it("returns null when there are no stored fingerprints", () => {
    expect(
      buildSituationInjection(store, { fileKeys: ["file:a.ts"], errorSignatures: [], taskType: "" }, [], new Set()),
    ).toBeNull();
  });

  it("speaks assertively on a strong match", () => {
    const res = buildSituationInjection(
      store,
      { fileKeys: ["file:a.ts"], errorSignatures: [], taskType: "" },
      [stored({ fileKeys: ["file:a.ts"], matchedOwnerIds: ["ent_1"] })],
      new Set(),
    );
    expect(res).not.toBeNull();
    expect(res!.block).toContain("<situation-memory>");
    expect(res!.block).toContain("circuit-breaker.ts");
    expect(res!.block.toLowerCase()).toContain("situation like this");
    expect(res!.ownerIds).toContain("ent_1");
  });

  it("speaks tentatively on a medium match", () => {
    // {a,b} vs {a,c} → Jaccard 1/3 ≈ 0.33 → medium
    const res = buildSituationInjection(
      store,
      { fileKeys: ["file:a.ts", "file:b.ts"], errorSignatures: [], taskType: "" },
      [stored({ fileKeys: ["file:a.ts", "file:c.ts"], matchedOwnerIds: ["ent_1"] })],
      new Set(),
    );
    expect(res).not.toBeNull();
    expect(res!.block.toLowerCase()).toContain("possibly related");
  });

  it("stays silent below the medium threshold", () => {
    const res = buildSituationInjection(
      store,
      { fileKeys: ["file:a.ts"], errorSignatures: [], taskType: "" },
      [stored({ fileKeys: ["file:zzz.ts"], matchedOwnerIds: ["ent_1"] })],
      new Set(),
    );
    expect(res).toBeNull();
  });

  it("dedupes owners already injected this session → null when nothing new", () => {
    const res = buildSituationInjection(
      store,
      { fileKeys: ["file:a.ts"], errorSignatures: [], taskType: "" },
      [stored({ fileKeys: ["file:a.ts"], matchedOwnerIds: ["ent_1"] })],
      new Set(["ent_1"]),
    );
    expect(res).toBeNull();
  });

  it("skips owners that no longer resolve to an entity", () => {
    const res = buildSituationInjection(
      store,
      { fileKeys: ["file:a.ts"], errorSignatures: [], taskType: "" },
      [stored({ fileKeys: ["file:a.ts"], matchedOwnerIds: ["ghost", "ent_1"] })],
      new Set(),
    );
    expect(res).not.toBeNull();
    expect(res!.ownerIds).toEqual(["ent_1"]);
  });
});
