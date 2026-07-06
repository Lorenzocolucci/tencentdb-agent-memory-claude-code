/**
 * cornerstone-runner — orchestrates the cornerstone selection pipeline at
 * session-start injection time.
 *
 * Retrieves KB events from the store, computes corpus stats, looks up
 * embedding-based neighbors (when the vector store supports it), and returns
 * the formatted cornerstone block ready for injection.
 *
 * Design principles:
 *   - Off the critical path: every step is wrapped in try/catch.
 *     Any failure returns "" (empty block) so memory never breaks the conversation.
 *   - Immutable: builds new arrays/objects, never mutates inputs.
 *   - Degrades gracefully when vectorStore or embeddingService is unavailable:
 *     isolation falls back to 1.0 for all candidates (neutral → termRarity dominates).
 */

import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService, EmbeddingCallOptions } from "../store/embedding.js";
import {
  computeCorpusStats,
  type CorpusStats,
} from "./term-rarity.js";
import type { NeighborEntry } from "./isolation-scorer.js";
import {
  selectCornerstones,
  type CornerstoneCandidate,
  type CornerstoneOptions,
} from "./cornerstone-selector.js";
import {
  buildCornerstoneBlock,
  type InjectionCornerstone,
} from "./cornerstone-injection.js";
import { DEFAULT_WEIGHTS } from "./distinctiveness-scorer.js";
import { PROTECTED_MIN_SALIENCE } from "../kb/lifecycle-decay.js";

const TAG = "[memory-tdai] [cornerstones]";

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** Persistent tracker for injection timestamps (in-process, resets on restart). */
export class CornerstoneInjectionTracker {
  private readonly lastInjectedAt = new Map<string, string>();

  /** Record that a memory was injected as a cornerstone right now. */
  recordInjection(id: string, nowIso: string): void {
    this.lastInjectedAt.set(id, nowIso);
  }

  /** Return the ISO timestamp of when this memory was last injected (or undefined). */
  getLastInjectedAt(id: string): string | undefined {
    return this.lastInjectedAt.get(id);
  }

  /** Return all recorded injection timestamps. */
  snapshot(): ReadonlyMap<string, string> {
    return this.lastInjectedAt;
  }
}

export interface CornerstoneRunnerOptions {
  readonly namespace?: string;
  /** Max events to scan (default 200). */
  readonly eventLimit?: number;
  /** K cornerstones to select (default 3). */
  readonly topK?: number;
  /** Per-call embedding timeout (inherits from config). */
  readonly embeddingTimeoutMs?: number;
  /** Neighbors to fetch per candidate from the vector store (default 6). */
  readonly neighborTopK?: number;
}

/**
 * Build the cornerstone injection block for this session.
 *
 * Returns "" when:
 *   - vectorStore is missing KB capabilities (no events to score)
 *   - no events found in the namespace
 *   - any unexpected error (swallowed)
 */
export async function buildCornerstones(params: {
  vectorStore: IMemoryStore;
  embeddingService?: EmbeddingService;
  injectionTracker: CornerstoneInjectionTracker;
  opts?: CornerstoneRunnerOptions;
  logger?: Logger;
}): Promise<string> {
  const { vectorStore, embeddingService, injectionTracker, opts = {}, logger } = params;
  const namespace = opts.namespace ?? "default";
  // Each candidate triggers ONE synchronous brute-force kb_vec KNN (~0.7s on a
  // ~25k-vector corpus post-digest). eventLimit is therefore the dominant cost
  // driver of this background build: 200 → ~140s of work. 50 keeps a distinctive
  // pool while bounding the build; the loop below also yields per scan so it
  // never blocks live recall regardless.
  const eventLimit = opts.eventLimit ?? 50;
  const topK = opts.topK ?? 3;
  const neighborTopK = opts.neighborTopK ?? 6;

  try {
    if (!vectorStore.listRecentEvents) {
      logger?.debug?.(`${TAG} listRecentEvents not available — skipping cornerstones`);
      return "";
    }

    // Retrieve recent events from the KB.
    const events = vectorStore.listRecentEvents(namespace, { limit: eventLimit });
    if (events.length === 0) {
      logger?.debug?.(`${TAG} No KB events found — skipping cornerstones`);
      return "";
    }

    // Build corpus stats from event texts.
    const corpusDocs = events.map((e) => ({ id: e.id, content: e.text }));
    const corpusStats: CorpusStats = computeCorpusStats(corpusDocs);

    // Compute neighbors via the embedding store when available.
    // Strategy: embed each candidate's text, search the KB vector index for similar
    // items. Falls back to [] neighbors when embeddingService is unavailable
    // (isolation defaults to 1.0 = neutral, termRarity dominates).
    const neighborMap = await buildNeighborMap(
      events.map((e) => ({ id: e.id, text: e.text })),
      vectorStore,
      embeddingService,
      neighborTopK,
      opts.embeddingTimeoutMs,
      logger,
    );

    const nowIso = new Date().toISOString();
    const candidates: CornerstoneCandidate[] = events.map((e) => ({
      id: e.id,
      content: e.text,
      neighbors: neighborMap.get(e.id) ?? [],
      heat: 1, // events have no direct heat; heat is not used in scoring
      lastInjectedAt: injectionTracker.getLastInjectedAt(e.id),
    }));

    const cornerstoneOpts: CornerstoneOptions = {
      topK,
      weights: DEFAULT_WEIGHTS,
    };

    const selected = selectCornerstones(candidates, corpusStats, cornerstoneOpts);
    if (selected.length === 0) {
      logger?.debug?.(`${TAG} No cornerstones selected`);
      return "";
    }

    const injectionInput: InjectionCornerstone[] = selected.map((cs) => ({
      id: cs.id,
      content: cs.content,
      score: cs.score,
    }));

    const block = buildCornerstoneBlock(injectionInput);

    // Record injection timestamps AFTER the block is successfully built,
    // so decay is only applied when memories are actually injected.
    // At the same time, carry the distinctiveness verdict onto the lifecycle
    // salience (Pilastro C bridge) for peaks that clear the protection
    // threshold — this is what lets distinctiveness-aware decay protect them.
    // stampSalience is optional + never throws, so this is off the critical path.
    for (const cs of selected) {
      injectionTracker.recordInjection(cs.id, nowIso);
      if (cs.score >= PROTECTED_MIN_SALIENCE) {
        vectorStore.stampSalience?.({
          ownerId: cs.id,
          ownerKind: "event",
          salience: cs.score,
          now: nowIso,
        });
      }
    }

    logger?.debug?.(`${TAG} Cornerstone block built: ${selected.length} memory/ies`);
    return block;
  } catch (err) {
    // Off the critical path — log and return empty rather than propagating.
    logger?.warn?.(`${TAG} Cornerstone computation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

// ============================================================================
// Neighbor map computation
// ============================================================================

/**
 * Build a map from event id → neighbor list (with cosine similarities).
 *
 * When embeddingService is unavailable, returns an empty map (all isolation=1.0).
 * Any per-event error degrades that event's neighbors to [] (neutral isolation).
 *
 * NOTE: This embeds every candidate text. For large corpora (>50 events) this
 * can be expensive. The caller should pass eventLimit to cap the corpus size.
 */
async function buildNeighborMap(
  candidates: ReadonlyArray<{ id: string; text: string }>,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService | undefined,
  neighborTopK: number,
  embeddingTimeoutMs: number | undefined,
  logger?: Logger,
): Promise<Map<string, NeighborEntry[]>> {
  const result = new Map<string, NeighborEntry[]>();

  if (!embeddingService || !vectorStore.searchKbVector) {
    logger?.debug?.(`${TAG} Embedding service or searchKbVector unavailable — isolation defaults to 1.0`);
    return result;
  }

  const callOpts: EmbeddingCallOptions | undefined = embeddingTimeoutMs
    ? { timeoutMs: embeddingTimeoutMs }
    : undefined;

  // Batch-embed all candidate texts in a single API call to reduce latency.
  let embeddings: Float32Array[];
  try {
    embeddings = await embeddingService.embedBatch(
      candidates.map((c) => c.text),
      callOpts,
    );
  } catch {
    logger?.debug?.(`${TAG} Batch embedding failed — isolation defaults to 1.0`);
    return result;
  }

  // Query the vector store for each candidate's neighbors. searchKbVector is a
  // SYNCHRONOUS brute-force KNN over the whole kb_vec index (~25k vectors post-
  // digest, ~0.7s each). Running the loop unbroken blocks the single-threaded
  // event loop for its ENTIRE duration (eventLimit × ~0.7s), starving live
  // recall — the session-open banner and /health then time out and are dropped.
  // This build is background/best-effort, so we YIELD to the event loop after
  // each scan: at most ONE search (~1s) is ever in flight when a live request
  // arrives. A slower wall-clock here is the correct trade for never blocking a
  // turn (binding principle: memory must never break the conversation).
  for (let i = 0; i < candidates.length; i++) {
    try {
      // ownerKindFilter = "event" to only compare events vs events.
      const hits = vectorStore.searchKbVector(embeddings[i], neighborTopK + 1, "event");
      // Exclude the candidate itself from its own neighbor list.
      const neighbors: NeighborEntry[] = hits
        .filter((h) => h.owner_id !== candidates[i].id)
        .slice(0, neighborTopK)
        .map((h) => ({ id: h.owner_id, cosineSim: h.score }));
      result.set(candidates[i].id, neighbors);
    } catch {
      // Per-candidate failure → empty neighbors (isolation=1.0 = conservative/neutral).
      result.set(candidates[i].id, []);
    }
    // Cooperative yield so the event loop can service live recall between scans.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return result;
}
