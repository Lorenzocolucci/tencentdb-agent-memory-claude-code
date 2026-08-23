/**
 * Repair pass for the friction backfill: add the missing kb_fts rows.
 *
 * `insertEvent` writes the event row only — the KB search surfaces (kb_fts for
 * keyword, kb_vec for meaning) are written separately by kb-writer's embed step.
 * The backfill therefore left its 866 historical failures invisible to BOTH
 * search paths, and — critically — invisible to `reindexKb`, which enumerates
 * owners FROM kb_fts (sqlite.ts:2091). No kb_fts row → never embedded → cannot
 * cluster → cannot become a lesson.
 *
 * This adds the kb_fts row for every `[backfill]` event that lacks one. It is
 * idempotent (upsert by owner_id) and additive: nothing existing is touched.
 * Afterwards run the normal `reindex-standalone --resume` to embed them.
 *
 * Usage: node --import tsx tools/repair-backfill-fts.mts [--commit]
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../src/core/store/sqlite.js";

const DB_DIR = "C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local";
const EMB = { provider: "deepinfra", model: "Qwen/Qwen3-Embedding-4B", dimensions: 1024 };
const COMMIT = process.argv.includes("--commit");

function main(): void {
  const dbPath = path.join(DB_DIR, "vectors.db");

  // Read the candidate list on a plain read-only handle first.
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  const events = ro
    .prepare("SELECT id, text, ts FROM events WHERE text LIKE '[backfill]%'")
    .all() as Array<{ id: string; text: string; ts: string }>;
  const withFts = new Set(
    (ro.prepare("SELECT DISTINCT owner_id FROM kb_fts").all() as Array<{ owner_id: string }>).map(
      (r) => r.owner_id,
    ),
  );
  ro.close();

  const missing = events.filter((e) => !withFts.has(e.id));
  console.log(`eventi [backfill]      : ${events.length}`);
  console.log(`gia' in kb_fts         : ${events.length - missing.length}`);
  console.log(`da riparare            : ${missing.length}`);

  if (!COMMIT) {
    console.log("\n(prova a vuoto — rilancia con --commit)");
    return;
  }

  const store = new VectorStore(dbPath, EMB.dimensions, {
    debug: () => {}, info: () => {}, warn: () => {}, error: (m: string) => console.error(m),
  });
  store.init({ provider: EMB.provider, model: EMB.model });

  let ok = 0;
  for (const e of missing) {
    const done = store.upsertKbFts?.({
      ownerId: e.id,
      ownerKind: "event",
      content: e.text,
      entityType: "",
      namespace: "default",
      updatedTime: e.ts,
    });
    if (done) ok++;
  }
  store.close();
  console.log(`\nkb_fts scritti         : ${ok}/${missing.length}`);
  console.log("Ora esegui il reindex --resume per creare i vettori.");
}

main();
