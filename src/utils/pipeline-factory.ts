/**
 * Pipeline factory: shared infrastructure for creating and wiring
 * MemoryPipelineManager instances with VectorStore, EmbeddingService,
 * L1 runner, L2 runner, L3 runner, and persister.
 *
 * Used by both:
 * - `index.ts` (live plugin runtime)
 * - `seed-runtime.ts` (standalone seed CLI command)
 *
 * This avoids duplicating VectorStore init, L1/L2/L3 extraction logic,
 * persister wiring, and destroy sequences across multiple callers.
 */

import fs from "node:fs";
import path from "node:path";
import type { MemoryTdaiConfig } from "../config.js";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { L2Runner, L3Runner } from "./pipeline-manager.js";
import { SessionFilter } from "./session-filter.js";
import { extractL1Memories } from "../core/record/l1-extractor.js";
import { extractKbDelta } from "../core/kb/kb-extractor.js";
import type { KbWriterStore } from "../core/kb/kb-writer.js";
import { readConversationMessagesGroupedBySessionId } from "../core/conversation/l0-recorder.js";
import type { ConversationMessage } from "../core/conversation/l0-recorder.js";
import { CheckpointManager } from "./checkpoint.js";
import type { PipelineSessionState } from "./checkpoint.js";
import { createStoreBundle } from "../core/store/factory.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import {
  readManifest,
  writeManifest,
  buildStoreInfo,
  diffStoreBinding,
  type Manifest,
} from "./manifest.js";
import { SceneExtractor } from "../core/scene/scene-extractor.js";
import { PersonaTrigger } from "../core/persona/persona-trigger.js";
import { PersonaGenerator } from "../core/persona/persona-generator.js";
import { pullProfilesToLocal, syncLocalProfilesToStore } from "../core/profile/profile-sync.js";

const TAG = "[memory-tdai] [pipeline-factory]";

function supportsProfileSyncWrite(store?: IMemoryStore): boolean {
  return !!(store?.syncProfiles || store?.deleteProfiles);
}

/**
 * Whether a store implements the KB write/embed primitives required by the
 * Phase-2 "kb" extraction engine. Used to decide if the kb-extractor can run;
 * if any primitive is missing (e.g. a non-sqlite backend, or KB not ready) the
 * runner safely falls back to the legacy "l1" path.
 */
function supportsKbWrite(store?: IMemoryStore): store is IMemoryStore & KbWriterStore {
  if (!store) return false;
  // `isKbReady` exists on the concrete VectorStore (not on IMemoryStore); when
  // present and false, KB tables aren't ready → fall back.
  const ready = (store as unknown as { isKbReady?: () => boolean }).isKbReady;
  if (typeof ready === "function" && !ready.call(store)) return false;
  return (
    typeof store.resolveOrCreateEntity === "function" &&
    typeof store.insertEvent === "function" &&
    typeof store.upsertFact === "function" &&
    typeof store.upsertRelation === "function" &&
    typeof store.queryEntityById === "function" &&
    typeof store.upsertKbVector === "function" &&
    typeof store.upsertKbFts === "function"
  );
}

// ============================
// Logger interface
// ============================

export interface PipelineLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// ============================
// Factory options
// ============================

export interface PipelineFactoryOptions {
  /** Plugin data directory (L0, records, scene_blocks, vectors.db, etc.). */
  pluginDataDir: string;
  /** Parsed memory-tdai config. */
  cfg: MemoryTdaiConfig;
  /** OpenClaw config object (needed for LLM calls in L1). */
  openclawConfig: unknown;
  /** Logger instance. */
  logger: PipelineLogger;
  /** Session filter (optional, defaults to empty). */
  sessionFilter?: SessionFilter;
  /** Host-neutral LLM runner for L1 extraction (text-only, enableTools=false). */
  l1LlmRunner?: import("../core/types.js").LLMRunner;
  /** Host-neutral LLM runner for L2/L3 (tool-call enabled, enableTools=true). */
  l2l3LlmRunner?: import("../core/types.js").LLMRunner;
}

// ============================
// Factory result
// ============================

export interface PipelineInstance {
  /** The pipeline scheduler. */
  scheduler: MemoryPipelineManager;
  /** VectorStore (undefined if init failed or degraded). */
  vectorStore: IMemoryStore | undefined;
  /** EmbeddingService (undefined if not configured or init failed). */
  embeddingService: EmbeddingService | undefined;
  /**
   * Destroy all resources (scheduler, VectorStore, EmbeddingService).
   * Call this on shutdown / cleanup.
   */
  destroy: () => Promise<void>;
}

// ============================
// Data directory init
// ============================

/**
 * Ensure all required data subdirectories exist under `pluginDataDir`.
 * Safe to call multiple times (mkdirSync with `recursive: true`).
 */
export function initDataDirectories(dataDir: string): void {
  const dirs = ["conversations", "records", "scene_blocks", ".metadata", ".backup"];
  for (const sub of dirs) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
}

// ============================
// Store init (once-async singleton)
// ============================

export interface StoreInitResult {
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  /** Whether a background re-index is needed (embedding config changed). */
  needsReindex: boolean;
  reindexReason?: string;
}

/**
 * Cached store init promises — keyed by `pluginDataDir` so that different
 * data directories (e.g. live runtime vs. seed output) each get their own
 * store instance, while concurrent callers for the *same* directory share
 * one initialization.
 */
const _storeInitCache = new Map<string, Promise<StoreInitResult>>();

/**
 * Initialize store backend and (optionally) EmbeddingService.
 *
 * **Once-async semantics per dataDir**: the first call for a given
 * `pluginDataDir` creates the store and caches the result; subsequent
 * calls with the same dir return the cached Promise immediately.
 * Call `resetStores()` during shutdown to clear the cache.
 *
 * Supports both SQLite (sync init) and TCVDB (async init) backends.
 */
export function initStores(
  cfg: MemoryTdaiConfig,
  pluginDataDir: string,
  logger: PipelineLogger,
): Promise<StoreInitResult> {
  const key = pluginDataDir;
  if (!_storeInitCache.has(key)) {
    _storeInitCache.set(key, _doInitStores(cfg, pluginDataDir, logger));
  }
  return _storeInitCache.get(key)!;
}

/**
 * Reset the cached store singleton(s).
 *
 * Call this during `gateway_stop` (after closing the actual store/embedding
 * resources) so that a subsequent `register()` on hot-restart can
 * re-initialize fresh instances.
 *
 * @param pluginDataDir  If provided, only clear the cache for that dir.
 *                       If omitted, clear all cached stores.
 */
export function resetStores(pluginDataDir?: string): void {
  if (pluginDataDir) {
    _storeInitCache.delete(pluginDataDir);
  } else {
    _storeInitCache.clear();
  }
}

/**
 * Internal: actual store initialization logic (called once by the cache).
 */
async function _doInitStores(
  cfg: MemoryTdaiConfig,
  pluginDataDir: string,
  logger: PipelineLogger,
): Promise<StoreInitResult> {
  let vectorStore: IMemoryStore | undefined;
  let embeddingService: EmbeddingService | undefined;
  let needsReindex = false;
  let reindexReason: string | undefined;

  try {
    const bundle = createStoreBundle(cfg, {
      dataDir: pluginDataDir,
      logger,
    });
    vectorStore = bundle.store;
    embeddingService = bundle.embedding ?? undefined;

    const providerInfo = embeddingService?.getProviderInfo();
    const initResult = await vectorStore.init(providerInfo);

    if (vectorStore.isDegraded()) {
      logger.warn(`${TAG} Store is in degraded mode, falling back to keyword dedup`);
      vectorStore = undefined;
      embeddingService = undefined;
    } else {
      logger.debug?.(
        `${TAG} Store initialized: backend=${cfg.storeBackend}, provider=${cfg.embedding.provider}`,
      );
      needsReindex = initResult.needsReindex;
      reindexReason = initResult.reason;

      // ── Manifest: first-write + config-drift detection ──
      try {
        const currentStoreInfo = buildStoreInfo(bundle.storeSnapshot);
        const existing = readManifest(pluginDataDir);

        if (!existing) {
          // First init — write manifest
          const manifest: Manifest = {
            version: 1,
            createdAt: new Date().toISOString(),
            store: currentStoreInfo,
            seed: null,
          };
          writeManifest(pluginDataDir, manifest);
          logger.debug?.(`${TAG} Manifest created: ${JSON.stringify(currentStoreInfo)}`);
        } else {
          // Compare persisted store binding against current config
          const diffs = diffStoreBinding(existing.store, currentStoreInfo);
          if (diffs.length > 0) {
            logger.debug?.(
              `${TAG} Store config differs from initial binding recorded in manifest ` +
              `(${diffs.join("; ")}). ` +
              `This is expected if the storage backend was switched intentionally.`,
            );
          }
        }
      } catch (err) {
        logger.warn(`${TAG} Failed to read/write manifest (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logger.warn(
      `${TAG} Store init failed; vector/FTS recall and dedup conflict detection will be unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    vectorStore = undefined;
    embeddingService = undefined;
  }

  return { vectorStore, embeddingService, needsReindex, reindexReason };
}

// ============================
// L1 Runner factory
// ============================

/**
 * Create the standard L1 runner function.
 *
 * Reads L0 messages (from VectorStore DB or JSONL fallback), groups by sessionId,
 * runs extractL1Memories for each group, and updates the checkpoint cursor.
 */
export function createL1Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  logger: PipelineLogger;
  /**
   * Getter for the plugin instance ID used for metric reporting.
   * Called at runner execution time (not at creation time) so that the ID is
   * available even when the runner is wired before instanceId is resolved.
   * Metrics are skipped when the getter returns undefined.
   */
  getInstanceId?: () => string | undefined;
  /** Host-neutral LLM runner for L1 extraction (standalone/gateway mode). */
  llmRunner?: import("../core/types.js").LLMRunner;
}): (params: { sessionKey: string }) => Promise<{ processedCount: number }> {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, embeddingService, logger, getInstanceId, llmRunner } = opts;
  const config = openclawConfig as Record<string, unknown> | undefined;

  return async ({ sessionKey }) => {
    if (!config && !llmRunner) {
      logger.debug?.(`${TAG} [l1] No OpenClaw config and no LLM runner, skipping L1 extraction`);
      return { processedCount: 0 };
    }

    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    const cp = await checkpoint.read();
    const runnerState = checkpoint.getRunnerState(cp, sessionKey);

    logger.info(
      `${TAG} [l1] Session ${sessionKey}: l1_cursor=${runnerState.last_l1_cursor || "(start)"}`,
    );

    try {
      // Each message keeps its recorded_at (write-time epoch ms) ALONGSIDE the
      // ConversationMessage we feed to extraction. The cursor is advanced using
      // recorded_at, so we MUST keep it attached to every message we read —
      // otherwise we cannot compute a cursor that matches exactly the messages
      // we actually fed to the LLM.
      type RunnerMsg = { msg: ConversationMessage; recordedAtMs: number };
      let groups: Array<{ sessionId: string; messages: RunnerMsg[] }>;

      if (vectorStore && !vectorStore.isDegraded()) {
        const l1Cursor = runnerState.last_l1_cursor > 0
          ? runnerState.last_l1_cursor
          : undefined;
        const dbGroups = await vectorStore.queryL0GroupedBySessionId(sessionKey, l1Cursor);
        groups = dbGroups.map((g) => ({
          sessionId: g.sessionId,
          messages: g.messages.map((m) => ({
            msg: {
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              timestamp: m.timestamp,
            },
            recordedAtMs: m.recordedAtMs,
          })),
        }));
        logger.debug?.(`${TAG} [l1] L0 data source: VectorStore DB`);
      } else {
        logger.debug?.(`${TAG} [l1] L0 data source: JSONL files (VectorStore unavailable)`);
        const jsonlGroups = await readConversationMessagesGroupedBySessionId(
          sessionKey,
          pluginDataDir,
          runnerState.last_l1_cursor || undefined,
          logger,
          50,
        );
        groups = jsonlGroups.map((g) => ({
          sessionId: g.sessionId,
          messages: g.messages.map((m) => ({ msg: m, recordedAtMs: m.recordedAtMs })),
        }));
      }

      if (groups.length === 0) {
        logger.debug?.(`${TAG} [l1] No new L0 messages for session ${sessionKey}`);
        return { processedCount: 0 };
      }

      const totalMessages = groups.reduce((sum, g) => sum + g.messages.length, 0);
      logger.info(
        `${TAG} [l1] Processing ${totalMessages} L0 messages across ${groups.length} sessionId group(s) for session ${sessionKey}`,
      );

      // ════════════════════════════════════════════════════════════════════
      //  CURSOR ADVANCEMENT — read this carefully, a fact lost here is a fact
      //  lost forever.
      //
      //  We read up to 50 un-extracted L0 messages per trigger, but the LLM is
      //  only fed a bounded WINDOW of messages per extraction call. We must
      //  NEVER advance the cursor past a message we did not actually feed to
      //  the LLM (that message would be skipped permanently), and we must NEVER
      //  advance past a message whose extraction FAILED (it would be lost too).
      //
      //  So we PAGE through each group in windows of WINDOW_SIZE messages:
      //    - feed exactly that window to extractL1Memories (pass WINDOW_SIZE as
      //      maxMessagesPerExtraction so the extractor's internal slice never
      //      drops the window's head);
      //    - on SUCCESS (including a legit empty extraction, extracted=0):
      //      advance the cursor to the max recorded_at of THIS window only;
      //    - on HARD FAILURE (LLM/parse error → success=false): stop paging and
      //      do NOT advance past this window, so the next trigger retries it.
      //
      //  This closes two historical bugs:
      //    BUG A — the cursor used to advance to the max recorded_at of ALL
      //            read messages unconditionally (even when extracted=0 or on
      //            failure), skipping un-extracted messages forever.
      //    BUG B — the extractor sliced to the LAST 10 messages, so a batch
      //            larger than 10 dropped its head while the cursor jumped past
      //            the whole batch. Paging in windows of WINDOW_SIZE feeds every
      //            message before its recorded_at can advance the cursor.
      // ════════════════════════════════════════════════════════════════════
      const WINDOW_SIZE = 10; // messages fed to the LLM per extraction call
      const BG_SIZE = 5;      // background-context budget inside the extractor

      // ── Extraction engine selection (Phase 2, gated by config) ──
      // "kb" requires BOTH a host-neutral LLM runner AND a KB-capable store.
      // When engine="kb" but a prerequisite is missing we fall back to "l1"
      // (loud warn) so capture never silently stalls. Default engine is "l1",
      // so the live OpenClaw capture path is unaffected.
      let useKbEngine = false;
      if (cfg.extraction.engine === "kb") {
        if (!llmRunner) {
          logger.warn(
            `${TAG} [l1] extraction.engine="kb" but no host-neutral LLM runner is wired ` +
            `(KB extractor cannot use CleanContextRunner) — falling back to "l1" engine`,
          );
        } else if (!supportsKbWrite(vectorStore)) {
          logger.warn(
            `${TAG} [l1] extraction.engine="kb" but the store does not support KB writes ` +
            `(KB not ready / non-sqlite backend) — falling back to "l1" engine`,
          );
        } else {
          useKbEngine = true;
          logger.info(`${TAG} [l1] Using Phase-2 "kb" extraction engine for session ${sessionKey}`);
        }
      }
      const kbStore =
        useKbEngine && supportsKbWrite(vectorStore) ? (vectorStore as IMemoryStore & KbWriterStore) : undefined;

      let totalExtracted = 0;
      let totalStored = 0;
      let lastSceneName: string | undefined;
      // The cursor we will persist: max recorded_at over every window that
      // succeeded. Starts undefined (= unchanged) so a failed first window
      // leaves the cursor exactly where it was.
      let cursorToPersist: number | undefined;
      let hardFailure = false;

      for (const group of groups) {
        logger.debug?.(
          `${TAG} [l1] Group sessionId=${group.sessionId || "(empty)"}: ${group.messages.length} messages`,
        );

        // Page this group in fixed windows. `i` walks the group; each window is
        // [i, i + WINDOW_SIZE). We feed ONLY the window's own messages to the
        // extractor (NOT prior messages): mixing background into `messages`
        // would let the extractor's quality filter + internal slice pull a
        // background message into the extracted set, re-extracting it and
        // breaking the no-double-extraction guarantee. Cross-window continuity
        // is preserved via `previousSceneName` threading below instead.
        for (let i = 0; i < group.messages.length; i += WINDOW_SIZE) {
          const windowMsgs = group.messages.slice(i, i + WINDOW_SIZE);

          // Normalized window result consumed by the cursor logic below. The
          // "l1" engine fills extractedCount/storedCount/lastSceneName; the
          // "kb" engine maps facts+events→extracted and leaves scene undefined.
          let l1Result: {
            success: boolean;
            extractedCount: number;
            storedCount: number;
            lastSceneName?: string;
          };

          if (useKbEngine && kbStore) {
            // ── Phase-2 "kb" engine: single-stage KbDelta → applyKbDelta ──
            const kbResult = await extractKbDelta({
              messages: windowMsgs.map((m) => m.msg),
              sessionKey,
              sessionId: group.sessionId,
              store: kbStore,
              embeddingService,
              llmRunner: llmRunner!,
              logger,
            });
            l1Result = {
              success: kbResult.success,
              extractedCount: kbResult.factsCount + kbResult.eventsCount,
              storedCount: kbResult.factsCount + kbResult.eventsCount,
            };
          } else {
            // ── Legacy "l1" engine (UNCHANGED) ──
            l1Result = await extractL1Memories({
              messages: windowMsgs.map((m) => m.msg),
              sessionKey,
              sessionId: group.sessionId,
              baseDir: pluginDataDir,
              config,
              options: {
                // Window length as the per-extraction cap: the extractor's
                // internal slice keeps the ENTIRE window (its head is never
                // dropped — that was BUG B).
                maxMessagesPerExtraction: windowMsgs.length,
                maxBackgroundMessages: BG_SIZE,
                enableDedup: cfg.extraction.enableDedup,
                maxMemoriesPerSession: cfg.extraction.maxMemoriesPerSession,
                model: cfg.extraction.model,
                previousSceneName: lastSceneName ?? (runnerState.last_scene_name || undefined),
                vectorStore,
                embeddingService,
                conflictRecallTopK: cfg.embedding.conflictRecallTopK,
                embeddingTimeoutMs: cfg.embedding.captureTimeoutMs ?? cfg.embedding.timeoutMs,
                llmRunner,
              },
              logger,
              instanceId: getInstanceId?.(),
            });
          }

          if (!l1Result.success) {
            // HARD FAILURE: leave the cursor at the last successful window so the
            // next trigger re-reads (and retries) this window and everything
            // after it. Stop paging immediately — order matters for retries.
            logger.warn(
              `${TAG} [l1] Extraction FAILED for window [${i}, ${i + windowMsgs.length}) ` +
              `of session ${sessionKey} — cursor held, will retry on next trigger`,
            );
            hardFailure = true;
            break;
          }

          totalExtracted += l1Result.extractedCount;
          totalStored += l1Result.storedCount;
          if (l1Result.lastSceneName) {
            lastSceneName = l1Result.lastSceneName;
          }

          // SUCCESS (including extracted=0): the cursor may move to the max
          // recorded_at of THIS window — every message in it was fed and
          // considered. Never let it move backwards.
          for (const m of windowMsgs) {
            if (m.recordedAtMs > (cursorToPersist ?? 0)) cursorToPersist = m.recordedAtMs;
          }
        }

        if (hardFailure) break;
      }

      // Advance the cursor to the max recorded_at of the SUCCESSFULLY-extracted
      // windows only. If even the first window failed, cursorToPersist is
      // undefined and the cursor stays put (full retry next trigger).
      await checkpoint.markL1ExtractionComplete(sessionKey, totalStored, cursorToPersist, lastSceneName);
      logger.info(
        `${TAG} [l1] L1 complete: extracted=${totalExtracted}, stored=${totalStored} ` +
        `(${groups.length} group(s), cursor=${cursorToPersist ?? "(unchanged)"}${hardFailure ? ", PARTIAL — failure held cursor" : ""})`,
      );

      return { processedCount: totalMessages };
    } catch (err) {
      logger.error(`${TAG} [l1] L1 failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      throw err;
    }
  };
}

// ============================
// Persister factory
// ============================

/**
 * Create the standard pipeline state persister.
 * Saves pipeline session states to the checkpoint file.
 */
export function createPersister(
  pluginDataDir: string,
  logger: PipelineLogger,
): (states: Record<string, PipelineSessionState>) => Promise<void> {
  return async (states) => {
    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    await checkpoint.mergePipelineStates(states);
  };
}

// ============================
// L2 Runner factory
// ============================

/**
 * Create the standard L2 runner function (scene extraction).
 *
 * Reads L1 memory records (incremental via VectorStore or JSONL fallback),
 * runs SceneExtractor, and returns the latest cursor for pipeline-manager
 * to track incremental progress.
 *
 * Used by both `index.ts` (live runtime) and `seed-runtime.ts` (seed CLI).
 */
export function createL2Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore | undefined;
  logger: PipelineLogger;
  instanceId?: string;
  /** Host-neutral LLM runner for L2 scene extraction (standalone/gateway mode). Must have enableTools=true. */
  llmRunner?: import("../core/types.js").LLMRunner;
}): L2Runner {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, logger, instanceId, llmRunner } = opts;
  let profileBaseline = new Map<string, { version: number; contentMd5: string; createdAtMs: number }>();

  return async (sessionKey: string, cursor?: string) => {
    logger.debug?.(
      `${TAG} [L2] session=${sessionKey}, updatedAfter=${cursor ?? "(full)"}`,
    );

    if (!openclawConfig && !llmRunner) {
      logger.warn(`${TAG} [L2] No OpenClaw config and no LLM runner, skipping scene extraction`);
      return;
    }

    let records: Array<{ content: string; created_at: string; id: string; updatedAt: string }>;

    if (vectorStore?.pullProfiles && !vectorStore.isDegraded()) {
      profileBaseline = await pullProfilesToLocal(pluginDataDir, vectorStore, logger);
    }

    if (vectorStore && !vectorStore.isDegraded()) {
      const { queryMemoryRecords } = await import("../core/record/l1-reader.js");
      const memRecords = await queryMemoryRecords(vectorStore, {
        sessionKey,
        updatedAfter: cursor,
      }, logger);

      if (memRecords.length === 0) {
        logger.debug?.(
          `${TAG} [L2] No new L1 records since cursor (session=${sessionKey}, updatedAfter=${cursor ?? "(full)"}), skipping scene extraction`,
        );
        return;
      }

      logger.debug?.(
        `${TAG} [L2] Incremental query returned ${memRecords.length} record(s) (session=${sessionKey})`,
      );

      records = memRecords.map((r) => ({
        content: r.content,
        created_at: r.createdAt,
        id: r.id,
        updatedAt: r.updatedAt,
      }));
    } else {
      logger.debug?.(`${TAG} [L2] VectorStore unavailable, falling back to JSONL read (session=${sessionKey})`);
      const { readMemoryRecords } = await import("../core/record/l1-reader.js");
      let sessionRecords = await readMemoryRecords(sessionKey, pluginDataDir, logger);

      if (cursor) {
        const beforeCount = sessionRecords.length;
        sessionRecords = sessionRecords.filter((r) => {
          const t = r.updatedAt || r.createdAt || "";
          return t > cursor;
        });
        logger.debug?.(
          `${TAG} [L2] JSONL time filter: ${beforeCount} → ${sessionRecords.length} record(s) (updatedAfter=${cursor})`,
        );
      }

      if (sessionRecords.length === 0) {
        logger.debug?.(`${TAG} [L2] No new L1 records found (JSONL fallback, session=${sessionKey}), skipping scene extraction`);
        return;
      }

      records = sessionRecords.map((r) => ({
        content: r.content,
        created_at: r.createdAt,
        id: r.id,
        updatedAt: r.updatedAt,
      }));
    }

    const extractor = new SceneExtractor({
      dataDir: pluginDataDir,
      config: openclawConfig!,
      model: cfg.persona.model,
      maxScenes: cfg.persona.maxScenes,
      sceneBackupCount: cfg.persona.sceneBackupCount,
      logger,
      instanceId,
      llmRunner,
    });

    const memories = records.map((r) => ({
      content: r.content,
      created_at: r.created_at,
      id: r.id,
    }));

    const preCheckpoint = new CheckpointManager(pluginDataDir, logger);
    const preState = await preCheckpoint.read();
    const preScenesProcessed = preState.scenes_processed;
    const preMemoriesSince = preState.memories_since_last_persona;
    const preTotalProcessed = preState.total_processed;

    const extractResult = await extractor.extract(memories);
    if (extractResult.success && extractResult.memoriesProcessed > 0) {
      const checkpoint = new CheckpointManager(pluginDataDir, logger);
      const postState = await checkpoint.read();
      if (
        postState.scenes_processed < preScenesProcessed ||
        postState.total_processed < preTotalProcessed
      ) {
        logger.warn(
          `${TAG} [L2] ⚠️ Checkpoint corruption detected! ` +
          `scenes_processed: ${preScenesProcessed} → ${postState.scenes_processed}, ` +
          `total_processed: ${preTotalProcessed} → ${postState.total_processed}, ` +
          `memories_since: ${preMemoriesSince} → ${postState.memories_since_last_persona}. ` +
          `Repairing...`,
        );
        await checkpoint.write({
          ...postState,
          scenes_processed: Math.max(postState.scenes_processed, preScenesProcessed),
          total_processed: Math.max(postState.total_processed, preTotalProcessed),
          memories_since_last_persona: Math.max(postState.memories_since_last_persona, preMemoriesSince),
        });
        logger.info(`${TAG} [L2] Checkpoint repaired`);
      }

      if (vectorStore && supportsProfileSyncWrite(vectorStore)) {
        await syncLocalProfilesToStore(pluginDataDir, vectorStore, profileBaseline, logger);
      }
      await checkpoint.incrementScenesProcessed();

      const latestCursor = records.reduce((latest, r) => {
        return r.updatedAt > latest ? r.updatedAt : latest;
      }, "");

      logger.debug?.(
        `${TAG} [L2] Extraction complete: processed=${extractResult.memoriesProcessed}, latestCursor=${latestCursor}`,
      );

      return { latestCursor: latestCursor || undefined };
    }
  };
}

// ============================
// L3 Runner factory
// ============================

/**
 * Create the standard L3 runner function (persona generation).
 *
 * Uses PersonaTrigger to check if generation is needed, then runs
 * PersonaGenerator. Used by both `index.ts` and `seed-runtime.ts`.
 */
export function createL3Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore?: IMemoryStore;
  logger: PipelineLogger;
  instanceId?: string;
  /** Host-neutral LLM runner for L3 persona generation (standalone/gateway mode). Must have enableTools=true. */
  llmRunner?: import("../core/types.js").LLMRunner;
}): L3Runner {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, logger, instanceId, llmRunner } = opts;

  return async () => {
    const trigger = new PersonaTrigger({
      dataDir: pluginDataDir,
      interval: cfg.persona.triggerEveryN,
      logger,
    });

    const { should, reason } = await trigger.shouldGenerate();
    if (!should) {
      logger.debug?.(`${TAG} [L3] Persona generation not needed`);
      return;
    }

    if (!openclawConfig && !llmRunner) {
      logger.warn(`${TAG} [L3] No OpenClaw config and no LLM runner, skipping persona generation`);
      return;
    }

    // Pull remote profiles to establish fresh baseline before generation.
    // This ensures syncLocalProfilesToStore() has correct baselineVersion
    // for the optimistic-lock check instead of defaulting to 0.
    let profileBaseline = new Map<string, { version: number; contentMd5: string; createdAtMs: number }>();
    if (vectorStore?.pullProfiles && !vectorStore.isDegraded()) {
      profileBaseline = await pullProfilesToLocal(pluginDataDir, vectorStore, logger);
    }

    logger.info(`${TAG} [L3] Starting persona generation: ${reason}`);
    const generator = new PersonaGenerator({
      dataDir: pluginDataDir,
      config: openclawConfig,
      model: cfg.persona.model,
      backupCount: cfg.persona.backupCount,
      logger,
      instanceId,
      llmRunner,
    });
    const genResult = await generator.generateLocalPersona(reason);
    if (!genResult) {
      logger.info(`${TAG} [L3] Persona generation skipped (no changes)`);
      return;
    }

    if (vectorStore && supportsProfileSyncWrite(vectorStore)) {
      await syncLocalProfilesToStore(pluginDataDir, vectorStore, profileBaseline, logger);
    }

    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    const cp = await checkpoint.read();
    await checkpoint.markPersonaGenerated(cp.total_processed);
    logger.info(`${TAG} [L3] Persona generation succeeded`);
  };
}

// ============================
// Pipeline Manager factory
// ============================

/**
 * Create a MemoryPipelineManager with the standard config mapping.
 */
export function createPipelineManager(
  cfg: MemoryTdaiConfig,
  logger: PipelineLogger,
  sessionFilter?: SessionFilter,
): MemoryPipelineManager {
  return new MemoryPipelineManager(
    {
      everyNConversations: cfg.pipeline.everyNConversations,
      enableWarmup: cfg.pipeline.enableWarmup,
      l1: { idleTimeoutSeconds: cfg.pipeline.l1IdleTimeoutSeconds },
      l2: {
        delayAfterL1Seconds: cfg.pipeline.l2DelayAfterL1Seconds,
        minIntervalSeconds: cfg.pipeline.l2MinIntervalSeconds,
        maxIntervalSeconds: cfg.pipeline.l2MaxIntervalSeconds,
        sessionActiveWindowHours: cfg.pipeline.sessionActiveWindowHours,
      },
    },
    logger,
    sessionFilter ?? new SessionFilter([]),
  );
}

// ============================
// Full pipeline factory
// ============================

/**
 * Create a fully wired pipeline instance: VectorStore + EmbeddingService +
 * MemoryPipelineManager with L1 runner and persister attached.
 *
 * This is the high-level entry point used by both `index.ts` and `seed-runtime.ts`.
 * Callers should attach L2/L3 runners after creation using `createL2Runner()`
 * and `createL3Runner()` from this module.
 */
export async function createPipeline(opts: PipelineFactoryOptions): Promise<PipelineInstance> {
  const { pluginDataDir, cfg, openclawConfig, logger, sessionFilter, l1LlmRunner } = opts;

  // Ensure data directories exist
  initDataDirectories(pluginDataDir);

  // Initialize stores (once-async: reuses cached result if already initialized)
  const stores = await initStores(cfg, pluginDataDir, logger);
  const { vectorStore, embeddingService } = stores;

  // Surface a needs-reindex condition at runtime. The legacy-vec-schema
  // migration in sqlite.ts DROPs + recreates the vec0 tables (they come back
  // EMPTY), so semantic recall returns nothing until the operator runs the
  // reindex CLI. needsReindex was previously only emitted at debug level and
  // then discarded — leaving the operator unaware their semantic recall is
  // silently empty. We WARN (do NOT auto-reindex: re-embedding all records at
  // startup would be unbounded and could race the live gateway). Keyword (FTS)
  // recall still works, so this is partial — not total — degradation.
  if (stores.needsReindex) {
    logger.warn(
      `${TAG} Vector index was rebuilt/cleared (reason: ${stores.reindexReason ?? "unknown"}). ` +
      `Semantic recall is EMPTY until you run: openclaw memory-tdai reindex --data-dir ${pluginDataDir}. ` +
      `Keyword recall still works.`,
    );
  }

  // Create pipeline manager
  const scheduler = createPipelineManager(cfg, logger, sessionFilter);

  // Wire L1 runner
  scheduler.setL1Runner(createL1Runner({
    pluginDataDir,
    cfg,
    openclawConfig,
    vectorStore,
    embeddingService,
    logger,
    llmRunner: l1LlmRunner,
  }));

  // Wire persister
  scheduler.setPersister(createPersister(pluginDataDir, logger));

  // Destroy function
  const destroy = async () => {
    logger.info(`${TAG} Destroying pipeline...`);
    await scheduler.destroy();
    if (vectorStore) {
      logger.info(`${TAG} Closing VectorStore`);
      vectorStore.close();
    }
    if (embeddingService?.close) {
      try {
        logger.info(`${TAG} Closing EmbeddingService`);
        await embeddingService.close();
      } catch (err) {
        logger.warn(`${TAG} Error closing EmbeddingService: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    resetStores(pluginDataDir);
    logger.info(`${TAG} Pipeline destroyed`);
  };

  return { scheduler, vectorStore, embeddingService, destroy };
}
