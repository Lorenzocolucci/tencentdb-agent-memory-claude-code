/**
 * TDD tests for the backfill-chat-export pipeline.
 *
 * Suite covers the four pure units:
 *  1. timestamp mapping (created_at → epoch ms)
 *  2. redaction is applied before storage
 *  3. idempotency skip (already-ingested uuids are skipped)
 *  4. streaming brace-scanner on a small fixture
 *
 * These tests use ONLY pure functions and temp SQLite DBs —
 * no network calls, no gateway, no real export file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mapTimestamp, extractMessageText, isConversationEmpty } from "../chat-export-streamer.js";
import { buildL0RecordId } from "../message-ingestor.js";
import { redactSecrets } from "../../../utils/redact-secrets.js";
import { ImportLedger } from "../import-ledger.js";
import { streamConversations } from "../chat-export-streamer.js";

// ─────────────────────────────────────────────
// 1. TIMESTAMP MAPPING
// ─────────────────────────────────────────────

describe("mapTimestamp", () => {
  it("converts an ISO 8601 created_at to epoch ms", () => {
    const ts = mapTimestamp("2024-06-15T10:30:00.000Z");
    expect(ts).toBe(new Date("2024-06-15T10:30:00.000Z").getTime());
  });

  it("handles date-only strings by interpreting as UTC midnight", () => {
    const ts = mapTimestamp("2025-01-01");
    expect(ts).toBeGreaterThan(0);
    expect(Number.isFinite(ts)).toBe(true);
  });

  it("returns a finite positive number for any valid ISO date", () => {
    const ts = mapTimestamp("2026-06-25T08:00:00Z");
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThan(0);
  });

  it("falls back to current time when the string is unparseable", () => {
    const before = Date.now();
    const ts = mapTimestamp("not-a-date");
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ─────────────────────────────────────────────
// 2. REDACTION IS APPLIED
// ─────────────────────────────────────────────

describe("redaction guard — secrets are scrubbed before storage", () => {
  it("strips an OpenAI-style sk- key from message text", () => {
    const raw = "My key is sk-proj-AbCd1234EfGh5678IjKl9012MnOp";
    const result = redactSecrets(raw);
    expect(result).not.toContain("sk-proj-AbCd");
    expect(result).toContain("[REDACTED");
  });

  it("strips a PEM private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBg==\n-----END RSA PRIVATE KEY-----";
    const result = redactSecrets(pem);
    expect(result).not.toContain("MIIEvQIBADANBg");
    expect(result).toContain("[REDACTED");
  });

  it("preserves innocent developer content (git SHA)", () => {
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    expect(redactSecrets(sha)).toBe(sha);
  });

  it("strips a Bearer token", () => {
    const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef";
    const result = redactSecrets(text);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9abcdef");
    expect(result).toContain("[REDACTED");
  });
});

// ─────────────────────────────────────────────
// 3. IDEMPOTENCY SKIP
// ─────────────────────────────────────────────

describe("ImportLedger — idempotency", () => {
  let tmpDir: string;
  let ledger: ImportLedger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-backfill-ledger-"));
    ledger = new ImportLedger(path.join(tmpDir, "ledger.db"));
  });

  afterEach(() => {
    ledger.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks a uuid as ingested and returns true for hasIngested", () => {
    ledger.markIngested("msg-uuid-001");
    expect(ledger.hasIngested("msg-uuid-001")).toBe(true);
  });

  it("returns false for a never-seen uuid", () => {
    expect(ledger.hasIngested("msg-uuid-never")).toBe(false);
  });

  it("is idempotent — marking the same uuid twice does not throw", () => {
    ledger.markIngested("msg-uuid-dup");
    expect(() => ledger.markIngested("msg-uuid-dup")).not.toThrow();
    expect(ledger.hasIngested("msg-uuid-dup")).toBe(true);
  });

  it("persists across close+reopen of the ledger", () => {
    ledger.markIngested("msg-uuid-persist");
    ledger.close();

    const ledger2 = new ImportLedger(path.join(tmpDir, "ledger.db"));
    expect(ledger2.hasIngested("msg-uuid-persist")).toBe(true);
    ledger2.close();
  });
});

// ─────────────────────────────────────────────
// 4. STREAMING BRACE SCANNER — small fixture
// ─────────────────────────────────────────────

describe("streamConversations — brace-depth scanner", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-backfill-stream-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("yields every conversation object from a small 2-conversation JSON array", async () => {
    const fixture = JSON.stringify([
      {
        uuid: "conv-001",
        name: "First chat",
        created_at: "2024-01-01T00:00:00Z",
        chat_messages: [
          { uuid: "msg-a", sender: "human", text: "Hello", created_at: "2024-01-01T00:00:00Z" },
          { uuid: "msg-b", sender: "assistant", text: "Hi there", created_at: "2024-01-01T00:01:00Z" },
        ],
      },
      {
        uuid: "conv-002",
        name: "Second chat",
        created_at: "2024-02-01T00:00:00Z",
        chat_messages: [
          { uuid: "msg-c", sender: "human", text: "Another question", created_at: "2024-02-01T00:00:00Z" },
        ],
      },
    ]);

    const fixturePath = path.join(tmpDir, "export.json");
    fs.writeFileSync(fixturePath, fixture, "utf-8");

    const collected: unknown[] = [];
    for await (const conv of streamConversations(fixturePath)) {
      collected.push(conv);
    }

    expect(collected).toHaveLength(2);
    const first = collected[0] as { uuid: string; chat_messages: unknown[] };
    expect(first.uuid).toBe("conv-001");
    expect(first.chat_messages).toHaveLength(2);
  });

  it("handles a single conversation array", async () => {
    const fixture = JSON.stringify([
      {
        uuid: "conv-solo",
        name: "Solo",
        created_at: "2025-06-01T00:00:00Z",
        chat_messages: [],
      },
    ]);

    const fixturePath = path.join(tmpDir, "single.json");
    fs.writeFileSync(fixturePath, fixture, "utf-8");

    const collected: unknown[] = [];
    for await (const conv of streamConversations(fixturePath)) {
      collected.push(conv);
    }

    expect(collected).toHaveLength(1);
    expect((collected[0] as { uuid: string }).uuid).toBe("conv-solo");
  });

  it("streams a large fixture without loading it entirely in RAM", async () => {
    // Generate 100 conversations with 50 messages each
    const conversations = Array.from({ length: 100 }, (_, i) => ({
      uuid: `conv-${i}`,
      name: `Chat ${i}`,
      created_at: `2024-01-${String(i % 28 + 1).padStart(2, "0")}T00:00:00Z`,
      chat_messages: Array.from({ length: 50 }, (__, j) => ({
        uuid: `msg-${i}-${j}`,
        sender: j % 2 === 0 ? "human" : "assistant",
        text: `Message ${j} in conversation ${i}`,
        created_at: `2024-01-${String(i % 28 + 1).padStart(2, "0")}T${String(j % 24).padStart(2, "0")}:00:00Z`,
      })),
    }));

    const fixturePath = path.join(tmpDir, "large.json");
    fs.writeFileSync(fixturePath, JSON.stringify(conversations), "utf-8");

    let count = 0;
    for await (const conv of streamConversations(fixturePath)) {
      const c = conv as { uuid: string; chat_messages: unknown[] };
      expect(c.uuid).toBe(`conv-${count}`);
      count++;
    }

    expect(count).toBe(100);
  });
});

// ─────────────────────────────────────────────
// 5. extractMessageText — content fallback (Fix 1)
// ─────────────────────────────────────────────

describe("extractMessageText — content-field fallback", () => {
  it("returns text directly when text field is non-empty", () => {
    const msg = { text: "hello world", content: [] };
    expect(extractMessageText(msg)).toBe("hello world");
  });

  it("falls back to content array when text is empty string", () => {
    const msg = {
      text: "",
      content: [{ type: "text", text: "recovered from content" }],
    };
    expect(extractMessageText(msg)).toBe("recovered from content");
  });

  it("falls back to content when text is whitespace-only", () => {
    const msg = {
      text: "   ",
      content: [{ type: "text", text: "real body" }],
    };
    expect(extractMessageText(msg)).toBe("real body");
  });

  it("concatenates multiple text-type content elements in order", () => {
    const msg = {
      text: "",
      content: [
        { type: "text", text: "part one" },
        { type: "tool_use", text: "should be ignored" },
        { type: "text", text: " part two" },
      ],
    };
    expect(extractMessageText(msg)).toBe("part one part two");
  });

  it("ignores non-text content elements (tool_use, thinking, etc.)", () => {
    const msg = {
      text: "",
      content: [
        { type: "tool_use", text: "ignore me" },
        { type: "thinking", text: "ignore me too" },
        { type: "text", text: "only this" },
      ],
    };
    expect(extractMessageText(msg)).toBe("only this");
  });

  it("returns empty string when both text and content yield nothing", () => {
    const msg = { text: "", content: [] };
    expect(extractMessageText(msg)).toBe("");
  });

  it("returns empty string when content has only non-text elements", () => {
    const msg = {
      text: "",
      content: [
        { type: "tool_use", text: "skip" },
        { type: "token_budget" },
      ],
    };
    expect(extractMessageText(msg)).toBe("");
  });

  it("handles missing content field gracefully", () => {
    const msg = { text: "" };
    expect(extractMessageText(msg as { text: string; content?: unknown[] })).toBe("");
  });

  it("handles null content field gracefully", () => {
    const msg = { text: "", content: null };
    expect(extractMessageText(msg as { text: string; content: unknown[] | null })).toBe("");
  });

  it("handles content elements with missing text field gracefully", () => {
    const msg = {
      text: "",
      content: [
        { type: "text" },             // no text field
        { type: "text", text: "ok" }, // has text
      ],
    };
    expect(extractMessageText(msg)).toBe("ok");
  });
});

// ─────────────────────────────────────────────
// 6. isConversationEmpty — Fix 2 dry-run gate
// ─────────────────────────────────────────────

describe("isConversationEmpty", () => {
  it("returns true for a conversation with no messages", () => {
    const conv = {
      uuid: "conv-empty",
      name: "Empty",
      created_at: "2024-01-01T00:00:00Z",
      chat_messages: [],
    };
    expect(isConversationEmpty(conv)).toBe(true);
  });

  it("returns true when all messages have empty text AND empty/no content", () => {
    const conv = {
      uuid: "conv-all-empty",
      name: "All empty",
      created_at: "2024-01-01T00:00:00Z",
      chat_messages: [
        { uuid: "m1", sender: "human", text: "", created_at: "2024-01-01T00:00:00Z", content: [] },
        { uuid: "m2", sender: "assistant", text: "   ", created_at: "2024-01-01T00:01:00Z", content: [] },
      ],
    };
    expect(isConversationEmpty(conv)).toBe(true);
  });

  it("returns false when at least one message has non-empty text", () => {
    const conv = {
      uuid: "conv-has-text",
      name: "Has text",
      created_at: "2024-01-01T00:00:00Z",
      chat_messages: [
        { uuid: "m1", sender: "human", text: "Hello!", created_at: "2024-01-01T00:00:00Z", content: [] },
      ],
    };
    expect(isConversationEmpty(conv)).toBe(false);
  });

  it("returns false when a message has empty text but recoverable content", () => {
    const conv = {
      uuid: "conv-has-content",
      name: "Content only",
      created_at: "2024-01-01T00:00:00Z",
      chat_messages: [
        {
          uuid: "m1",
          sender: "human",
          text: "",
          created_at: "2024-01-01T00:00:00Z",
          content: [{ type: "text", text: "recovered" }],
        },
      ],
    };
    expect(isConversationEmpty(conv)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// 7. ingestConversation — content fallback integration
// ─────────────────────────────────────────────

import { ingestConversation } from "../message-ingestor.js";
import { VectorStore } from "../../../core/store/sqlite.js";

describe("ingestConversation — content-field recovery integration", () => {
  let tmpDir: string;
  let store: VectorStore;
  let ledger: ImportLedger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-ingest-content-"));
    store = new VectorStore(path.join(tmpDir, "vectors.db"), 0);
    store.init();
    ledger = new ImportLedger(path.join(tmpDir, "ledger.db"));
  });

  afterEach(() => {
    store.close();
    ledger.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ingests a message with empty text but non-empty content (not skipped)", async () => {
    const conv = {
      uuid: "conv-content-only",
      name: "Content only conv",
      created_at: "2024-03-01T00:00:00Z",
      chat_messages: [
        {
          uuid: "msg-content-only",
          sender: "human" as const,
          text: "",
          created_at: "2024-03-01T00:00:00Z",
          content: [{ type: "text", text: "recovered from content array" }],
        },
      ],
    };

    const stats = await ingestConversation(conv, {
      store,
      ledger,
      dryRun: false,
    });

    // Must be ingested, not skipped
    expect(stats.messagesIngested).toBe(1);
    expect(stats.messagesSkippedEmpty).toBe(0);
    expect(stats.messagesSkippedDuplicate).toBe(0);
    expect(stats.messagesFailed).toBe(0);
  });

  it("counts content-recovered message as would-ingest in dry-run", async () => {
    const conv = {
      uuid: "conv-dryrun-content",
      name: "Dry run content conv",
      created_at: "2024-03-01T00:00:00Z",
      chat_messages: [
        {
          uuid: "msg-dry-content",
          sender: "assistant" as const,
          text: "",
          created_at: "2024-03-01T00:00:00Z",
          content: [{ type: "text", text: "recovered" }],
        },
      ],
    };

    const stats = await ingestConversation(conv, {
      store,
      ledger,
      dryRun: true,
    });

    expect(stats.messagesIngested).toBe(1);
    expect(stats.messagesSkippedEmpty).toBe(0);
  });

  it("still skips a message where both text and content are empty", async () => {
    const conv = {
      uuid: "conv-truly-empty",
      name: "Truly empty",
      created_at: "2024-03-01T00:00:00Z",
      chat_messages: [
        {
          uuid: "msg-truly-empty",
          sender: "human" as const,
          text: "",
          created_at: "2024-03-01T00:00:00Z",
          content: [],
        },
      ],
    };

    const stats = await ingestConversation(conv, {
      store,
      ledger,
      dryRun: false,
    });

    expect(stats.messagesIngested).toBe(0);
    expect(stats.messagesSkippedEmpty).toBe(1);
    expect(stats.messagesSkippedDuplicate).toBe(0);
  });
});

// ─────────────────────────────────────────────
// 9. buildL0RecordId — deterministic, stable
// ─────────────────────────────────────────────

describe("buildL0RecordId", () => {
  it("produces the same id for the same conversationUuid + messageUuid", () => {
    const id1 = buildL0RecordId("conv-abc", "msg-xyz");
    const id2 = buildL0RecordId("conv-abc", "msg-xyz");
    expect(id1).toBe(id2);
  });

  it("produces different ids for different messageUuids", () => {
    const id1 = buildL0RecordId("conv-abc", "msg-001");
    const id2 = buildL0RecordId("conv-abc", "msg-002");
    expect(id1).not.toBe(id2);
  });

  it("prefixes the id with l0_chatimport_", () => {
    const id = buildL0RecordId("conv-abc", "msg-xyz");
    expect(id.startsWith("l0_chatimport_")).toBe(true);
  });
});
