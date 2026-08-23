/**
 * Backfill friction from PAST sessions (answers "are the old sessions recovered?").
 *
 * Friction capture only sees failures from the moment it was installed. But every
 * past failure is still on disk: Claude Code writes each session to
 * ~/.claude/projects/<project>/<session>.jsonl, and a failed tool call appears as
 * a `user` entry whose content contains a `tool_result` with `is_error: true`.
 *
 * This walks those transcripts and replays the failures through the SAME pure
 * module the live path uses (friction-capture.ts), so historical evidence is
 * normalised, de-duplicated, secret-redacted and loop-detected EXACTLY like new
 * evidence — no second implementation to drift.
 *
 * Safety:
 *  - DRY RUN by default; writes only with --commit;
 *  - skips sessions already backfilled (idempotent marker in the event text);
 *  - per-session state, so the loop detector works exactly as it does live;
 *  - events are timestamped with the ORIGINAL failure time, so clustering and
 *    recency behave as if they had been captured at the time.
 *
 * Usage:
 *   node --import tsx tools/backfill-friction.mts            # dry run
 *   node --import tsx tools/backfill-friction.mts --commit   # write
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../src/core/store/sqlite.js";
import { buildFrictionEvent, createFrictionState } from "../src/core/kb/friction-capture.js";

const ROOT = "C:/Users/lo/.claude/projects";
const DB_DIR = "C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local";
const EMB = { provider: "deepinfra", model: "Qwen/Qwen3-Embedding-4B", dimensions: 1024 };
const COMMIT = process.argv.includes("--commit");
/** Marker so a re-run never double-writes the same historical evidence. */
const MARK = "[backfill]";

interface Rec {
  ts: string;
  sessionKey: string;
  project: string;
  toolName: string;
  toolInput: unknown;
  errorText: string;
}

/** Map tool_use_id → tool name/input, so a failure knows what produced it. */
function readSessionFailures(fp: string, project: string, sessionKey: string): Rec[] {
  let txt: string;
  try { txt = fs.readFileSync(fp, "utf8"); } catch { return []; }
  const toolById = new Map<string, { name: string; input: unknown }>();
  const out: Rec[] = [];

  for (const ln of txt.split("\n")) {
    if (!ln.trim()) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(ln) as Record<string, unknown>; } catch { continue; }
    const msg = (j.message ?? {}) as { content?: unknown };
    const content = msg.content;

    if (j.type === "assistant" && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.type === "tool_use" && typeof b.id === "string") {
          toolById.set(b.id, { name: String(b.name ?? ""), input: b.input });
        }
      }
    } else if (j.type === "user" && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.type !== "tool_result" || b.is_error !== true) continue;
        const meta = typeof b.tool_use_id === "string" ? toolById.get(b.tool_use_id) : undefined;
        const raw = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        if (!raw) continue;
        out.push({
          ts: String(j.timestamp ?? ""),
          sessionKey,
          project,
          toolName: meta?.name || "Tool",
          toolInput: meta?.input,
          errorText: raw,
        });
      }
    }
  }
  return out;
}

function main(): void {
  const store = new VectorStore(path.join(DB_DIR, "vectors.db"), EMB.dimensions, {
    debug: () => {}, info: () => {}, warn: () => {}, error: (m: string) => console.error(m),
  });
  store.init({ provider: EMB.provider, model: EMB.model });

  // Idempotency (CRITICAL): a second --commit run must NOT duplicate history.
  // Every backfilled event carries the MARK and its session_key, so we skip any
  // session already present. Read on a separate read-only handle.
  const done = new Set<string>();
  try {
    const ro = new DatabaseSync(path.join(DB_DIR, "vectors.db"), { readOnly: true });
    const rows = ro
      .prepare("SELECT DISTINCT session_key FROM events WHERE text LIKE ?")
      .all(`${MARK}%`) as Array<{ session_key: string }>;
    for (const r of rows) done.add(r.session_key);
    ro.close();
  } catch (err) {
    console.error("ATTENZIONE: impossibile leggere lo stato pregresso — interrompo per non duplicare.", err);
    store.close();
    process.exit(1);
  }
  if (done.size > 0) console.log(`sessioni gia' recuperate in precedenza: ${done.size}`);

  let sessions = 0, failures = 0, written = 0, loops = 0, skipped = 0;
  const loopSamples: string[] = [];

  for (const d of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, d);
    let st: fs.Stats;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const project = d.replace(/^C--/, "").split("-").slice(-1)[0] || d;

    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const sessionKey = `hist-${f.replace(/\.jsonl$/, "").slice(0, 8)}`;
      if (done.has(sessionKey)) { skipped++; continue; }

      const recs = readSessionFailures(path.join(dir, f), project, sessionKey);
      if (recs.length === 0) continue;
      sessions++;
      failures += recs.length;

      const state = createFrictionState();
      for (const r of recs) {
        const atMs = Date.parse(r.ts) || Date.now();
        const ev = buildFrictionEvent(
          { sessionKey, toolName: r.toolName, toolInput: r.toolInput, errorText: r.errorText, atMs },
          state,
        );
        if (!ev) continue;
        if (ev.isLoop) {
          loops++;
          if (loopSamples.length < 10) loopSamples.push(`${ev.repeatCount}x ${ev.text.slice(0, 95)}`);
        }
        written++;
        if (COMMIT && typeof store.insertEvent === "function") {
          const iso = new Date(atMs).toISOString();
          store.insertEvent({
            ts: iso,
            recordedAt: iso,
            sessionKey,
            namespace: "default",
            project: r.project,
            type: "bug",
            text: `${MARK} ${ev.text}`.slice(0, 400),
            entities: [],
          });
        }
      }
    }
  }

  console.log(`\n=== BACKFILL ${COMMIT ? "(SCRITTURA)" : "(PROVA A VUOTO)"} ===`);
  console.log(`sessioni con fallimenti : ${sessions}`);
  console.log(`fallimenti letti        : ${failures}`);
  console.log(`ricordi da scrivere     : ${written}`);
  console.log(`di cui LOOP rilevati    : ${loops}`);
  if (skipped) console.log(`sessioni gia' fatte     : ${skipped}`);
  console.log(`\nesempi di loop storici:`);
  for (const s of loopSamples) console.log("  -", s);
  if (!COMMIT) console.log(`\n(nessuna scrittura: rilancia con --commit)`);
  store.close();
}

main();
