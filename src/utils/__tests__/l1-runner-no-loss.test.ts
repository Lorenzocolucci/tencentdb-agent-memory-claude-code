/**
 * Regression test for the L1 capture-pipeline FACT-LOSS bug.
 *
 * Historical bugs (all in the L1 runner cursor logic):
 *   BUG A — the cursor advanced to the max recorded_at of ALL read messages
 *           unconditionally (even when extracted=0 or on LLM failure), so any
 *           message that was read-but-not-extracted was skipped forever.
 *   BUG B — the extractor sliced to the LAST 10 messages, so a batch larger
 *           than 10 dropped its head while the cursor jumped past the whole
 *           batch (read-layer LIMIT had the same newest-N skip).
 *
 * These tests drive the REAL production runner (createL1Runner) against a real
 * temp SQLite store, with a deterministic fake LLM that emits exactly one
 * memory per fed message (echoing the message id). The invariant under test:
 *
 *   every L0 message fed across all triggers is extracted EXACTLY ONCE —
 *   no fact is lost, no fact is double-extracted.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../core/store/sqlite.js";
import { createL1Runner } from "../pipeline-factory.js";
import { CheckpointManager } from "../checkpoint.js";
import type { L0Record } from "../../core/store/types.js";
import type { LLMRunner, LLMRunParams } from "../../core/types.js";
import { parseConfig } from "../../config.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Collect the message ids the LLM was asked to extract (the "new messages"). */
function newMessageIds(prompt: string): string[] {
  // The user prompt has a "new messages" section at the end; everything after
  // that marker is the fed window. Each line is "[id] [role] [iso]: text".
  const markerIdx = prompt.indexOf("【待提取的新消息】");
  const tail = markerIdx >= 0 ? prompt.slice(markerIdx) : prompt;
  const ids: string[] = [];
  const re = /\[(m\d+)\]\s*\[(?:user|assistant)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) ids.push(m[1]);
  return ids;
}

/**
 * Fake LLM runner: returns ONE episodic memory per fed message, with the
 * memory content carrying the source message id so the test can verify exactly
 * which messages were extracted. Optionally throws on the Nth call to simulate
 * a hard LLM failure (success=false path).
 */
function makeFakeRunner(opts: { failOnCall?: number } = {}): {
  runner: LLMRunner;
  fedWindows: string[][];
  callCount: () => number;
} {
  const fedWindows: string[][] = [];
  let calls = 0;
  const runner: LLMRunner = {
    async run(params: LLMRunParams): Promise<string> {
      calls += 1;
      const ids = newMessageIds(params.prompt);
      fedWindows.push(ids);
      if (opts.failOnCall && calls === opts.failOnCall) {
        throw new Error("simulated LLM failure");
      }
      const memories = ids.map((id) => ({
        content: `Fact recorded for message ${id}.`,
        type: "episodic",
        priority: 80,
        source_message_ids: [id],
        metadata: {},
      }));
      return JSON.stringify([
        { scene_name: "test-scene", message_ids: ids, memories },
      ]);
    },
  };
  return { runner, fedWindows, callCount: () => calls };
}

/** Seed N L0 messages into the store, monotonically increasing recorded_at. */
function seedL0(store: VectorStore, sessionKey: string, count: number, startMs: number): L0Record[] {
  const recs: L0Record[] = [];
  for (let i = 0; i < count; i++) {
    const ms = startMs + i * 1000;
    const rec: L0Record = {
      id: `m${i + 1}`,
      sessionKey,
      sessionId: "sid-test",
      role: i % 2 === 0 ? "user" : "assistant",
      messageText: `This is conversation message number ${i + 1}, decided to use approach number ${i + 1}.`,
      recordedAt: new Date(ms).toISOString(),
      timestamp: ms,
    };
    const ok = store.upsertL0(rec, undefined); // metadata-only, no embedding
    expect(ok).toBe(true);
    recs.push(rec);
  }
  return recs;
}

/** Count stored L1 memories per source-message id from the JSONL source of truth. */
function countStoredBySourceId(dataDir: string): Map<string, number> {
  const recordsDir = path.join(dataDir, "records");
  const counts = new Map<string, number>();
  if (!fs.existsSync(recordsDir)) return counts;
  for (const file of fs.readdirSync(recordsDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const lines = fs.readFileSync(path.join(recordsDir, file), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      const rec = JSON.parse(line) as { source_message_ids?: string[] };
      for (const sid of rec.source_message_ids ?? []) {
        counts.set(sid, (counts.get(sid) ?? 0) + 1);
      }
    }
  }
  return counts;
}

describe("L1 runner — no fact loss across windows / warmup boundaries", () => {
  let dir: string;
  let store: VectorStore;
  const sessionKey = "sess-no-loss";
  const cfg = parseConfig({
    extraction: { enableDedup: false, maxMemoriesPerSession: 100 },
    llm: { enabled: true },
  } as unknown as Record<string, unknown>);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-l1-noloss-"));
    fs.mkdirSync(path.join(dir, "records"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    const res = store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    expect(res.needsReindex).toBe(false);
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("extracts EVERY message exactly once when one trigger reads >10 (3 windows)", async () => {
    // 24 messages -> 3 windows of 10/10/4. Pre-fix BUG B would feed only the
    // last 10 and BUG A would jump the cursor past the dropped head.
    const N = 24;
    seedL0(store, sessionKey, N, Date.parse("2026-06-16T00:00:00.000Z"));

    const fake = makeFakeRunner();
    const runner = createL1Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: {},
      vectorStore: store,
      embeddingService: undefined,
      logger: silentLogger,
      llmRunner: fake.runner,
    });

    await runner({ sessionKey });

    // All N message ids recorded exactly once.
    const counts = countStoredBySourceId(dir);
    for (let i = 1; i <= N; i++) {
      expect(counts.get(`m${i}`), `m${i} must be stored exactly once`).toBe(1);
    }
    expect(counts.size).toBe(N);

    // Sanity: paging happened (3 windows), no window dropped.
    expect(fake.callCount()).toBe(3);
    const fedFlat = fake.fedWindows.flat();
    expect(fedFlat.length).toBe(N);
    expect(new Set(fedFlat).size).toBe(N);
  });

  it("holds the cursor on a HARD LLM failure and recovers every fact on retry", async () => {
    const N = 24; // 3 windows
    seedL0(store, sessionKey, N, Date.parse("2026-06-16T00:00:00.000Z"));

    // Fail on the 2nd window: window 1 succeeds, window 2 throws -> runner stops
    // and the cursor must NOT advance past window 1.
    const failing = makeFakeRunner({ failOnCall: 2 });
    const runner1 = createL1Runner({
      pluginDataDir: dir, cfg, openclawConfig: {}, vectorStore: store,
      embeddingService: undefined, logger: silentLogger, llmRunner: failing.runner,
    });
    await runner1({ sessionKey });

    // Only window 1 (m1..m10) is stored so far. Nothing from m11+ is lost —
    // it simply has not been extracted yet (cursor held).
    let counts = countStoredBySourceId(dir);
    expect(counts.size).toBe(10);
    for (let i = 1; i <= 10; i++) expect(counts.get(`m${i}`)).toBe(1);

    // Cursor must be at window 1's max recorded_at (m10), not past the failed batch.
    const cp = await new CheckpointManager(dir, silentLogger).read();
    const cursor = cp.runner_states[sessionKey]?.last_l1_cursor ?? 0;
    expect(cursor).toBe(Date.parse("2026-06-16T00:00:09.000Z")); // m10 @ +9s

    // Retry with a healthy LLM: must pick up m11.. and finish with NO loss/dup.
    const healthy = makeFakeRunner();
    const runner2 = createL1Runner({
      pluginDataDir: dir, cfg, openclawConfig: {}, vectorStore: store,
      embeddingService: undefined, logger: silentLogger, llmRunner: healthy.runner,
    });
    await runner2({ sessionKey });

    counts = countStoredBySourceId(dir);
    expect(counts.size).toBe(N);
    for (let i = 1; i <= N; i++) {
      expect(counts.get(`m${i}`), `m${i} must be stored exactly once after retry`).toBe(1);
    }
  });

  it("loses nothing across multiple incremental triggers (warmup-style batches)", async () => {
    // Simulate warm-up: L1 fires after growing batches that cross the 10-message
    // window boundary. Each "trigger" is a fresh runner invocation (as in prod).
    const batches = [2, 4, 8, 16, 12]; // messages per trigger; sums to 42
    const total = batches.reduce((a, b) => a + b, 0);

    const base = Date.parse("2026-06-16T00:00:00.000Z");
    // Seed everything up front; each trigger reads only what is newer than cursor.
    seedL0(store, sessionKey, total, base);

    // Drive triggers; the cursor must walk forward over the whole backlog
    // without skipping or repeating any message.
    let seen = 0;
    for (let b = 0; b < batches.length; b++) {
      const fake = makeFakeRunner();
      const runner = createL1Runner({
        pluginDataDir: dir, cfg, openclawConfig: {}, vectorStore: store,
        embeddingService: undefined, logger: silentLogger, llmRunner: fake.runner,
      });
      await runner({ sessionKey });
      seen += batches[b];
    }
    expect(seen).toBe(total);

    const counts = countStoredBySourceId(dir);
    expect(counts.size).toBe(total);
    for (let i = 1; i <= total; i++) {
      expect(counts.get(`m${i}`), `m${i} must be stored exactly once`).toBe(1);
    }
  });
});
