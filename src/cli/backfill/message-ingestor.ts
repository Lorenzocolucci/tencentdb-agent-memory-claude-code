/**
 * MessageIngestor — core ingestion logic for the backfill CLI.
 *
 * Reuses the same building blocks as performAutoCapture:
 *  - IMemoryStore.upsertL0()   (from src/core/store/types.ts)
 *  - IMemoryStore.updateL0Embedding()
 *  - EmbeddingService.embedChunks()  (from src/core/store/embedding.ts)
 *  - redactSecrets()           (from src/utils/redact-secrets.ts)
 *
 * Key differences from performAutoCapture:
 *  - Timestamps come from message created_at, NOT Date.now()
 *  - session_key = "chatimport_<conversation-uuid>"
 *  - role mapping: "human" → "user", "assistant" → "assistant"
 *  - No CheckpointManager (no cursor — processes full history)
 *  - Idempotency guarded by ImportLedger (message uuid)
 *
 * Redaction note (care item 2):
 *  The live path (l0-recorder.ts:258) applies redactSecrets() BEFORE writing
 *  to L0 JSONL and before passing to upsertL0. We mirror that here: every
 *  message text is redacted before upsertL0 and before embedChunks.
 *  Raw L0 in the live path is stored UNREDACTED in JSONL only if the message
 *  bypassed recordConversation — that cannot happen here because we own the
 *  write path entirely.
 */

import crypto from "node:crypto";
import { redactSecrets } from "../../utils/redact-secrets.js";
import type { IMemoryStore, L0Record } from "../../core/store/types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { ImportLedger } from "./import-ledger.js";
import type { ExportConversation, ExportMessage } from "./chat-export-streamer.js";
import { mapTimestamp, extractMessageText } from "./chat-export-streamer.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface IngestStats {
  messagesTotal: number;
  /** Messages skipped because they were already in the idempotency ledger. */
  messagesSkippedDuplicate: number;
  /** Messages skipped because both text and content yielded empty body. */
  messagesSkippedEmpty: number;
  messagesIngested: number;     // successfully written to store
  messagesFailed: number;       // write errors (non-fatal)
  redactionApplied: number;     // messages where redactSecrets changed the text
  embeddingDims: number;        // 0 if no embedding service
}

export interface IngestOptions {
  store: IMemoryStore;
  ledger: ImportLedger;
  embeddingService?: EmbeddingService | undefined;
  /** When true, print what WOULD be stored but do NOT write to store or ledger. */
  dryRun: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a stable, unique L0 record ID for a backfill message.
 * Deterministic: same conversationUuid + messageUuid always → same id.
 * This is what makes re-runs idempotent at the store level as well.
 */
export function buildL0RecordId(
  conversationUuid: string,
  messageUuid: string,
): string {
  const hash = crypto
    .createHash("sha1")
    .update(`${conversationUuid}|${messageUuid}`)
    .digest("hex")
    .slice(0, 12);
  return `l0_chatimport_${hash}`;
}

/**
 * Map the export's sender field to the store's role field.
 * "human" → "user", everything else (including "assistant") → "assistant".
 */
function mapRole(sender: string): "user" | "assistant" {
  return sender === "human" ? "user" : "assistant";
}

// ── Core ingestor ─────────────────────────────────────────────────────────────

/**
 * Ingest a single conversation into the store.
 *
 * For each chat_message:
 *  1. Check idempotency ledger → skip if already ingested
 *  2. Apply redactSecrets() to message text
 *  3. Skip empty/whitespace-only messages
 *  4. Build L0Record with real timestamps
 *  5. upsertL0() → store metadata + FTS
 *  6. If embeddingService provided: embedChunks() → updateL0Embedding()
 *  7. Mark uuid in ledger
 */
export async function ingestConversation(
  conv: ExportConversation,
  opts: IngestOptions,
): Promise<IngestStats> {
  const { store, ledger, embeddingService, dryRun } = opts;

  const sessionKey = `chatimport_${conv.uuid}`;
  const sessionId = conv.uuid;
  const recordedAt = new Date(mapTimestamp(conv.created_at)).toISOString();
  const embeddingDims = embeddingService?.getDimensions() ?? 0;

  const stats: IngestStats = {
    messagesTotal: 0,
    messagesSkippedDuplicate: 0,
    messagesSkippedEmpty: 0,
    messagesIngested: 0,
    messagesFailed: 0,
    redactionApplied: 0,
    embeddingDims,
  };

  for (const msg of conv.chat_messages) {
    stats.messagesTotal++;

    if (!isValidMessage(msg)) continue;

    // Idempotency check
    if (!dryRun && ledger.hasIngested(msg.uuid)) {
      stats.messagesSkippedDuplicate++;
      continue;
    }

    // Extract body: prefer text, fall back to content array
    const rawText = extractMessageText(msg);
    if (!rawText) {
      stats.messagesSkippedEmpty++;
      continue;
    }

    const redacted = redactSecrets(rawText);
    if (redacted !== rawText) {
      stats.redactionApplied++;
    }

    const recordId = buildL0RecordId(conv.uuid, msg.uuid);
    const timestamp = mapTimestamp(msg.created_at);

    const l0Record: L0Record = {
      id: recordId,
      sessionKey,
      sessionId,
      role: mapRole(msg.sender),
      messageText: redacted,
      recordedAt,
      timestamp,
    };

    if (dryRun) {
      // Dry-run: count only, no writes
      stats.messagesIngested++;
      continue;
    }

    // Write metadata + FTS to store (no embedding yet — mirrors the sqlite bg path)
    let upsertOk = false;
    try {
      upsertOk = await store.upsertL0(l0Record, undefined);
    } catch (err) {
      stats.messagesFailed++;
      // Non-fatal: log at caller level; continue to next message
      continue;
    }

    if (!upsertOk) {
      stats.messagesFailed++;
      continue;
    }

    // Embedding (optional)
    if (embeddingService && store.updateL0Embedding) {
      try {
        const chunks = await embeddingService.embedChunks(redacted);
        if (chunks.length > 0) {
          await store.updateL0Embedding(recordId, chunks);
        }
      } catch {
        // Non-fatal: message is indexed by FTS even without a vector
      }
    }

    ledger.markIngested(msg.uuid);
    stats.messagesIngested++;
  }

  return stats;
}

// ── Guard ─────────────────────────────────────────────────────────────────────

function isValidMessage(msg: ExportMessage): boolean {
  return (
    typeof msg.uuid === "string" &&
    msg.uuid.length > 0 &&
    typeof msg.sender === "string" &&
    typeof msg.created_at === "string"
    // text is allowed to be empty: extractMessageText() falls back to content[]
  );
}
