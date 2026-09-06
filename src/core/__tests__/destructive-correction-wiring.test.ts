/**
 * CONTRACT point 1 end-to-end through TdaiCore on the REAL sqlite store:
 *  - a destructive success (/observe with tool_risk) → one `observation` event
 *    tagged destructive, deduped, no injection/warning, and the session's
 *    last risky signature is set;
 *  - the user's NEXT prompt (/recall) that reads as a correction → one `bug`
 *    event whose tags link it to that signature (Mistake Notebook food);
 *  - a friction failure sets the risky signature too;
 *  - linking never delays or breaks recall (macrotask, errors swallowed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiCore } from "../tdai-core.js";
import { parseConfig } from "../../config.js";
import type { HostAdapter, Logger, LLMRunnerFactory, RuntimeContext } from "../types.js";
import type { SessionSituation } from "../hooks/session-situation.js";
import { DESTRUCTIVE_STAKES_TAG, SIGNATURE_TAG_PREFIX } from "../kb/destructive-capture.js";

function silentLogger(): Logger {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeAdapter(dataDir: string, logger: Logger): HostAdapter {
  const ctx: RuntimeContext = {
    userId: "default_user", sessionId: "sid", sessionKey: "s1", platform: "gateway", workspaceDir: dataDir, dataDir,
  };
  const runnerFactory: LLMRunnerFactory = { createRunner: () => ({ run: async () => "" }) };
  return { hostType: "standalone", getRuntimeContext: () => ctx, getLogger: () => logger, getLLMRunnerFactory: () => runnerFactory };
}

interface Internals {
  storeReady?: Promise<void>;
  sessionSituationByKey: Map<string, SessionSituation>;
}
const internals = (core: TdaiCore): Internals => core as unknown as Internals;

/** Let the setImmediate-scheduled correction link run. */
const drain = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

type Row = { id: string; type: string; text: string; entities_json: string; session_key: string };
function rows(core: TdaiCore, type?: string): Row[] {
  const db = (core.getVectorStore() as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } }).db;
  return (type
    ? db.prepare("SELECT id, type, text, entities_json, session_key FROM events WHERE type = ? ORDER BY recorded_at").all(type)
    : db.prepare("SELECT id, type, text, entities_json, session_key FROM events ORDER BY recorded_at").all()) as Row[];
}

describe("destructive successes + correction linking", () => {
  let dir: string;
  let core: TdaiCore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-destructive-"));
    const cfg = parseConfig({ extraction: { enabled: false }, embedding: { provider: "none" } });
    core = new TdaiCore({ hostAdapter: makeAdapter(dir, silentLogger()), config: cfg });
    await core.initialize();
    await internals(core).storeReady;
  });

  afterEach(async () => {
    await core.destroy().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records a destructive success as a tagged observation (no bug, no injection) and sets the risky signature", async () => {
    const res = await core.handleToolObservation({
      sessionKey: "s1",
      toolName: "Bash",
      toolInput: { command: "git checkout -- src/app.ts" },
      toolOutputIsError: false,
      toolOutputText: "Updated 1 path from the index",
      toolRisk: "destructive",
    });
    expect(res.inject).toBeUndefined();

    const obs = rows(core, "observation");
    expect(obs).toHaveLength(1);
    expect(obs[0].text).toContain("destructive command succeeded: Bash `git checkout -- src/app.ts`");
    const tags = JSON.parse(obs[0].entities_json) as string[];
    expect(tags).toContain(DESTRUCTIVE_STAKES_TAG);
    expect(tags.some((t) => t.startsWith(SIGNATURE_TAG_PREFIX + "Bash|"))).toBe(true);
    expect(rows(core, "bug")).toHaveLength(0);

    const sit = internals(core).sessionSituationByKey.get("s1")!;
    expect(sit.lastRiskySignature?.kind).toBe("destructive");
    expect(sit.lastRiskySignature?.eventId).toBe(obs[0].id);
    expect(sit.toolNames).toEqual(["Bash"]);
  });

  it("dedupes the same destructive command inside the window (one observation)", async () => {
    for (let i = 0; i < 3; i++) {
      await core.handleToolObservation({
        sessionKey: "s1", toolName: "Bash", toolInput: { command: "rm -rf dist" }, toolRisk: "destructive",
      });
    }
    expect(rows(core, "observation")).toHaveLength(1);
  });

  it("a failed destructive call goes to friction (bug), not to the observation path", async () => {
    await core.handleToolObservation({
      sessionKey: "s1", toolName: "Bash", toolInput: { command: "rm -rf /x" },
      toolOutputIsError: true, toolOutputText: "rm: cannot remove '/x': Permission denied", toolRisk: "destructive",
    });
    expect(rows(core, "observation")).toHaveLength(0);
    const bugs = rows(core, "bug");
    expect(bugs).toHaveLength(1);
    const sit = internals(core).sessionSituationByKey.get("s1")!;
    expect(sit.lastRiskySignature?.kind).toBe("failed");
    expect(JSON.parse(bugs[0].entities_json)).toContain(SIGNATURE_TAG_PREFIX + sit.lastRiskySignature!.signature);
  });

  it("the user's NEXT correction is written as a bug linked to the risky signature, then the signature is consumed", async () => {
    await core.handleToolObservation({
      sessionKey: "s1", toolName: "Bash", toolInput: { command: "git checkout -- src/app.ts" }, toolRisk: "destructive",
    });
    const obs = rows(core, "observation")[0];
    const sig = internals(core).sessionSituationByKey.get("s1")!.lastRiskySignature!.signature;

    const t0 = Date.now();
    const recall = await core.handleBeforeRecall("No, era sbagliato: hai buttato via le mie modifiche a app.ts", "s1", "proj");
    expect(recall).toBeDefined();
    // Nothing written on the recall stack itself: it is scheduled off-stack.
    expect(rows(core, "bug")).toHaveLength(0);
    await drain();
    expect(Date.now() - t0).toBeLessThan(5000);

    const bugs = rows(core, "bug");
    expect(bugs).toHaveLength(1);
    expect(bugs[0].text).toContain("correction after destructive Bash `git checkout -- src/app.ts`");
    expect(bugs[0].text).toContain("era sbagliato");
    expect(bugs[0].session_key).toBe("s1");
    const tags = JSON.parse(bugs[0].entities_json) as string[];
    expect(tags).toContain(SIGNATURE_TAG_PREFIX + sig);
    expect(tags).toContain("stakes:destructive");
    expect(tags).toContain("corrects:" + obs.id);

    // Consumed: a second correction does not link again.
    expect(internals(core).sessionSituationByKey.get("s1")!.lastRiskySignature).toBeUndefined();
    await core.handleBeforeRecall("ancora sbagliato", "s1", "proj");
    await drain();
    expect(rows(core, "bug")).toHaveLength(1);
  });

  it("a non-correction prompt, harness text, or no risky moment → nothing is linked", async () => {
    await core.handleBeforeRecall("è sbagliato tutto", "s1", "proj"); // no risky moment yet
    await drain();
    expect(rows(core, "bug")).toHaveLength(0);

    await core.handleToolObservation({
      sessionKey: "s1", toolName: "Bash", toolInput: { command: "rm -rf dist" }, toolRisk: "destructive",
    });
    await core.handleBeforeRecall("ok, ora aggiungi un test", "s1", "proj"); // not a correction
    await drain();
    await core.handleBeforeRecall("<system-reminder>sbagliato</system-reminder>", "s1", "proj"); // harness text
    await drain();
    expect(rows(core, "bug")).toHaveLength(0);
    // The risky moment is still pending for a real correction.
    expect(internals(core).sessionSituationByKey.get("s1")!.lastRiskySignature).toBeDefined();
  });

  it("linking never breaks recall: a throwing store is swallowed", async () => {
    await core.handleToolObservation({
      sessionKey: "s1", toolName: "Bash", toolInput: { command: "rm -rf dist" }, toolRisk: "destructive",
    });
    const store = core.getVectorStore() as unknown as { insertEvent: unknown };
    const original = store.insertEvent;
    store.insertEvent = vi.fn(() => { throw new Error("disk full"); });
    await expect(core.handleBeforeRecall("sbagliato, non dovevi", "s1", "proj")).resolves.toBeDefined();
    await drain();
    store.insertEvent = original;
    expect(rows(core, "bug")).toHaveLength(0);
  });
});
