/**
 * runKbRecall — Phase 2.4/2.5 behaviours with `deferWrites` (the gateway mode):
 * the bookkeeping writes leave the critical path and run in one batched
 * setImmediate under the store's short busy_timeout; the injected RESULT is the
 * same as in the synchronous mode.
 */
import { describe, it, expect } from "vitest";
import { runKbRecall, getLastKbRecallPhases } from "../auto-recall.js";

const cfg: any = { recall: { maxResults: 5, rerank: false }, embedding: {} };
const sitEvent = {
  id: "e1", ts: "2026-07-06T10:00:00Z", recorded_at: "", session_key: "sk", session_id: "prev",
  namespace: "default", project: "p", type: "decision", text: "x", language: "und",
  entities: ["ent_sit"], source_message_ids: [],
};
const sit = { sessionKey: "sk", namespace: "default" };

function makeStore(log: string[], extra: Record<string, unknown> = {}) {
  return {
    searchKbFts: () => [],
    listEventsBySession: () => [sitEvent],
    associativeExpand: () => [
      { owner_id: "f1", owner_kind: "fact", text: "a", entity_id: "e1", activation: 0.9 },
      { owner_id: "f2", owner_kind: "fact", text: "b", entity_id: "e2", activation: 0.7 },
    ],
    gateRecalledUnits: () => { log.push("gate"); },
    recordRecallInjections: () => { log.push("ledger"); return 2; },
    reinforceRecalledOwners: (o: unknown[]) => { log.push(`reinforce:${o.length}`); return o.length; },
    ...extra,
  } as any;
}

describe("runKbRecall — deferred recall-path writes", () => {
  it("default (no option): writes still happen synchronously, in the historical order", async () => {
    const log: string[] = [];
    await runKbRecall("Ciao", cfg, undefined, makeStore(log), undefined, undefined, sit);
    expect(log).toEqual(["gate", "ledger", "reinforce:2"]);
  });

  it("deferWrites: nothing is written before the result returns; one batched setImmediate then flushes all three", async () => {
    const log: string[] = [];
    const res = await runKbRecall("Ciao", cfg, undefined, makeStore(log), undefined, undefined, sit, { deferWrites: true });
    expect(res.map((r) => r.owner_id)).toEqual(expect.arrayContaining(["f1", "f2"]));
    expect(log).toEqual([]); // off the critical path
    await new Promise((r) => setImmediate(r));
    expect(log).toEqual(["gate", "ledger", "reinforce:2"]);
  });

  it("deferred writes run inside the store's short busy_timeout wrapper when it exists", async () => {
    const log: string[] = [];
    const store = makeStore(log, {
      runWithShortBusyTimeout: (fn: () => unknown) => { log.push("short-timeout:begin"); const r = fn(); log.push("short-timeout:end"); return r; },
    });
    await runKbRecall("Ciao", cfg, undefined, store, undefined, undefined, sit, { deferWrites: true });
    await new Promise((r) => setImmediate(r));
    expect(log).toEqual(["short-timeout:begin", "gate", "ledger", "reinforce:2", "short-timeout:end"]);
  });

  it("a failing deferred write is logged and isolated: it never throws and the other writes still run", async () => {
    const log: string[] = [];
    const warns: string[] = [];
    const logger = { info() {}, warn: (m: string) => { warns.push(m); }, error() {}, debug() {} };
    const store = makeStore(log, { gateRecalledUnits: () => { throw new Error("db locked"); } });
    const res = await runKbRecall("Ciao", cfg, logger, store, undefined, undefined, sit, { deferWrites: true });
    expect(res.length).toBeGreaterThan(0);
    await new Promise((r) => setImmediate(r));
    expect(log).toEqual(["ledger", "reinforce:2"]);
    expect(warns.some((w) => w.includes('deferred write "gate" failed'))).toBe(true);
  });

  it("records per-phase timings (expand, writes) for the slow-recall breadcrumb", async () => {
    const log: string[] = [];
    await runKbRecall("Ciao", cfg, undefined, makeStore(log), undefined, undefined, sit);
    const phases = getLastKbRecallPhases();
    expect(phases.expand).toBeGreaterThanOrEqual(0);
    expect(phases["write:reinforce"]).toBeGreaterThanOrEqual(0);
    expect(phases.total).toBeGreaterThanOrEqual(0);
  });
});
