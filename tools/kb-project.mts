/**
 * kb-project.mts — STANDALONE one-shot projection regenerator (throwaway dev,
 * NOT shipped, like tools/kb-eval.mts).
 *
 * Opens the LIVE vectors.db, then deterministically REGENERATES persona.md +
 * scene_blocks/* + .metadata/scene_index.json FROM the entity-centric KB
 * (entities/facts/events/relations) via projectAll(). NO LLM. NO network. NO
 * embedding. It only READS the KB tables and WRITES the projection files.
 *
 * SAFETY / WHEN TO RUN:
 *   - This OVERWRITES persona.md + projector scene blocks (scene-*.md) +
 *     scene_index.json in the target data dir. Run it ONLY during a maintenance
 *     window, after backing up the data dir. It does NOT touch vectors.db (the
 *     store is opened, the KB is only read) and does NOT touch L0/L1/kb_vec/kb_fts.
 *   - DRY RUN by default: prints what it WOULD write without touching disk.
 *     Pass --write (or KB_PROJECT_WRITE=1) to actually write the files.
 *
 * Invocation:
 *   # dry run against the live data dir (default = the tdai-local plugin data dir)
 *   node_modules/.bin/tsx tools/kb-project.mts
 *   # actually write
 *   node_modules/.bin/tsx tools/kb-project.mts --write
 *   # override the data dir / db / namespace
 *   KB_PROJECT_DATADIR=/path/to/datadir KB_PROJECT_DB=/path/to/vectors.db \
 *     KB_PROJECT_NS=default node_modules/.bin/tsx tools/kb-project.mts --write
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { VectorStore } from "../src/core/store/sqlite.js";
import { projectAll } from "../src/core/kb/projections-writer.js";
import {
  projectPersonaBody,
  projectScenes,
  type ProjectionStore,
} from "../src/core/kb/projections.js";
import type { Logger } from "../src/core/types.js";

const DIMS = 1536;

// Default LIVE data dir (the tdai-local Claude Code plugin data dir).
const DEFAULT_DATADIR = path.join(
  os.homedir(),
  ".claude",
  "plugins",
  "data",
  "tdai-memory-tdai-local",
);

const DATADIR = process.env.KB_PROJECT_DATADIR || DEFAULT_DATADIR;
const DB_PATH = process.env.KB_PROJECT_DB || path.join(DATADIR, "vectors.db");
const NAMESPACE = process.env.KB_PROJECT_NS || "default";
const LOCALE = process.env.KB_PROJECT_LOCALE || "en";
const WRITE = process.argv.includes("--write") || process.env.KB_PROJECT_WRITE === "1";

const logger: Logger = {
  debug: () => {},
  info: (m: string) => process.stdout.write(`  ${m}\n`),
  warn: (m: string) => process.stdout.write(`  [warn] ${m}\n`),
  error: (m: string) => process.stdout.write(`  [ERROR] ${m}\n`),
};

async function main(): Promise<void> {
  process.stdout.write("=== KB PROJECT (deterministic persona + scene regen) ===\n");
  process.stdout.write(`data dir : ${DATADIR}\n`);
  process.stdout.write(`db       : ${DB_PATH}\n`);
  process.stdout.write(`namespace: ${NAMESPACE}\n`);
  process.stdout.write(`mode     : ${WRITE ? "WRITE (files will be overwritten)" : "DRY RUN (no files written)"}\n\n`);

  if (!fs.existsSync(DB_PATH)) {
    process.stdout.write(`STOP: db not found at ${DB_PATH}\n`);
    process.exit(1);
  }

  // Open the store (read path only — projections never write to the DB).
  const store = new VectorStore(DB_PATH, DIMS, logger);
  store.init({ provider: "openai", model: "text-embedding-3-small" });
  if (store.isDegraded() || !store.isKbReady()) {
    process.stdout.write("STOP: store degraded or KB not ready\n");
    process.exit(1);
  }

  const projectionStore = store as unknown as ProjectionStore;

  // ── Preview (always): what the projection produces ──
  const personaBody = projectPersonaBody(projectionStore, { namespace: NAMESPACE, locale: LOCALE });
  const { scenes } = projectScenes(projectionStore, { namespace: NAMESPACE, locale: LOCALE });

  process.stdout.write(`persona.md body: ${personaBody.length} chars\n`);
  process.stdout.write(`scenes        : ${scenes.length}\n`);
  for (const scene of scenes) {
    process.stdout.write(
      `  - ${scene.filename}  heat=${scene.index.heat}  summary="${scene.index.summary}"\n`,
    );
  }
  process.stdout.write("\n--- persona.md body (preview) ---\n");
  process.stdout.write(personaBody.slice(0, 1200));
  process.stdout.write(personaBody.length > 1200 ? "\n... [truncated]\n" : "\n");

  if (!WRITE) {
    process.stdout.write("\nDRY RUN complete — pass --write to regenerate the files.\n");
    store.close?.();
    return;
  }

  // ── Write: persona.md + scene_blocks/* + scene_index.json ──
  process.stdout.write("\nWriting projection files...\n");
  const result = await projectAll(projectionStore, {
    dataDir: DATADIR,
    namespace: NAMESPACE,
    locale: LOCALE,
    logger,
  });
  process.stdout.write(
    `DONE: wrote ${result.personaPath}, ${result.scenesWritten} scene block(s), ` +
      `removed ${result.scenesRemoved} stale projector scene(s).\n`,
  );

  store.close?.();
}

// Touch DatabaseSync import so the type is referenced (mirrors kb-eval style;
// kept available for an ad-hoc read-only probe if needed during maintenance).
void DatabaseSync;

main().catch((err) => {
  process.stdout.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
