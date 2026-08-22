/**
 * Recover Claude Code sessions that never reached memory.
 *
 * WHY
 * ---
 * Between 2026-08-13 and 2026-08-22 the plugin could not resolve its own data
 * dir (Claude Code changed the install layout; see lib/data-dir.ts), so every
 * Stop hook exited with "no daemon, skipped" and NOTHING was captured. Nine
 * sessions — both what Lorenzo wrote and what Claude answered — exist only as
 * transcripts on disk.
 *
 * This replays those transcripts through the same `/capture` endpoint the Stop
 * hook uses, so the recovered turns go through the identical pipeline
 * (L0 → extraction → KB) rather than being injected by a side door.
 *
 * SAFETY
 * ------
 * - dry-run by default; `--commit` is required to write;
 * - resumable: a per-session cursor is written after every accepted chunk, so
 *   an interrupted run continues where it stopped and never duplicates;
 * - the cursor is the SAME file the Stop hook uses, so a recovered session is
 *   not re-sent when Claude Code next stops on it.
 *
 * USAGE
 *   npx tsx tools/recover-sessions.mts                 # dry-run, since 2026-08-13
 *   npx tsx tools/recover-sessions.mts --commit
 *   npx tsx tools/recover-sessions.mts --since 2026-08-01 --commit
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readAllTurns, type Turn } from "../claude-code-plugin/lib/transcript.js";
import { getSessionKey } from "../claude-code-plugin/lib/session-key.js";
import { resolveDataDirDetailed } from "../claude-code-plugin/lib/data-dir.js";

const PROJECTS_ROOT = join(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  ".claude",
  "projects",
);

/** Max turns per /capture request. */
const CHUNK_TURNS = 20;
/**
 * Max characters per /capture request. Turn COUNT is a bad unit here: a single
 * Argus turn can merge dozens of assistant blocks and weigh megabytes, and 20
 * of those timed out the gateway on the first run. Weight is what matters.
 */
const CHUNK_CHARS = 300_000;
/** Pause between chunks so a recovery never starves live recall. */
const PAUSE_MS = 250;

interface SessionOnDisk {
  transcriptPath: string;
  sessionId: string;
  project: string;
  cwd: string;
  lastTimestamp: string;
}

function parseArgs(argv: string[]) {
  const commit = argv.includes("--commit");
  const sinceIdx = argv.indexOf("--since");
  const since = sinceIdx >= 0 ? argv[sinceIdx + 1] : "2026-08-13";
  return { commit, since };
}

/** Read `cwd` and the last timestamp without holding the whole file twice. */
function inspectTranscript(path: string): { cwd: string; last: string } | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let cwd = "";
  let last = "";
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
    if (typeof o.timestamp === "string") last = o.timestamp;
  }
  if (!last) return null;
  return { cwd, last };
}

function discover(since: string): SessionOnDisk[] {
  const out: SessionOnDisk[] = [];
  let projects: string[];
  try {
    projects = readdirSync(PROJECTS_ROOT);
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = join(PROJECTS_ROOT, project);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const transcriptPath = join(dir, file);
      const info = inspectTranscript(transcriptPath);
      if (!info || info.last < since) continue;
      out.push({
        transcriptPath,
        sessionId: file.replace(/\.jsonl$/, ""),
        project,
        cwd: info.cwd,
        lastTimestamp: info.last,
      });
    }
  }
  out.sort((a, b) => (a.lastTimestamp < b.lastTimestamp ? -1 : 1));
  return out;
}

function sanitizeCursorId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default";
}

function readCursor(dataDir: string, cursorId: string): number {
  try {
    const raw = readFileSync(join(dataDir, "cursors", `${cursorId}.json`), "utf-8");
    const o = JSON.parse(raw) as { lastSentIndex?: unknown };
    return typeof o.lastSentIndex === "number" && o.lastSentIndex >= 0 ? o.lastSentIndex : 0;
  } catch {
    return 0;
  }
}

function writeCursor(dataDir: string, cursorId: string, lastSentIndex: number): void {
  const dir = join(dataDir, "cursors");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${cursorId}.json`),
    JSON.stringify({ lastSentIndex, updatedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
}

interface GatewayEndpoint {
  baseUrl: string;
  token: string;
  dataDir: string;
}

function readGateway(): GatewayEndpoint {
  const res = resolveDataDirDetailed({ scriptPath: join(process.cwd(), "tools", "x.mjs") });
  // The tool runs from the repo, where discovery cannot work: fall back to the
  // well-known plugin data root.
  const dataDir = res.source === "discovered"
    ? res.dir
    : join(process.env.USERPROFILE ?? "", ".claude", "plugins", "data", "tdai-memory-tdai-local");
  const statePath = join(dataDir, "state.json");
  if (!existsSync(statePath)) {
    throw new Error(`state.json non trovato in ${dataDir} — il gateway è acceso?`);
  }
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
    port?: number;
    tokenPath?: string;
  };
  if (!state.port) throw new Error("state.json senza porta");
  const token = state.tokenPath && existsSync(state.tokenPath)
    ? readFileSync(state.tokenPath, "utf-8").trim()
    : "";
  return { baseUrl: `http://127.0.0.1:${state.port}`, token, dataDir };
}

async function postCapture(
  gw: GatewayEndpoint,
  payload: unknown,
): Promise<{ l0_recorded: number } | null> {
  try {
    const res = await fetch(`${gw.baseUrl}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(gw.token ? { Authorization: `Bearer ${gw.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      process.stderr.write(`  HTTP ${res.status}: ${(await res.text()).slice(0, 200)}\n`);
      return null;
    }
    return (await res.json()) as { l0_recorded: number };
  } catch (err) {
    process.stderr.write(`  errore rete: ${(err as Error).message}\n`);
    return null;
  }
}

/**
 * Read-only probe over the live L0 table: "is this exact user message already
 * stored for this project?".
 *
 * WHY: a chunk that times out CLIENT-side may still have been written by the
 * gateway. Re-running then duplicates it — which is exactly what happened on
 * the first recovery run (49 duplicate rows). The cursor alone cannot know;
 * the database can. Opened read-only, so this can never damage memory.
 */
class L0Index {
  private readonly db: DatabaseSync | null;

  constructor(dataDir: string) {
    const path = join(dataDir, "vectors.db");
    let db: DatabaseSync | null = null;
    try {
      db = existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : null;
    } catch {
      db = null;
    }
    this.db = db;
  }

  /** True when this exact user text is already stored for this session key. */
  alreadyStored(sessionKey: string, userText: string): boolean {
    if (!this.db || !userText) return false;
    try {
      const row = this.db
        .prepare(
          "select 1 as hit from l0_conversations where session_key = ? and role = 'user' and message_text = ? limit 1",
        )
        .get(sessionKey, userText);
      return row !== undefined;
    } catch {
      // A probe that fails must never block a recovery.
      return false;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Group turns by BOTH count and total weight. A turn heavier than the budget
 * is sent on its own rather than dropped — recovering it slowly beats losing it.
 */
function chunkTurns(turns: Turn[]): Turn[][] {
  const out: Turn[][] = [];
  let cur: Turn[] = [];
  let curChars = 0;
  for (const t of turns) {
    const w = t.user.length + t.assistant.length;
    if (cur.length > 0 && (cur.length >= CHUNK_TURNS || curChars + w > CHUNK_CHARS)) {
      out.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(t);
    curChars += w;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

async function main(): Promise<void> {
  const { commit, since } = parseArgs(process.argv.slice(2));
  const gw = readGateway();

  console.log(`Gateway:  ${gw.baseUrl}`);
  console.log(`Dati:     ${gw.dataDir}`);
  console.log(`Da:       ${since}`);
  console.log(`Modalità: ${commit ? "SCRITTURA (--commit)" : "PROVA A VUOTO (dry-run)"}\n`);

  const sessions = discover(since);
  if (sessions.length === 0) {
    console.log("Nessuna sessione da recuperare.");
    return;
  }

  const l0 = new L0Index(gw.dataDir);
  let totalTurns = 0;
  let totalPending = 0;
  let totalSkippedDuplicate = 0;
  let totalWritten = 0;
  let failures = 0;

  for (const s of sessions) {
    const turns: Turn[] = await readAllTurns(s.transcriptPath);
    const cursorId = sanitizeCursorId(s.sessionId);
    const sent = readCursor(gw.dataDir, cursorId);
    const fromCursor = turns.slice(sent);
    // Belt AND braces: the cursor says what we sent, the database says what
    // actually landed. Trust the database.
    const pending = fromCursor.filter((t) => !l0.alreadyStored(getSessionKey(s.cwd || "."), t.user));
    const skipped = fromCursor.length - pending.length;
    totalSkippedDuplicate += skipped;
    totalTurns += turns.length;
    totalPending += pending.length;

    const label = `${s.lastTimestamp.slice(0, 16)}  ${s.project.slice(0, 32).padEnd(32)} ${s.sessionId.slice(0, 8)}`;
    if (pending.length === 0) {
      const note = skipped > 0 ? ` — ${skipped} già presenti nel database` : "";
      console.log(`${label}  già in memoria (${turns.length} turni)${note}`);
      continue;
    }
    if (skipped > 0) {
      console.log(`${label}  ${skipped} turni già nel database, saltati`);
    }
    if (!s.cwd) {
      console.log(`${label}  SALTATA — nessun cwd nel transcript`);
      failures++;
      continue;
    }
    const sessionKey = getSessionKey(s.cwd);
    console.log(
      `${label}  ${pending.length}/${turns.length} turni da recuperare  → ${s.cwd} (key ${sessionKey})`,
    );
    if (!commit) continue;

    let index = sent;
    let ok = true;
    for (const group of chunkTurns(pending)) {
      const messages = group.flatMap((t) => [
        { role: "user" as const, content: t.user },
        { role: "assistant" as const, content: t.assistant },
      ]);
      const lastTurn = group[group.length - 1];
      const res = await postCapture(gw, {
        user_content: lastTurn.user,
        assistant_content: lastTurn.assistant,
        messages,
        session_key: sessionKey,
        session_id: s.sessionId,
      });
      if (res === null || res.l0_recorded === 0) {
        console.log(`  ✗ blocco di ${group.length} turni NON salvato — mi fermo su questa sessione`);
        ok = false;
        failures++;
        break;
      }
      totalWritten += res.l0_recorded;
      index += group.length;
      // Resumable: persist progress after every accepted chunk.
      writeCursor(gw.dataDir, cursorId, index);
      process.stdout.write(`  ✓ ${index}/${turns.length} turni (${res.l0_recorded} messaggi)\r`);
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
    console.log(ok ? `  ✓ completata: ${index}/${turns.length} turni` : "");
  }

  console.log("\n─────────────────────────────────────────");
  console.log(`Sessioni esaminate:    ${sessions.length}`);
  console.log(`Turni totali su disco: ${totalTurns}`);
  console.log(`Turni da recuperare:   ${totalPending}`);
  console.log(`Saltati (già scritti): ${totalSkippedDuplicate}`);
  l0.close();
  if (commit) {
    console.log(`Messaggi scritti:      ${totalWritten}`);
    console.log(`Sessioni fallite:      ${failures}`);
  } else {
    console.log("\nProva a vuoto. Rilancia con --commit per scrivere davvero.");
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
