/**
 * Grounded-trust asks, Phase 3.11: asked per PROJECT (not globally), ONCE per session,
 * and payment/identity values never appear in the question.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { applyKbDelta } from "../kb-writer.js";
import {
  AskedTracker,
  buildGroundedTrustBlock,
  redactSensitiveValues,
  renderGroundedTrustInterrupt,
  type PendingAsk,
} from "../grounded-trust-ask.js";

const IBAN = "IT60X0542811101000000123456";

describe("redactSensitiveValues", () => {
  it("removes IBANs, card numbers and fiscal codes", () => {
    expect(redactSensitiveValues(`the payout IBAN is ${IBAN}`)).not.toContain("IT60X05428");
    expect(redactSensitiveValues("carta 4111 1111 1111 1111 scade 12/29")).not.toContain("4111");
    expect(redactSensitiveValues("CF RSSMRA85T10A562S del cliente")).not.toContain("RSSMRA85T10A562S");
  });
  it("payment/credential domains also lose any long digit run or digit-bearing token", () => {
    const out = redactSensitiveValues("conto 123456789 e token abcd1234efgh", "payment");
    expect(out).not.toContain("123456789");
    expect(out).not.toContain("abcd1234efgh");
  });
  it("leaves ordinary text alone", () => {
    expect(redactSensitiveValues("deploy su Render il 9 ottobre")).toBe("deploy su Render il 9 ottobre");
  });
  it("the rendered interrupt never shows the IBAN (but still names the domain and the owner id)", () => {
    const ask: PendingAsk = { owner_id: "ev-1", owner_kind: "event", text: `the payout IBAN is ${IBAN}`, origin: "conversation", stakes_domain: "payment" };
    const out = renderGroundedTrustInterrupt([ask]);
    expect(out).not.toContain(IBAN);
    expect(out).toContain("[payment]");
    expect(out).toContain("/memory-confirm ev-1");
  });
});

describe("buildGroundedTrustBlock", () => {
  const ask = (id: string): PendingAsk => ({ owner_id: id, owner_kind: "event", text: "something to confirm", origin: "conversation", stakes_domain: "prod" });

  it("passes the project to the store and raises each ask once per session", () => {
    const seen: Array<{ project?: string }> = [];
    const store = { getPendingAsks: (_n?: number, o?: { project?: string }) => { seen.push(o ?? {}); return [ask("a"), ask("b")]; } };
    const tracker = new AskedTracker();
    const first = buildGroundedTrustBlock(store, { project: "Sofia-AI", sessionId: "s1", tracker });
    expect(first).toContain("/memory-confirm a");
    expect(first).toContain("/memory-confirm b");
    expect(seen[0]).toEqual({ project: "Sofia-AI" });
    expect(buildGroundedTrustBlock(store, { project: "Sofia-AI", sessionId: "s1", tracker })).toBe(""); // not again
    expect(buildGroundedTrustBlock(store, { project: "Sofia-AI", sessionId: "s2", tracker })).toContain("/memory-confirm a"); // new session
  });

  it("a newly pending ask is raised even if older ones were already asked", () => {
    let asks = [ask("a")];
    const store = { getPendingAsks: () => asks };
    const tracker = new AskedTracker();
    buildGroundedTrustBlock(store, { sessionId: "s1", tracker });
    asks = [ask("a"), ask("c")];
    const out = buildGroundedTrustBlock(store, { sessionId: "s1", tracker });
    expect(out).toContain("/memory-confirm c");
    expect(out).not.toContain("/memory-confirm a");
  });

  it("a store without getPendingAsks yields nothing", () => {
    expect(buildGroundedTrustBlock({}, { sessionId: "s1" })).toBe("");
  });
});

describe("VectorStore.getPendingAsks — project filter", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-30T16:00:00.000Z";
  const silent = { debug() {}, info() {}, warn() {}, error() {} };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-asks-scope-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function pendingEvent(project: string, sessionKey: string): Promise<string> {
    const text = `the payout IBAN is ${IBAN}`;
    const result = await applyKbDelta(
      {
        language: "it",
        entities: [{ ref: "e1", type: "concept", name: "Payout" }],
        events: [{ ref: "ev1", type: "decision", ts: now, text, entity_refs: ["e1"], source_message_ids: ["m1"] }],
        facts: [], relations: [],
      } as never,
      { store: store as never, namespace: "default", sessionKey, now, logger: silent, project },
    );
    const id = result.events[0]!.id;
    store.gateRecalledUnits([{ owner_id: id, owner_kind: "event", text }], now);
    return id;
  }

  it("asks only about the current project's memories (another project's payment memory is not this session's business)", async () => {
    const sofia = await pendingEvent("Sofia-AI", "sk-sofia");
    const tutor = await pendingEvent("Tutor-Agent", "sk-tutor");
    expect(store.getPendingAsks(10, { project: "Sofia-AI" }).map((a) => a.owner_id)).toEqual([sofia]);
    expect(store.getPendingAsks(10, { project: "Tutor-Agent" }).map((a) => a.owner_id)).toEqual([tutor]);
    expect(store.getPendingAsks(10).map((a) => a.owner_id).sort()).toEqual([sofia, tutor].sort()); // no project = old global behaviour
  });
});
