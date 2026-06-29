/**
 * Non-circular eval: build a recap from the most recent REAL session in the
 * live vectors.db and (1) prove the full pipeline produces a non-empty anchored
 * recap (anti no-op), (2) measure word-overlap of the recap against a
 * hand-written HANDOFF doc's "next" vocabulary as INDEPENDENT ground truth.
 *
 * Read-only against the live DB; never writes. Skips if the DB/handoff absent.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { selectThread } from "../recap-selector.js";
import { buildRecapText } from "../recap-builder.js";
import type { KbEvent } from "../../store/types.js";

const VECTORS_DB = "C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local/vectors.db";
const HANDOFF = "docs/HANDOFF-2026-06-26.md";

const ready = existsSync(VECTORS_DB) && existsSync(HANDOFF);

function parseIds(json: unknown): string[] {
  if (typeof json !== "string" || !json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9àèéìòù\s]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
}

describe.runIf(ready)("recap eval vs real handoff", () => {
  it("builds a non-empty anchored recap from the most recent real session", () => {
    const db = new DatabaseSync(VECTORS_DB, { open: true } as any);
    try {
      const top = db
        .prepare("SELECT session_key FROM events GROUP BY session_key ORDER BY MAX(ts) DESC LIMIT 1")
        .get() as { session_key: string } | undefined;
      expect(top?.session_key).toBeTruthy();

      const rows = db
        .prepare("SELECT * FROM events WHERE session_key = ? ORDER BY ts ASC")
        .all(top!.session_key) as Array<Record<string, unknown>>;

      const events: KbEvent[] = rows.map((r) => ({
        id: r.id as string,
        ts: r.ts as string,
        recorded_at: (r.recorded_at as string) ?? "",
        session_key: r.session_key as string,
        session_id: (r.session_id as string) ?? "",
        namespace: (r.namespace as string) ?? "default",
        project: (r.project as string) ?? "",
        type: r.type as string,
        text: (r.text as string) ?? "",
        language: (r.language as string) ?? "und",
        entities: [],
        source_message_ids: parseIds(r.source_message_ids_json),
      }));

      const recap = buildRecapText(selectThread(events, "2026-06-29T12:00:00.000Z"));

      // Anti no-op: real recap is non-empty and every thread line is anchored.
      expect(recap.length).toBeGreaterThan(0);
      expect(recap).toContain("[anchor: msg ");

      // eslint-disable-next-line no-console
      console.log(`\n===== REAL RECAP (session_key=${top!.session_key}) =====\n${recap}\n=====================================\n`);

      // Independent ground truth: the handoff's "next" lines.
      const handoff = readFileSync(HANDOFF, "utf8");
      const nextLines = handoff
        .split(/\r?\n/)
        .filter((l) => /next|prossim|dove eravamo|reindex|embedding|scorer|banner/i.test(l))
        .join(" ");
      const recapTok = tokens(recap);
      const handoffTok = tokens(nextLines);
      let shared = 0;
      for (const t of recapTok) if (handoffTok.has(t)) shared++;
      const overlap = handoffTok.size > 0 ? shared / handoffTok.size : 0;
      // eslint-disable-next-line no-console
      console.log(`recap↔handoff shared tokens=${shared}, handoff-vocab=${handoffTok.size}, overlap=${overlap.toFixed(3)} (logged measurement; the most-recent session may belong to a different project than the handoff)`);
      expect(recapTok.size).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
