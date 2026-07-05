/**
 * TdaiCore — Host-neutral facade for TDAI memory capabilities.
 *
 * This is the single entry point that both OpenClaw and Hermes/Gateway call
 * to perform recall, capture, search, and pipeline management. It depends
 * only on abstract interfaces (HostAdapter, LLMRunner), never on a specific host.
 *
 * Usage:
 *   // OpenClaw path (in-process)
 *   const adapter = new OpenClawHostAdapter({ api, pluginDataDir, config });
 *   const core = new TdaiCore({ hostAdapter: adapter, config: parsedCfg });
 *   await core.initialize();
 *   const recall = await core.handleBeforeRecall("user query", "session-1");
 *
 *   // Gateway path (HTTP)
 *   const adapter = new StandaloneHostAdapter({ ... });
 *   const core = new TdaiCore({ hostAdapter: adapter, config: parsedCfg });
 *   await core.initialize();
 *   // HTTP handler calls core.handleBeforeRecall / core.handleTurnCommitted / etc.
 */

import type {
  HostAdapter,
  Logger,
  LLMRunnerFactory,
  RecallResult,
  CaptureResult,
  CompletedTurn,
  MemorySearchParams,
  ConversationSearchParams,
} from "./types.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { IMemoryStore } from "./store/types.js";
import type { EmbeddingService } from "./store/embedding.js";
import { scheduleConsolidation } from "./kb/consolidation-scheduler.js";
import { captureSessionRecap } from "./continuity/recap-capture.js";
import { distillPrinciples } from "./kb/principle-runner.js";
import { extractSituation } from "./hooks/situation.js";
import { buildFileInjection, resolveFileOwnerId } from "./hooks/situation-injection.js";
import {
  EMPTY_SITUATION,
  updateSituation,
  type SessionSituation,
} from "./hooks/session-situation.js";
import { inferTaskType } from "./hooks/task-type.js";
import { buildSituationInjection } from "./hooks/fingerprint-injection.js";
import { canonicalKey } from "./kb/kb-queries.js";
import { performAutoRecall } from "./hooks/auto-recall.js";
import { SessionBannerTracker } from "./hooks/session-banner.js";
import { CornerstoneInjectionTracker, buildCornerstones } from "./distinctiveness/cornerstone-runner.js";
import { CornerstoneSessionCache } from "./distinctiveness/cornerstone-cache.js";
import { renderGroundedTrustInterrupt } from "./kb/grounded-trust-ask.js";
import { performAutoCapture } from "./hooks/auto-capture.js";
import { executeMemorySearch, formatSearchResponse } from "./tools/memory-search.js";
import { executeConversationSearch, formatConversationSearchResponse } from "./tools/conversation-search.js";
import {
  initDataDirectories,
  initStores,
  resetStores,
  createPipelineManager,
  createL1Runner,
  createPersister,
  createL2Runner,
  createL3Runner,
} from "../utils/pipeline-factory.js";
import { MemoryPipelineManager } from "../utils/pipeline-manager.js";
import { CheckpointManager } from "../utils/checkpoint.js";
import { SessionFilter } from "../utils/session-filter.js";
import { StandaloneLLMRunnerFactory } from "../adapters/standalone/llm-runner.js";

const TAG = "[memory-tdai] [core]";

/** Namespace for proactive-injection reads/writes (single-tenant today). */
const NAMESPACE = "default";
/** Bounded recent-fingerprint window scanned per situation match. */
const FP_QUERY_LIMIT = 200;

// ============================
// Constructor options
// ============================

export interface TdaiCoreOptions {
  /** Host adapter providing runtime context, logger, and LLM runner factory. */
  hostAdapter: HostAdapter;
  /** Parsed TDAI memory configuration. */
  config: MemoryTdaiConfig;
  /** Session filter for excluding internal/benchmark sessions. */
  sessionFilter?: SessionFilter;
  /** Plugin instance ID for metric reporting. */
  instanceId?: string;
}

// ============================
// TdaiCore
// ============================

export class TdaiCore {
  private hostAdapter: HostAdapter;
  private cfg: MemoryTdaiConfig;
  private logger: Logger;
  private dataDir: string;
  private runnerFactory: LLMRunnerFactory;
  private sessionFilter: SessionFilter;
  private instanceId?: string;

  // Lazy-initialized resources
  private vectorStore?: IMemoryStore;
  private embeddingService?: EmbeddingService;
  private scheduler?: MemoryPipelineManager;
  /**
   * Promise gate for the one-shot scheduler-start sequence.
   *
   * ``ensureSchedulerStarted`` reads a checkpoint file (async) and then
   * calls ``scheduler.start(restoredStates)``.  Under the Gateway, several
   * HTTP requests can reach ``handleTurnCommitted`` concurrently and all
   * race into that function.  Using a plain boolean flag is unsafe: the
   * first caller flips the flag to ``true`` *before* the await completes,
   * so subsequent callers slip past the check and touch the scheduler
   * before ``start()`` has actually run — which makes ``start()``'s
   * ``sessionStates.set(key, restored)`` later clobber the state that
   * those concurrent captures already incremented.
   *
   * Storing the in-flight promise lets every concurrent caller ``await``
   * the same start sequence.  Once it resolves the promise is kept as a
   * sentinel so subsequent calls are a single already-resolved await
   * (effectively a no-op).
   */
  private schedulerStartPromise?: Promise<void>;
  private storeReady?: Promise<void>;

  /**
   * In-flight fire-and-forget background tasks started by
   * ``handleTurnCommitted`` (currently: deferred L0 embedding for
   * SQLite-style stores — see auto-capture.ts path A).
   *
   * ``destroy()`` awaits all pending entries (with a hard timeout)
   * before closing ``vectorStore`` / ``embeddingService`` so that a
   * late ``updateL0Embedding`` cannot land on an already-closed
   * database connection.
   *
   * Each task registers itself on creation and removes itself in its
   * own ``finally`` handler, so the set stays bounded by the number
   * of currently-running background tasks.
   */
  private readonly bgTasks = new Set<Promise<void>>();

  /**
   * Files whose proactive memory has already been injected in a given session
   * (Track A 3+4). Enforces "once per file per session" so re-touching a file
   * does not re-inject. Cleared for a session in {@link handleSessionEnd}.
   */
  private readonly injectedFilesBySession = new Map<string, Set<string>>();

  /**
   * The rolling situation per session (Context Fingerprint / Idea 1): the SHAPE
   * of recent work (files + error signatures + tool mix) a fingerprint is built
   * and matched on. Cleared in {@link handleSessionEnd}.
   */
  private readonly sessionSituationByKey = new Map<string, SessionSituation>();

  /**
   * Owner ids already surfaced (by single-file OR situation injection) in a
   * session — the shared dedup set so a memory is shown at most once per session
   * across both injection paths. Cleared in {@link handleSessionEnd}.
   */
  private readonly injectedOwnersBySession = new Map<string, Set<string>>();

  /**
   * Tracks which sessionKeys have already fired the session-open banner.
   * One TRUE per sessionKey per process lifetime (in-memory, long-lived).
   */
  private readonly bannerTracker = new SessionBannerTracker();
  // Idea 5 (Distinctiveness Scorer): decay tracker (long-lived) + per-session block
  // cache so the corpus-embedding cost runs once per session, not per turn.
  private readonly cornerstoneTracker = new CornerstoneInjectionTracker();
  private readonly cornerstoneCache = new CornerstoneSessionCache();
  /** Session keys whose cornerstone block is being built off-path — dedupes the
   *  concurrent turns that arrive before the first background build commits. */
  private readonly cornerstoneInFlight = new Set<string>();

  constructor(opts: TdaiCoreOptions) {
    this.hostAdapter = opts.hostAdapter;
    this.cfg = opts.config;
    this.logger = opts.hostAdapter.getLogger();
    this.dataDir = opts.hostAdapter.getRuntimeContext().dataDir;
    this.runnerFactory = opts.hostAdapter.getLLMRunnerFactory();
    this.sessionFilter = opts.sessionFilter ?? new SessionFilter([]);
    this.instanceId = opts.instanceId;
  }

  // ============================
  // Lifecycle
  // ============================

  /**
   * Initialize data directories, storage, and pipeline scheduler.
   * Must be called once before any other methods.
   */
  async initialize(): Promise<void> {
    this.logger.debug?.(`${TAG} Initializing TDAI Core: dataDir=${this.dataDir}`);
    initDataDirectories(this.dataDir);

    // Initialize stores (async)
    this.storeReady = this.initStores();

    // Create pipeline manager (sync — does not need store)
    if (this.cfg.extraction.enabled) {
      this.scheduler = createPipelineManager(this.cfg, this.logger, this.sessionFilter);
      // Wire runners after store is ready (or after store init fails — runners
      // still work in degraded mode with JSONL fallback and no embedding)
      this.storeReady
        .then(() => this.wirePipelineRunners())
        .catch((err) => {
          this.logger.error(`${TAG} Store init failed; wiring pipeline runners in degraded mode: ${err instanceof Error ? err.message : String(err)}`);
          this.wirePipelineRunners();
        });
    }

    this.logger.debug?.(`${TAG} TDAI Core initialized`);
  }

  /**
   * Destroy all resources. Call on shutdown.
   */
  async destroy(): Promise<void> {
    this.logger.debug?.(`${TAG} Destroying TDAI Core...`);

    // Wait for store init to complete before tearing down
    await this.storeReady?.catch(() => {});

    if (this.scheduler && this.schedulerStartPromise) {
      await this.scheduler.destroy();
      this.schedulerStartPromise = undefined;
      this.logger.debug?.(`${TAG} Scheduler destroyed`);
    }

    // Drain fire-and-forget background tasks started by auto-capture
    // (currently: deferred L0 embedding writes).  We must wait for
    // them here — BEFORE closing vectorStore / embeddingService —
    // otherwise a late updateL0Embedding lands on an already-closed
    // DB connection and either throws "database is not open" or
    // (worse) corrupts state.  A hard timeout keeps destroy bounded
    // when a background task is stuck on a hung embed HTTP call.
    if (this.bgTasks.size > 0) {
      const pending = [...this.bgTasks];
      this.logger.debug?.(
        `${TAG} Draining ${pending.length} background task(s) before closing stores...`,
      );
      const BG_DRAIN_TIMEOUT_MS = 5_000;
      let drainTimeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending).then(() => undefined),
          new Promise<never>((_, reject) => {
            drainTimeoutId = setTimeout(
              () => reject(new Error("bgTasks drain timeout")),
              BG_DRAIN_TIMEOUT_MS,
            );
          }),
        ]);
        this.logger.debug?.(`${TAG} Background tasks drained`);
      } catch (err) {
        this.logger.warn(
          `${TAG} Background-task drain timed out (${BG_DRAIN_TIMEOUT_MS}ms): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Closing stores anyway — residual writes may surface as warnings.`,
        );
      } finally {
        if (drainTimeoutId !== undefined) clearTimeout(drainTimeoutId);
      }
    }

    if (this.vectorStore) {
      this.vectorStore.close();
      this.vectorStore = undefined;
      this.logger.debug?.(`${TAG} VectorStore closed`);
    }

    if (this.embeddingService?.close) {
      try {
        await this.embeddingService.close();
      } catch (err) {
        this.logger.warn(`${TAG} EmbeddingService close error: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.embeddingService = undefined;
    }

    resetStores(this.dataDir);
    this.logger.debug?.(`${TAG} TDAI Core destroyed`);
  }

  // ============================
  // Core capabilities
  // ============================

  /**
   * Handle recall (memory retrieval) before an LLM turn.
   * Maps to: OpenClaw `before_prompt_build` / Hermes `prefetch()`.
   */
  async handleBeforeRecall(
    userText: string,
    sessionKey: string,
    projectName?: string,
    sessionId?: string,
  ): Promise<RecallResult> {
    await this.storeReady?.catch(() => {});

    // Maintain the sessionKey → project registry (recall knows BOTH values). The
    // background extractor reads it to tag new events by project; recall scoping
    // relies on it. Best-effort, never blocks a turn.
    if (projectName) this.vectorStore?.setSessionProject?.(sessionKey, projectName);

    const result = await performAutoRecall({
      userText,
      actorId: "default_user",
      sessionKey,
      cfg: this.cfg,
      pluginDataDir: this.dataDir,
      projectName,
      sessionId,
      logger: this.logger,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      bannerTracker: this.bannerTracker,
      cornerstoneTracker: this.cornerstoneTracker,
      cornerstoneCache: this.cornerstoneCache,
    });

    // Commit the banner slot ONLY after a real (non-timed-out) result actually
    // carried it, so a slow/timed-out first turn retries the banner next turn
    // instead of permanently losing it (the once-per-session guarantee).
    // Key MUST match the one performAutoRecall peeked (sessionId ?? sessionKey).
    if (result?.bannerEmitted) {
      this.bannerTracker.markEmitted(sessionId ?? sessionKey);
      // First turn of a new session = the one reliably-fired event in the desktop
      // app. Kick the LLM distillation (lessons + principles) here so it actually
      // runs (handleSessionEnd/`/clear` rarely fires). Detached, off critical path.
      this.scheduleBackgroundDistillation();
    }

    // Cornerstone cache MISS → build the block OFF the recall critical path and
    // commit it to the per-session cache so the NEXT turn injects it. The corpus
    // embed (~5s on a cold connection) is NEVER awaited on the recall path: inline
    // it blew the cc hook's RECALL_TIMEOUT and silently dropped the whole
    // session-open injection on the first turn.
    if (result?.cornerstoneMiss) {
      this.buildCornerstoneInBackground(result.cornerstoneMiss.key);
    }

    // Grounded Trust Phase 3: surface the INTERRUPT for any uncertain, high-stakes
    // memory now pending Lorenzo's confirmation. Prepended to the turn context so
    // the agent must raise it before acting. Best-effort: never breaks the turn.
    const out: RecallResult = result ?? {};
    try {
      const store = this.vectorStore as
        | { getPendingAsks?: (n?: number) => import("./kb/grounded-trust-ask.js").PendingAsk[] }
        | undefined;
      if (store && typeof store.getPendingAsks === "function") {
        const asks = store.getPendingAsks(5);
        const block = renderGroundedTrustInterrupt(asks);
        if (block) {
          out.prependContext = out.prependContext ? `${block}\n\n${out.prependContext}` : block;
        }
      }
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][grounded-trust] interrupt injection failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return out;
  }

  /**
   * Build the cornerstone block for a session OFF the recall critical path and
   * commit it to the per-session cache, so the NEXT turn injects it. Fire-and-forget:
   * the corpus embed (~5s on a cold/contended connection) must never delay — let
   * alone drop — the session-open injection. All errors are swallowed (memory must
   * never break a turn). The in-flight guard dedupes concurrent first-turn requests.
   */
  private buildCornerstoneInBackground(key: string): void {
    if (!this.vectorStore) return;
    if (this.cornerstoneInFlight.has(key)) return;
    if (this.cornerstoneCache.get(key) !== undefined) return; // already committed
    const store = this.vectorStore;
    this.cornerstoneInFlight.add(key);
    void (async () => {
      try {
        const block = await buildCornerstones({
          vectorStore: store,
          embeddingService: this.embeddingService,
          injectionTracker: this.cornerstoneTracker,
          logger: this.logger,
        });
        // Commit even when "" (computed-empty) — a valid result that prevents
        // recomputing the corpus embed every turn for a corpus with no cornerstones.
        this.cornerstoneCache.commit(key, block);
      } catch (err) {
        this.logger.warn(
          `[memory-tdai] cornerstone background build failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.cornerstoneInFlight.delete(key);
      }
    })();
  }

  /**
   * Handle turn commitment (conversation capture + pipeline trigger).
   * Maps to: OpenClaw `agent_end` / Hermes `sync_turn()`.
   */
  async handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult> {
    await this.storeReady?.catch(() => {});
    await this.ensureSchedulerStarted();

    return performAutoCapture({
      messages: turn.messages,
      sessionKey: turn.sessionKey,
      sessionId: turn.sessionId,
      cfg: this.cfg,
      pluginDataDir: this.dataDir,
      logger: this.logger,
      scheduler: this.scheduler,
      originalUserText: turn.userText,
      originalUserMessageCount: turn.originalUserMessageCount,
      pluginStartTimestamp: turn.startedAt ?? Date.now(),
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      bgTaskRegistry: this.bgTasks,
    });
  }

  /**
   * Search L1 structured memories.
   * Maps to: `tdai_memory_search` tool.
   */
  async searchMemories(params: MemorySearchParams): Promise<{ text: string; total: number; strategy: string }> {
    const result = await executeMemorySearch({
      query: params.query,
      limit: params.limit ?? 5,
      type: params.type,
      scene: params.scene,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
      // Phase-4: route the tool through KB retrieval when recall.source = "kb"
      // (default "l1" → existing behavior unchanged).
      recallSource: this.cfg.recall.source,
      rerank: this.cfg.recall.rerank,
    });

    return {
      text: formatSearchResponse(result),
      total: result.total,
      strategy: result.strategy,
    };
  }

  /**
   * Search L0 raw conversations.
   * Maps to: `tdai_conversation_search` tool.
   */
  async searchConversations(params: ConversationSearchParams): Promise<{ text: string; total: number }> {
    const result = await executeConversationSearch({
      query: params.query,
      limit: params.limit ?? 5,
      sessionKey: params.sessionKey,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
    });

    return {
      text: formatConversationSearchResponse(result),
      total: result.total,
    };
  }

  /**
   * Grounded Trust ask-loop (Phase 3): record Lorenzo's answer to a gated memory.
   * `decision="confirm"` → the memory becomes authoritative (trusted); `"reject"`
   * → it is tombstoned (kept, never hard-deleted). Off the critical path: returns
   * a human line, never throws. Maps to: tdai_confirm_memory / tdai_reject_memory.
   */
  async resolveGatedMemory(params: {
    ownerId: string;
    ownerKind: "fact" | "event";
    decision: "confirm" | "reject";
  }): Promise<{ ok: boolean; text: string }> {
    await this.storeReady?.catch(() => {});
    const store = this.vectorStore;
    if (!store) return { ok: false, text: "Memory store unavailable." };
    const now = new Date().toISOString();
    try {
      if (params.decision === "confirm") {
        store.confirmMemory({ ownerId: params.ownerId, ownerKind: params.ownerKind, now });
        return { ok: true, text: `Confermato: il ricordo ${params.ownerKind} ${params.ownerId} è ora autorevole.` };
      }
      store.rejectMemory({ ownerId: params.ownerId, ownerKind: params.ownerKind, now });
      return { ok: true, text: `Rifiutato: il ricordo ${params.ownerKind} ${params.ownerId} è stato marcato come errato (lapide).` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`[memory-tdai][grounded-trust] resolveGatedMemory failed (non-fatal): ${msg}`);
      return { ok: false, text: `Operazione non riuscita: ${msg}` };
    }
  }

  /**
   * Mistake Notebook B3 — explicit avoidance confirmation. The agent calls this
   * when it followed a resurfaced lesson and the failure did NOT happen. Raises the
   * lesson's confidence + avoidance_count (Phase B path). Off the critical path.
   * Maps to: tdai_lesson_helped.
   */
  async confirmLessonHelped(lessonId: string): Promise<{ ok: boolean; text: string }> {
    await this.storeReady?.catch(() => {});
    const store = this.vectorStore;
    if (!store?.creditLessonAvoidance) return { ok: false, text: "Lessons store unavailable." };
    const ok = store.creditLessonAvoidance(lessonId, new Date().toISOString());
    return ok
      ? { ok: true, text: `Lezione ${lessonId} rinforzata: evitamento confermato.` }
      : { ok: false, text: `Lezione ${lessonId} non trovata.` };
  }

  /**
   * Pilastro B (Strada A) — the agent calls this when Lorenzo CONFIRMED that a
   * stance interrupt was right to fire. Raises the stance's willingness (it earns
   * more room to interrupt). Off the critical path. Maps to: tdai_stance_confirmed.
   */
  async confirmStanceFire(lessonId: string): Promise<{ ok: boolean; text: string }> {
    await this.storeReady?.catch(() => {});
    const store = this.vectorStore;
    if (!store?.creditStanceConfirmed) return { ok: false, text: "Lessons store unavailable." };
    const ok = store.creditStanceConfirmed(lessonId, new Date().toISOString());
    return ok
      ? { ok: true, text: `Stance ${lessonId} confermata: era giusto fermarsi — willingness in salita.` }
      : { ok: false, text: `Stance ${lessonId} non trovata.` };
  }

  /**
   * Pilastro B (Strada A) — the agent calls this when Lorenzo said a stance
   * interrupt was a FALSE ALARM. Lowers the stance's willingness (cry-wolf); a
   * stance rejected enough times suppresses itself. Off the critical path.
   * Maps to: tdai_stance_rejected.
   */
  async rejectStanceFire(lessonId: string): Promise<{ ok: boolean; text: string }> {
    await this.storeReady?.catch(() => {});
    const store = this.vectorStore;
    if (!store?.creditStanceRejected) return { ok: false, text: "Lessons store unavailable." };
    const ok = store.creditStanceRejected(lessonId, new Date().toISOString());
    return ok
      ? { ok: true, text: `Stance ${lessonId} segnata come falso allarme — willingness in discesa.` }
      : { ok: false, text: `Stance ${lessonId} non trovata.` };
  }

  /**
   * Handle end-of-conversation for a single session.
   *
   * ⚠️ Read this if you are editing the method:
   *
   * There are two distinct shutdown-ish events, and they must **NOT**
   * share an implementation:
   *
   *   - **`gateway_stop` (OpenClaw / process exit)**
   *     The host is going away.  Tear everything down — scheduler,
   *     VectorStore, EmbeddingService, caches.  That is
   *     {@link destroy}, not this method.
   *
   *   - **`on_session_end` (Hermes) / `POST /session/end` (Gateway)**
   *     One conversation ended while the process keeps serving other
   *     concurrent sessions.  **Only** this session's buffered work
   *     should be flushed; every other session's timers, buffers,
   *     pipeline state, and the shared scheduler itself MUST remain
   *     untouched.  That is this method.
   *
   * Historically this method did ``scheduler.destroy() +
   * createPipelineManager()``, which conflated the two semantics and
   * wiped concurrent sessions' in-memory state on every ``/session/end``
   * call.  That bug is covered by the concurrency test
   * ``P0-1: handleSessionEnd must be scoped to its session``.
   *
   * @param sessionKey  Session whose buffered work should be flushed.
   *                    Unknown keys are tolerated as a no-op so callers
   *                    don't have to pre-check whether the session was
   *                    already evicted or never produced a capture.
   */
  /**
   * Schedule the LLM distillation passes (Track B lessons + Pilastro C Fase 2
   * principles) as DETACHED background tasks — off the critical path, errors
   * swallowed, tracked in bgTasks so a shutdown drain awaits them.
   *
   * Called from BOTH handleSessionEnd AND the first turn of each session
   * (handleBeforeRecall, gated on bannerEmitted). Reason: handleSessionEnd fires
   * only on POST /session/end, which the plugin sends only on /clear — an event
   * the desktop app rarely produces. Wiring distillation there alone left it
   * effectively dead (verified: 0 lessons distilled in months). The first turn of
   * a session is the one reliably-fired event, so we also run it there. CHEAP:
   * no cluster → no LLM; idempotent (already-distilled skipped) → safe on both.
   */
  private scheduleBackgroundDistillation(): void {
    const runnerFactory = this.runnerFactory;
    const logger = this.logger;

    // Track B (Mistake Notebook): recurring-failure clusters → lessons.
    if (this.vectorStore?.runLessonDistillation) {
      const store = this.vectorStore;
      const distillTask = (async () => {
        try {
          const runner = runnerFactory.createRunner({ enableTools: false });
          const stats = await store.runLessonDistillation!(runner, {
            now: new Date().toISOString(),
            maxClusters: 3,
          });
          if (stats.inserted > 0 || stats.superseded > 0) {
            logger.info(
              `${TAG} [lessons] distilled: inserted=${stats.inserted}, superseded=${stats.superseded} ` +
                `(candidates=${stats.candidates}, skippedDuplicate=${stats.skippedDuplicate})`,
            );
          } else {
            logger.debug?.(`${TAG} [lessons] no new lessons (candidates=${stats.candidates})`);
          }
        } catch (err) {
          logger.warn(
            `${TAG} [lessons] distillation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
      this.bgTasks.add(distillTask);
      void distillTask.then(() => this.bgTasks.delete(distillTask));
    }

    // Pilastro C Fase 2 ("dimenticare con gusto"): recurring cross-session
    // DECISIONS → `principle` atoms. CONSERVATIVE: additive only (sources decay
    // via Fase 1, never deleted).
    if (typeof this.vectorStore?.insertEvent === "function" && typeof this.vectorStore?.listRecentEvents === "function") {
      const store = this.vectorStore;
      const principleTask = (async () => {
        try {
          const runner = runnerFactory.createRunner({ enableTools: false });
          const stats = await distillPrinciples(store, runner, {
            now: new Date().toISOString(),
            maxClusters: 3,
          });
          if (stats.inserted > 0) {
            logger.info(
              `${TAG} [principles] distilled: inserted=${stats.inserted} ` +
                `(candidates=${stats.candidates}, skippedDuplicate=${stats.skippedDuplicate})`,
            );
          } else {
            logger.debug?.(`${TAG} [principles] no new principles (candidates=${stats.candidates})`);
          }
        } catch (err) {
          logger.warn(
            `${TAG} [principles] distillation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
      this.bgTasks.add(principleTask);
      void principleTask.then(() => this.bgTasks.delete(principleTask));
    }

    // Percorso B (behavioral notebook) — recurring cross-session BEHAVIORAL
    // tendencies ("what you do") → `usage` atoms via SEMANTIC clustering. The
    // second axis principle-clusters (per-entity) misses: entity-less behaviors.
    // Deterministic, no LLM. CONSERVATIVE: additive only. Fire-and-forget.
    if (typeof this.vectorStore?.runUsageDistillation === "function") {
      const store = this.vectorStore;
      const usageTask = (async () => {
        try {
          const runner = runnerFactory.createRunner({ enableTools: false });
          const stats = await store.runUsageDistillation!(runner, {
            now: new Date().toISOString(),
            maxClusters: 3,
          });
          if (stats.inserted > 0) {
            logger.info(
              `${TAG} [usage] distilled: inserted=${stats.inserted} ` +
                `(candidates=${stats.candidates}, confirmed=${stats.confirmed}, ` +
                `skippedRejected=${stats.skippedRejected}, skippedDuplicate=${stats.skippedDuplicate})`,
            );
          } else {
            logger.debug?.(
              `${TAG} [usage] no new usage tendencies (candidates=${stats.candidates}, ` +
                `rejected=${stats.skippedRejected})`,
            );
          }
        } catch (err) {
          logger.warn(
            `${TAG} [usage] distillation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
      this.bgTasks.add(usageTask);
      void usageTask.then(() => this.bgTasks.delete(usageTask));
    }
  }

  async handleSessionEnd(sessionKey: string): Promise<void> {
    if (!sessionKey) return;
    await this.storeReady?.catch(() => {});

    // Immune system: ensure the scheduler is STARTED (per-session pipeline state
    // restored from checkpoint + recovery enqueued) BEFORE we flush. On a fresh
    // gateway that has not seen a capture yet, sessionStates is empty, so the
    // flush's runL1 bails on `!state` and silently does nothing — the session's
    // L0 backlog would stay frozen. ensureSchedulerStarted is idempotent, so
    // this is a cheap no-op once started.
    await this.ensureSchedulerStarted();

    // Flush THIS session's buffered pipeline work (no-op when extraction is
    // disabled and no scheduler exists).
    if (this.scheduler) {
      await this.scheduler.flushSession(sessionKey);
    }

    // Deterministic "sleep-time" consolidation (reinforce the session's
    // events + facts, decay the stale). Fire-and-forget: deferred to a
    // macrotask so the /session/end response is sent before the synchronous
    // sweep, and tracked in bgTasks so destroy() drains it before the DB
    // closes. A failing pass is logged and swallowed — it never breaks
    // session-end.
    scheduleConsolidation({
      store: this.vectorStore,
      sessionKey,
      now: new Date().toISOString(),
      register: (t) => this.bgTasks.add(t),
      unregister: (t) => this.bgTasks.delete(t),
      logger: this.logger,
    });

    // "Dove eravamo" — capture this session into a first-class session_recap
    // event (Sinapsys session-continuity). Deferred to a macrotask so the
    // /session/end response flushes first; tracked in bgTasks so destroy()
    // drains it before the DB closes. Errors are swallowed inside.
    // Runs AFTER the flush above so this session's events are queryable.
    if (this.vectorStore) {
      const store = this.vectorStore;
      const recapTask = new Promise<void>((resolve) => {
        setImmediate(() => {
          try {
            captureSessionRecap({
              store,
              sessionKey,
              now: new Date().toISOString(),
              logger: this.logger,
            });
          } finally {
            resolve();
          }
        });
      });
      this.bgTasks.add(recapTask);
      void recapTask.then(() => this.bgTasks.delete(recapTask));
    }

    // LLM distillation (Track B lessons + Pilastro C Fase 2 principles).
    // Scheduled here AND at the first turn of each session (see
    // scheduleBackgroundDistillation): handleSessionEnd fires only on /clear,
    // which the desktop app rarely sends, so this path alone left distillation
    // effectively dead (0 lessons ever distilled in months). Idempotent + cheap.
    this.scheduleBackgroundDistillation();

    // B3: credit successful AVOIDANCES for lessons that resurfaced this session and
    // did not relapse (implicit, Phase A) — confidence grows from successes, not only
    // failures (the step beyond MNL). Fire-and-forget, off the critical path.
    if (this.vectorStore?.creditSessionAvoidances) {
      const store = this.vectorStore;
      const logger = this.logger;
      const creditTask = new Promise<void>((resolve) => {
        setImmediate(() => {
          try {
            const r = store.creditSessionAvoidances!(sessionKey, new Date().toISOString());
            if (r.credited > 0 || r.tempered > 0) {
              logger.info(`${TAG} [lessons] avoidance: credited=${r.credited}, tempered=${r.tempered}`);
            }
          } catch (err) {
            logger.warn(`${TAG} [lessons] avoidance crediting failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            resolve();
          }
        });
      });
      this.bgTasks.add(creditTask);
      void creditTask.then(() => this.bgTasks.delete(creditTask));
    }

    // Drop the per-session proactive-injection state (bounded memory).
    this.injectedFilesBySession.delete(sessionKey);
    this.sessionSituationByKey.delete(sessionKey);
    this.injectedOwnersBySession.delete(sessionKey);
  }

  /**
   * Handle a PostToolUse observation. Two proactive-injection paths, both
   * silent-unless-relevant and never throwing (memory must not break the turn):
   *
   *  1. Single-file (Track A 3+4): surface what the graph knows about the file
   *     just touched, once per file per session.
   *  2. Context Fingerprint (Idea 1): fold this event into the session's rolling
   *     SITUATION (files + error signatures + tool mix), match it against past
   *     fingerprints, and on a strong/medium match surface the memories that
   *     mattered in a similar past situation — cross-session. When a memory is
   *     surfaced, learn the link by persisting a fingerprint of the moment.
   *
   * Owners are deduped across both paths so a memory shows at most once/session.
   */
  async handleToolObservation(obs: {
    sessionKey: string;
    toolName: string;
    toolInput: unknown;
    toolOutputIsError?: boolean;
  }): Promise<{ inject?: string }> {
    if (!obs.sessionKey) return {};
    await this.storeReady?.catch(() => {});
    const store = this.vectorStore;
    if (!store) return {};

    const situation = extractSituation({
      toolName: obs.toolName,
      toolInput: obs.toolInput,
      toolOutputIsError: obs.toolOutputIsError,
    });

    // Fold this event into the session's rolling situation (immutable).
    const fileKey = situation.filePath ? canonicalKey("file", situation.filePath) : undefined;
    const errorSignature = situation.isError ? `${obs.toolName}:error` : undefined;
    const prevSit = this.sessionSituationByKey.get(obs.sessionKey) ?? EMPTY_SITUATION;
    const curSit = updateSituation(prevSit, { toolName: obs.toolName, fileKey, errorSignature });
    this.sessionSituationByKey.set(obs.sessionKey, curSit);

    // Shared per-session owner dedup set (across both injection paths).
    let owners = this.injectedOwnersBySession.get(obs.sessionKey);
    if (!owners) {
      owners = new Set<string>();
      this.injectedOwnersBySession.set(obs.sessionKey, owners);
    }

    const blocks: string[] = [];
    const surfacedNow: string[] = [];

    // ── Path 1: single-file injection (once per file per session) ──
    if (situation.filePath && fileKey) {
      let injectedFiles = this.injectedFilesBySession.get(obs.sessionKey);
      if (!injectedFiles) {
        injectedFiles = new Set<string>();
        this.injectedFilesBySession.set(obs.sessionKey, injectedFiles);
      }
      if (!injectedFiles.has(fileKey)) {
        try {
          // The current action's raw content — feeds the graduated stance gate
          // (Pilastro A): a one-way-door action can escalate an attested lesson
          // to a block-before-acting interrupt. Safe-stringify the unknown input.
          let actionContent = "";
          if (typeof obs.toolInput === "string") {
            actionContent = obs.toolInput;
          } else if (obs.toolInput != null) {
            try { actionContent = JSON.stringify(obs.toolInput) ?? ""; } catch { actionContent = ""; }
          }
          const block = buildFileInjection(store, situation.filePath, {
            sessionId: obs.sessionKey,
            actionContent,
          });
          if (block) {
            injectedFiles.add(fileKey);
            blocks.push(block);
            const ownerId = resolveFileOwnerId(store, situation.filePath);
            if (ownerId && !owners.has(ownerId)) {
              owners.add(ownerId);
              surfacedNow.push(ownerId);
            }
          }
        } catch (err) {
          this.logger.warn(
            `${TAG} file injection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // ── Path 2: Context Fingerprint match (cross-session, situation-shaped) ──
    try {
      const current = {
        fileKeys: curSit.fileKeys,
        errorSignatures: curSit.errorSignatures,
        taskType: inferTaskType(curSit),
      };
      const fingerprints = store.queryContextFingerprints?.(NAMESPACE, FP_QUERY_LIMIT) ?? [];
      const match = buildSituationInjection(store, current, fingerprints, owners);
      if (match) {
        blocks.push(match.block);
        for (const id of match.ownerIds) {
          owners.add(id);
          surfacedNow.push(id);
        }
      }
    } catch (err) {
      this.logger.warn(
        `${TAG} situation match failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── Learn: persist a fingerprint of THIS moment when memory was surfaced ──
    // (Only salient moments are worth storing — a situation with no associated
    //  memory teaches nothing to surface later.)
    if (surfacedNow.length > 0) {
      try {
        store.insertContextFingerprint?.({
          sessionKey: obs.sessionKey,
          now: new Date().toISOString(),
          fileKeys: curSit.fileKeys,
          errorSignatures: curSit.errorSignatures,
          taskType: inferTaskType(curSit),
          toolNames: curSit.toolNames,
          matchedOwnerIds: surfacedNow,
          namespace: NAMESPACE,
        });
      } catch (err) {
        this.logger.warn(
          `${TAG} fingerprint write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return blocks.length > 0 ? { inject: blocks.join("\n\n") } : {};
  }

  // ============================
  // Accessors (for migration bridge)
  // ============================

  /** Get the LLM runner factory (for creating host-neutral LLM runners). */
  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.runnerFactory;
  }

  /** Get the shared VectorStore (may be undefined if init failed). */
  getVectorStore(): IMemoryStore | undefined {
    return this.vectorStore;
  }

  /** Get the shared EmbeddingService (may be undefined if not configured). */
  getEmbeddingService(): EmbeddingService | undefined {
    return this.embeddingService;
  }

  /** Get the pipeline scheduler (may be undefined if extraction disabled). */
  getScheduler(): MemoryPipelineManager | undefined {
    return this.scheduler;
  }

  /** Whether the scheduler has been started (or is currently starting). */
  isSchedulerStarted(): boolean {
    return this.schedulerStartPromise !== undefined;
  }

  /** Set the instance ID for metrics (may be resolved asynchronously). */
  setInstanceId(id: string): void {
    this.instanceId = id;
    if (this.scheduler) {
      this.scheduler.instanceId = id;
    }
  }

  // ============================
  // Internal helpers
  // ============================

  private async initStores(): Promise<void> {
    try {
      const stores = await initStores(this.cfg, this.dataDir, this.logger);
      this.vectorStore = stores.vectorStore;
      this.embeddingService = stores.embeddingService;
      this.logger.debug?.(`${TAG} Stores initialized: backend=${this.cfg.storeBackend}, embedding=${this.cfg.embedding.provider}`);
    } catch (err) {
      this.logger.warn(
        `${TAG} Store init failed; recall/dedup degraded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private wirePipelineRunners(): void {
    if (!this.scheduler) return;

    // Determine whether to use standalone LLM runner for extraction.
    // Priority: cfg.llm.enabled (explicit override) > hostType detection.
    const useStandaloneRunner = this.cfg.llm.enabled || this.hostAdapter.hostType !== "openclaw";

    const openclawConfig = (!useStandaloneRunner && this.hostAdapter.hostType === "openclaw")
      ? (this.hostAdapter as { getOpenClawConfig?(): unknown }).getOpenClawConfig?.()
      : undefined;

    // When standalone runner is active, create LLM runners from the factory.
    // If cfg.llm is configured AND we're in OpenClaw mode, build a dedicated
    // StandaloneLLMRunnerFactory from cfg.llm to override the host runner.
    let runnerFactory = this.runnerFactory;
    if (useStandaloneRunner && this.cfg.llm.enabled && this.hostAdapter.hostType === "openclaw") {
      runnerFactory = new StandaloneLLMRunnerFactory({
        config: {
          baseUrl: this.cfg.llm.baseUrl,
          apiKey: this.cfg.llm.apiKey,
          model: this.cfg.llm.model,
          maxTokens: this.cfg.llm.maxTokens,
          // RC5: honor configured temperature (Kimi/Moonshot requires exactly 1).
          temperature: this.cfg.llm.temperature,
          timeoutMs: this.cfg.llm.timeoutMs,
        },
        logger: this.logger,
      });
      this.logger.debug?.(`${TAG} Using standalone LLM override: model=${this.cfg.llm.model}, baseUrl=${this.cfg.llm.baseUrl}`);
    }

    const l1LlmRunner = useStandaloneRunner
      ? runnerFactory.createRunner({ enableTools: false })
      : undefined;
    const l2l3LlmRunner = useStandaloneRunner
      ? runnerFactory.createRunner({ enableTools: true })
      : undefined;

    // Immune-system extraction fallback: a NON-Chinese model (default OpenAI
    // gpt-5.4-mini) that rescues the windows Moonshot/Kimi REFUSES with "high
    // risk" — its content-moderation flags an incidental China-sensitive term
    // (e.g. the idiom "rubber stamp") and rejects the whole extraction request,
    // which would otherwise freeze/quarantine the window. Reuses the same
    // OpenAI-compatible StandaloneLLMRunner. Enabled when a key resolves from
    // TDAI_FALLBACK_LLM_API_KEY or the OPENAI_API_KEY already used for
    // embeddings; absent → no fallback (unchanged fail-closed + quarantine).
    const fallbackKey = process.env.TDAI_FALLBACK_LLM_API_KEY || process.env.OPENAI_API_KEY;
    const fallbackModel = process.env.TDAI_FALLBACK_LLM_MODEL || "gpt-5.4-mini";
    const fallbackLlmRunner = fallbackKey
      ? new StandaloneLLMRunnerFactory({
          config: {
            baseUrl: process.env.TDAI_FALLBACK_LLM_BASE_URL || "https://api.openai.com/v1",
            apiKey: fallbackKey,
            model: fallbackModel,
            // gpt-5.4-mini is a reasoning model → it rejects/ignores temperature
            // (AI-SDK warns per call if sent). Omit it entirely; the model's
            // default is already low-variance enough for structured extraction.
            omitTemperature: true,
            timeoutMs: this.cfg.llm.timeoutMs,
          },
          logger: this.logger,
        }).createRunner({ enableTools: false })
      : undefined;
    if (fallbackLlmRunner) {
      this.logger.info(`${TAG} KB extraction fallback enabled: ${fallbackModel} (rescues Moonshot "high risk" refusals)`);
    }

    // L1 runner
    this.scheduler.setL1Runner(createL1Runner({
      pluginDataDir: this.dataDir,
      cfg: this.cfg,
      openclawConfig,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
      getInstanceId: () => this.instanceId,
      llmRunner: l1LlmRunner,
      fallbackLlmRunner,
    }));

    // Persister
    this.scheduler.setPersister(createPersister(this.dataDir, this.logger));

    // L2 runner
    this.scheduler.setL2Runner(async (sessionKey: string, cursor?: string) => {
      const l2Runner = createL2Runner({
        pluginDataDir: this.dataDir,
        cfg: this.cfg,
        openclawConfig,
        vectorStore: this.vectorStore,
        logger: this.logger,
        instanceId: this.instanceId,
        llmRunner: l2l3LlmRunner,
      });
      return l2Runner(sessionKey, cursor);
    });

    // L3 runner
    this.scheduler.setL3Runner(async () => {
      const l3Runner = createL3Runner({
        pluginDataDir: this.dataDir,
        cfg: this.cfg,
        openclawConfig,
        vectorStore: this.vectorStore,
        logger: this.logger,
        instanceId: this.instanceId,
        llmRunner: l2l3LlmRunner,
      });
      await l3Runner();
    });

    this.logger.debug?.(`${TAG} Pipeline runners wired`);
  }

  /**
   * Immune system — resume extraction after a restart.
   *
   * Eagerly starts the scheduler: restores per-session pipeline state from the
   * checkpoint and runs recovery (re-enqueues an L1 "recovery" pass for every
   * session with un-extracted L0 backlog). Called fire-and-forget at gateway
   * boot so a crash/reboot/redeploy resumes frozen backlogs WITHOUT waiting for
   * the next capture — closing the "restart amnesia" that silently froze
   * extraction (sessionStates is in-memory; before this, only a /capture rebuilt
   * it and triggered recovery). Idempotent via {@link ensureSchedulerStarted}.
   */
  async resumeExtraction(): Promise<void> {
    await this.storeReady?.catch(() => {});
    await this.ensureSchedulerStarted();
  }

  private ensureSchedulerStarted(): Promise<void> {
    // Fast path: already started (or starting) — every concurrent caller
    // awaits the same in-flight promise.  The promise is kept around as a
    // permanently-resolved sentinel after success so subsequent calls
    // collapse into a cheap already-resolved await.
    if (this.schedulerStartPromise) return this.schedulerStartPromise;
    if (!this.scheduler) return Promise.resolve();

    // Capture scheduler locally so TypeScript narrows inside the closure
    // even after ``this.scheduler`` is re-assigned by handleSessionEnd.
    const scheduler = this.scheduler;
    this.schedulerStartPromise = (async () => {
      try {
        const checkpoint = new CheckpointManager(this.dataDir, this.logger);
        const cp = await checkpoint.read();
        scheduler.start(checkpoint.getAllPipelineStates(cp));
        this.logger.debug?.(`${TAG} Scheduler started`);
      } catch (err) {
        this.logger.error(`${TAG} Failed to restore checkpoint: ${err instanceof Error ? err.message : String(err)}`);
        scheduler.start({});
      }
    })();

    // If the start sequence itself rejects we clear the gate so the next
    // caller can retry; on success we keep the resolved promise so it
    // short-circuits permanently.
    this.schedulerStartPromise.catch(() => {
      this.schedulerStartPromise = undefined;
    });

    return this.schedulerStartPromise;
  }
}
