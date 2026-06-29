import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { performAutoRecall } from "../../hooks/auto-recall.js";
import { parseConfig } from "../../../config.js";
import { defaultProvenance } from "../provenance.js";
import type { EmbeddingService } from "../../store/embedding.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const vec = new Float32Array([1, 0, 0, 0]);
const emb = { embed: async () => vec, getDimensions: () => 4 } as unknown as EmbeddingService;
const cfg = parseConfig({ recall: { strategy: "embedding", maxResults: 5, scoreThreshold: 0.1 } } as never);

function seedOneL1(store: VectorStore, sessionKey: string) {
  const now = new Date().toISOString();
  store.upsertL1(
    { id: "mem-1", content: "Un ricordo qualunque.", type: "episodic", priority: 50,
      scene_name: "x", source_message_ids: ["m1"], metadata: {}, timestamps: [now],
      createdAt: now, updatedAt: now, sessionKey, sessionId: "sid" } as never,
    vec,
  );
}

async function recallText(dir: string, store: VectorStore): Promise<string> {
  const r = await performAutoRecall({
    userText: "ricordo", actorId: "a", sessionKey: "s", cfg, pluginDataDir: dir,
    logger: silent, vectorStore: store, embeddingService: emb,
  });
  return (r?.prependContext ?? "") + "\n" + (r?.appendSystemContext ?? "");
}

describe("trust gates action, not injection", () => {
  it("an unverified stamp does not change recall output", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-inj-a-"));
    const a = new VectorStore(path.join(dirA, "vectors.db"), 4);
    a.init({ provider: "openai", model: "text-embedding-3-small" });
    seedOneL1(a, "s");
    const baseline = await recallText(dirA, a);
    a.close(); fs.rmSync(dirA, { recursive: true, force: true });

    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-inj-b-"));
    const b = new VectorStore(path.join(dirB, "vectors.db"), 4);
    b.init({ provider: "openai", model: "text-embedding-3-small" });
    seedOneL1(b, "s");
    b.stampProvenance("mem-1", "fact", defaultProvenance(["m1"]), new Date().toISOString());
    const stamped = await recallText(dirB, b);
    b.close(); fs.rmSync(dirB, { recursive: true, force: true });

    expect(stamped).toBe(baseline);
  });
});
