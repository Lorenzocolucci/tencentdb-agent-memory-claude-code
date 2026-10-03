/**
 * performAutoRecall tells the gateway WHY it returned nothing: a finished selective recall
 * with nothing relevant is `silent`; a timeout / degraded search / legacy mode is not.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performAutoRecall, type RecallOutcome } from "../auto-recall.js";
import { SessionBannerTracker } from "../session-banner.js";
import { parseConfig } from "../../../config.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const emptyStore = { searchKbFts: () => [], listEventsBySession: () => [], rareKbTokens: () => new Set<string>() } as never;

async function turn(cfg: ReturnType<typeof parseConfig>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-silent-outcome-"));
  try {
    const tracker = new SessionBannerTracker();
    tracker.markEmitted("cc-1");
    const outcome: RecallOutcome = {};
    const result = await performAutoRecall({
      userText: "ok procedi", actorId: "a", sessionKey: "sk", sessionId: "cc-1", cfg,
      pluginDataDir: dir, logger: quiet, vectorStore: emptyStore, bannerTracker: tracker, outcome,
    });
    return { result, outcome };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("performAutoRecall outcome", () => {
  it("selective + nothing relevant → undefined result AND silent=true", async () => {
    const { result, outcome } = await turn(parseConfig({ recall: { source: "kb" } }));
    expect(result).toBeUndefined();
    expect(outcome.silent).toBe(true);
  });

  it("legacy mode (selective off) never claims silence", async () => {
    const { outcome } = await turn(parseConfig({ recall: { source: "kb", selective: { enabled: false } } }));
    expect(outcome.silent).toBeUndefined();
  });
});
