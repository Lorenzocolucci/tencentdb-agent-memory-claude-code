/**
 * Regression test for the L1 COLD-START fact-loss bug (FIX 1).
 *
 * BUG (cold start): when last_l1_cursor === 0 (first-ever L1 for a session, or
 * a session whose L1 never ran), the L0 read used `ORDER BY recorded_at DESC
 * LIMIT 50` — the NEWEST 50 messages. The runner then advanced the cursor to
 * the newest message read. Any message older than that newest-50 window was
 * skipped FOREVER, because the next trigger only reads rows AFTER the cursor.
 *
 * FIX: the cold-start read is now ASC (OLDEST 50). Paging + per-window cursor
 * advancement walks the whole backlog across successive triggers, losing
 * nothing.
 *
 * This drives the REAL production runner (createL1Runner) against a real temp
 * SQLite store with a deterministic fake LLM that emits exactly one memory per
 * fed message. Invariant: every fed L0 message is extracted EXACTLY ONCE.
 *
 * This lives in its own file (not appended to l1-runner-no-loss.test.ts) so the
 * existing immutable test contract is left untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../core/store/sqlite.js";
import { createL1Runner } from "../pipeline-factory.js";
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
  const markerIdx = prompt.indexOf("【待提取的新消息】");
  const tail = markerIdx >= 0 ? prompt.slice(markerIdx) : prompt;
  const ids: string[] = [];
  const re = /\[(m\d+)\]\s*\[(?:user|assistant)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) ids.push(m[1]);
  return ids;
}

/** Fake LLM: returns ONE episodic memory per fed message, carrying the id. */
function makeFakeRunner(): { runner: LLMRunner } {
  const runner: LLMRunner = {
    async run(params: LLMRunParams): Promise<string> {
      const ids = newMessageIds(params.prompt);
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
  return { runner };
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

describe("L1 runner — COLD START no fact loss (cursor=0, backlog > read window)", () => {
  let dir: string;
  let store: VectorStore;
  const sessionKey = "sess-coldstart-no-loss";
  const cfg = parseConfig({
    extraction: { enableDedup: false, maxMemoriesPerSession: 200 },
    llm: { enabled: true },
  } as unknown as Record<string, unknown>);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-l1-coldstart-"));
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

  it("extracts EVERY message exactly once when 60 messages exist on a fresh session", async () => {
    // 60 messages, fresh session (last_l1_cursor=0). The read window is 50.
    // Pre-fix the cold-start read used DESC (newest-50 = m11..m60) and the
    // cursor jumped to m60, dropping m1..m10 forever. After the fix the read is
    // ASC (oldest-50 = m1..m50); the next trigger picks up m51..m60.
    const N = 60;
    seedL0(store, sessionKey, N, Date.parse("2026-06-16T00:00:00.000Z"));

    // Trigger 1 (cold start): reads the OLDEST 50 (m1..m50).
    const fake1 = makeFakeRunner();
    const runner1 = createL1Runner({
      pluginDataDir: dir, cfg, openclawConfig: {}, vectorStore: store,
      embeddingService: undefined, logger: silentLogger, llmRunner: fake1.runner,
    });
    await runner1({ sessionKey });

    // After the cold-start trigger it is m1..m50 (the HEAD) that is stored,
    // NOT m11..m60 (the tail the old DESC read would have produced).
    let counts = countStoredBySourceId(dir);
    expect(counts.size).toBe(50);
    for (let i = 1; i <= 50; i++) {
      expect(counts.get(`m${i}`), `m${i} (oldest head) must be stored after cold start`).toBe(1);
    }
    for (let i = 51; i <= 60; i++) {
      expect(counts.get(`m${i}`), `m${i} is beyond the 50-row window, not yet read`).toBeUndefined();
    }

    // Trigger 2: cursor is at m50, reads the remaining m51..m60.
    const fake2 = makeFakeRunner();
    const runner2 = createL1Runner({
      pluginDataDir: dir, cfg, openclawConfig: {}, vectorStore: store,
      embeddingService: undefined, logger: silentLogger, llmRunner: fake2.runner,
    });
    await runner2({ sessionKey });

    // All 60 stored exactly once — none lost (m1..m10 were the regression), none
    // double-extracted.
    counts = countStoredBySourceId(dir);
    expect(counts.size).toBe(N);
    for (let i = 1; i <= N; i++) {
      expect(counts.get(`m${i}`), `m${i} must be stored exactly once across cold-start triggers`).toBe(1);
    }
  });
});
