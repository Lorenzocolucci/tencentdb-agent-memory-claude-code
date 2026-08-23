/**
 * Unified hook entry point. Dispatched by the first CLI arg.
 *
 * Usage from cc plugin hook config:
 *   node ${CLAUDE_PLUGIN_ROOT}/dist/lib/hook.mjs <event-name>
 *
 * Where <event-name> is one of:
 *   session-start | user-prompt-submit | post-tool-use | stop |
 *   search | status | clear-session
 */

import { GatewayClient, RECALL_TIMEOUT_MS, CAPTURE_TIMEOUT_MS } from "./gateway-client.js";
import { getSessionKey, getProjectName } from "./session-key.js";
import { readAllTurns } from "./transcript.js";
import { DaemonManager, readDaemonState, clearDaemonState } from "./daemon.js";
import { resolveDataDirDetailed, type DataDirSource } from "./data-dir.js";
import { raiseAlarm, clearAlarm, drainAlarms } from "./alarm.js";
import { assessStaleness, describeStaleness, newestTranscriptMs } from "./staleness.js";
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_INJECT_CHARS = 10_000;
const MAX_CAPTURE_TURNS = 50;

export type HookEvent =
  | "session-start"
  | "user-prompt-submit"
  | "post-tool-use"
  | "stop"
  | "search"
  | "search-stdin"
  | "status"
  | "clear-session";

export interface HookInput {
  stdin: string;
  client: GatewayClient;
  args?: string[];
  /** Where alarms and cursors live. Defaults to the discovered data dir. */
  dataDir?: string;
}

export async function handleHook(event: HookEvent, input: HookInput): Promise<string> {
  const data = parseStdin(input.stdin);
  const dataDir = input.dataDir ?? resolveDataDir();
  switch (event) {
    case "session-start":
      return handleSessionStart(data, input.client, dataDir);
    case "user-prompt-submit":
      return handleUserPromptSubmit(data, input.client, dataDir);
    case "post-tool-use":
      return handlePostToolUse(data, input.client);
    case "stop":
      return handleStop(data, input.client, dataDir);
    case "search":
      return handleSearch(input.args ?? [], input.client);
    case "search-stdin":
      return handleSearchStdin(input.stdin, input.client);
    case "status":
      return handleStatus(input.client);
    case "clear-session":
      return handleClearSession(data, input.client);
    default:
      return "";
  }
}

interface HookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_output_is_error?: boolean;
  tool_use_id?: string;
  stop_hook_active?: boolean;
}

function parseStdin(raw: string): HookStdin {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookStdin;
  } catch {
    return {};
  }
}

async function handleSessionStart(
  _data: HookStdin,
  client: GatewayClient,
  dataDir: string,
): Promise<string> {
  // NO SILENT FAILURE: an unreachable gateway used to produce one line in
  // hook.log. It cost 5 days of lost memory (2026-08-13 → 2026-08-18).
  const health = await client.healthDetailed();
  if (!health) {
    await raiseAlarm(
      dataDir,
      "gateway-unreachable",
      "il gateway non risponde — NULLA viene salvato in memoria",
    );
    return "";
  }
  await clearAlarm(dataDir, "gateway-unreachable");

  // Reachable but unhappy is a THIRD state, not a synonym for "down". The
  // gateway answers 503 while its embedding provider is refusing calls
  // (DeepInfra: "429 engine_overloaded") even though /recall still works.
  // Say what is actually true — and clear it the moment it recovers, so a
  // transient provider hiccup costs one honest line, not a standing siren.
  if (health.status === "degraded" || health.embedding === "failing") {
    await raiseAlarm(
      dataDir,
      "memory-degraded",
      "l'embedder non risponde bene — la memoria funziona ma richiama peggio",
    );
  } else {
    await clearAlarm(dataDir, "memory-degraded");
  }

  // The hole detector: memory silent while work kept happening.
  const verdict = assessStaleness(
    health.last_capture_at,
    newestTranscriptMs(join(homedir(), ".claude", "projects")),
    Date.now(),
  );
  if (verdict.stale) {
    await raiseAlarm(dataDir, "memory-stale", describeStaleness(verdict));
  } else {
    await clearAlarm(dataDir, "memory-stale");
  }
  return "";
}

async function handleUserPromptSubmit(
  data: HookStdin,
  client: GatewayClient,
  dataDir: string,
): Promise<string> {
  const prompt = data.prompt ?? "";
  const cwd = data.cwd ?? process.cwd();
  // NO SILENT FAILURE: this hook is the only channel Claude Code renders
  // straight to the user, so every failure recorded elsewhere surfaces here.
  const alarmLine = await drainAlarms(dataDir);
  if (!prompt) return alarmLine ? JSON.stringify({ systemMessage: alarmLine }) : "";

  const sessionKey = getSessionKey(cwd);
  const project = getProjectName(cwd);

  // Primary path: L1/L2/L3 recall (structured atoms + persona + scene).
  // Pass cc's session_id so the session-open banner fires once per real session
  // (sessionKey is stable per project and would fire it ~once per gateway boot).
  const recall = await client.recall(prompt, sessionKey, project, data.session_id);
  let context = recall.context ?? "";

  // Fallback 1: daemon /search/conversations (FTS5 BM25 on L0 table).
  if (!context) {
    const conv = await client.searchConversations(prompt, {
      limit: 3,
      sessionKey,
    });
    if (conv.total > 0 && conv.results) {
      context = `## Past conversations (relevant to current prompt)\n\n${conv.results}`;
    }
  }

  // Fallback 2: direct L0 jsonl file scan. Covers the case where FTS5 is
  // unavailable (e.g. Node.js built-in node:sqlite lacks fts5 module) AND
  // no embedding service is configured. Reads $TDAI_DATA_DIR/conversations/
  // and does simple keyword matching — no ranking, but good enough to
  // surface relevant history on day zero.
  if (!context) {
    const dataDir = process.env.TDAI_DATA_DIR;
    if (dataDir) {
      context = await searchL0JsonlDirect(join(dataDir, "conversations"), prompt, sessionKey, 3);
    }
  }

  if (!context) return alarmLine ? JSON.stringify({ systemMessage: alarmLine }) : "";

  // Banner visibility fix: the session-open banner ("🧠 …") lives inside
  // `context`, which is delivered as additionalContext — model-only. The model
  // has to voluntarily echo it, which it often does not, so the user never sees
  // that memory loaded. Extract the banner line (BEFORE truncation) and ALSO
  // emit it as a top-level `systemMessage`, which Claude Code renders directly
  // to the user — guaranteed visible, once per session (the gateway only puts
  // the banner block in the context on the first turn).
  const bannerMatch = context.match(/<session-open-banner>[\s\S]*?<\/session-open-banner>/);
  const bannerLine = bannerMatch
    ? (bannerMatch[0]
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("<") && !s.startsWith("FIRST TURN"))[0] ?? "")
    : "";

  if (context.length > MAX_INJECT_CHARS) {
    context =
      context.slice(0, MAX_INJECT_CHARS - 100) +
      "\n\n[…recall truncated — use /memory-search for full results…]";
  }
  const out: {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
    systemMessage?: string;
  } = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
  // An alarm always wins the systemMessage slot: "memory is broken" matters
  // more than "memory remembers you", and showing the banner while capture is
  // dead is exactly the false reassurance that hid this outage for 10 days.
  const message = alarmLine || bannerLine;
  if (message) out.systemMessage = message;
  return JSON.stringify(out);
}

/** Max characters of failed-tool output forwarded to the gateway. */
const MAX_TOOL_OUTPUT_CHARS = 2_000;

/**
 * Best-effort stringification of a tool result for friction capture. Returns
 * undefined when there is nothing usable — the caller then sends nothing and
 * behaviour is exactly as before.
 */
function stringifyToolOutput(resp: unknown): string | undefined {
  if (resp == null) return undefined;
  let text: string;
  if (typeof resp === "string") {
    text = resp;
  } else {
    try {
      text = JSON.stringify(resp) ?? "";
    } catch {
      return undefined;
    }
  }
  text = text.trim();
  if (!text) return undefined;
  return text.length > MAX_TOOL_OUTPUT_CHARS ? text.slice(0, MAX_TOOL_OUTPUT_CHARS) : text;
}

async function handlePostToolUse(data: HookStdin, client: GatewayClient): Promise<string> {
  // Proactive injection by SITUATION (Track A 3+4): when the agent touches a
  // file, surface what the graph already knows about it. Silent (returns "")
  // unless relevant; the gateway enforces once-per-file-per-session.
  const toolName = data.tool_name ?? "";
  if (!toolName) return "";
  const cwd = data.cwd ?? process.cwd();
  const sessionKey = getSessionKey(cwd);

  // Friction capture: on a FAILED tool call, forward a bounded slice of the raw
  // output so the gateway can record it as a `bug` event. This is the ONLY way
  // memory ever sees the workshop — readAllTurns (capture) drops tool traffic by
  // design, so before this a repeated technical failure was invisible to the
  // Mistake Notebook. Bounded here (not just gateway-side) to keep the hook
  // payload small; secrets are redacted gateway-side before anything is stored.
  const toolOutputText =
    data.tool_output_is_error === true ? stringifyToolOutput(data.tool_response) : undefined;

  let context = await client.observe({
    toolName,
    sessionKey,
    toolInput: data.tool_input,
    toolOutputIsError: data.tool_output_is_error,
    toolOutputText,
  });
  if (!context) return "";

  if (context.length > MAX_INJECT_CHARS) {
    context = context.slice(0, MAX_INJECT_CHARS - 100) + "\n\n[…truncated…]";
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
  });
}

async function handleStop(
  data: HookStdin,
  client: GatewayClient,
  dataDirIn: string,
): Promise<string> {
  if (data.stop_hook_active === true) return "";
  if (!data.transcript_path) return "";

  // cc may trigger Stop before the last assistant block is flushed to disk.
  // Poll the file size until two consecutive 100ms ticks see identical bytes,
  // capped at 2s. Replaces a fragile 800ms hard sleep that still missed slow
  // disks on real-machine validation.
  await waitForTranscriptStable(data.transcript_path, 2_000);

  const allTurns = await readAllTurns(data.transcript_path);
  if (allTurns.length === 0) {
    // Audit trail: a Stop that captures nothing must still say so. Silence
    // here is exactly how 10 days of memory went missing unnoticed.
    await safeLog(
      join(dataDirIn, "hook.log"),
      `stop: 0 turni leggibili da ${data.transcript_path} — niente da salvare`,
    );
    return "";
  }

  // Persist a per-session cursor so the next Stop only sends turns appended
  // after this one. Without it, every Stop posts the latest N turns and the
  // Gateway writes them to L0 again, duplicating long sessions across calls.
  const dataDir = dataDirIn;
  const cursorId = sanitizeCursorId(
    data.session_id ?? (basename(data.transcript_path).replace(/\.jsonl$/, "") || "default"),
  );
  const lastSent = await readCursor(dataDir, cursorId);

  let newTurns = allTurns.slice(lastSent);
  if (newTurns.length === 0) {
    await safeLog(
      join(dataDirIn, "hook.log"),
      `stop: nessun turno nuovo (${allTurns.length} totali, cursore a ${lastSent})`,
    );
    return "";
  }

  // Bound the first capture so a pre-existing long transcript doesn't dump
  // hundreds of turns in a single /capture request.
  if (newTurns.length > MAX_CAPTURE_TURNS) {
    newTurns = newTurns.slice(-MAX_CAPTURE_TURNS);
  }

  const cwd = data.cwd ?? process.cwd();
  const sessionKey = getSessionKey(cwd);

  const messages = newTurns.flatMap((t) => [
    { role: "user" as const, content: t.user },
    { role: "assistant" as const, content: t.assistant },
  ]);

  const lastTurn = newTurns[newTurns.length - 1];
  // Phase 3: NO SILENT FAILURE — captureTurn already retries once (2s gap)
  // internally. If both attempts fail, warn visibly in the CC UI so the user
  // knows the session was NOT saved, instead of silently logging to a file.
  const captureResult = await client.captureTurn({
    user_content: lastTurn.user,
    assistant_content: lastTurn.assistant,
    messages,
    session_key: sessionKey,
    session_id: data.session_id,
  });
  if (captureResult === null) {
    // NO SILENT FAILURE: stderr now, and a breadcrumb that the NEXT prompt
    // turns into a systemMessage the user cannot miss.
    await raiseAlarm(
      dataDir,
      "capture-failed",
      `sessione NON salvata (${newTurns.length} turni persi) — gateway giù o token scaduto`,
    );
    await safeLog(join(dataDir, "hook.log"), "stop: captureTurn failed after retry — session not saved");
    // Do NOT advance the cursor: next Stop will retry the unsent turns.
    return "";
  }
  // A 200 response is not proof of a write: the gateway reports how many L0
  // rows it actually persisted. Zero means the turns evaporated, which is the
  // failure mode most likely to go unnoticed — so it gets its own alarm and
  // the cursor does NOT advance.
  if (captureResult.l0_recorded === 0) {
    await raiseAlarm(
      dataDir,
      "capture-empty",
      `il gateway ha risposto OK ma non ha scritto nulla (${newTurns.length} turni)`,
    );
    return "";
  }
  await clearAlarm(dataDir, "capture-failed");
  await clearAlarm(dataDir, "capture-empty");
  await writeCursor(dataDir, cursorId, allTurns.length);
  await safeLog(
    join(dataDir, "hook.log"),
    `stop: salvati ${captureResult.l0_recorded} messaggi (${newTurns.length} turni) — cursore ${lastSent}→${allTurns.length}`,
  );
  return "";
}

async function waitForTranscriptStable(path: string, maxMs: number): Promise<void> {
  const start = Date.now();
  let lastSize = -1;
  let stableTicks = 0;
  while (Date.now() - start < maxMs) {
    try {
      const st = await stat(path);
      if (st.size === lastSize) {
        stableTicks++;
        if (stableTicks >= 2) return;
      } else {
        stableTicks = 0;
        lastSize = st.size;
      }
    } catch {
      // not yet written
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Resolve the gateway data directory. See ./data-dir.ts for the full story —
 * in short, this used to count `..` hops and broke the day Claude Code changed
 * the plugin install layout, which silently stopped capture for 10 days.
 */
function resolveDataDirWithSource(): {
  dir: string;
  source: DataDirSource;
  isBackup: boolean;
} {
  let scriptPath: string;
  try {
    scriptPath = fileURLToPath(import.meta.url);
  } catch {
    scriptPath = process.argv[1] ?? "";
  }
  const res = resolveDataDirDetailed({ scriptPath });
  return { dir: res.dir, source: res.source, isBackup: res.chosenIsBackup };
}

function resolveDataDir(): string {
  return resolveDataDirWithSource().dir;
}

function sanitizeCursorId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default";
}

async function readCursor(dataDir: string, cursorId: string): Promise<number> {
  try {
    const raw = await readFile(join(dataDir, "cursors", `${cursorId}.json`), "utf-8");
    const obj = JSON.parse(raw) as { lastSentIndex?: unknown };
    return typeof obj.lastSentIndex === "number" && obj.lastSentIndex >= 0
      ? obj.lastSentIndex
      : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(dataDir: string, cursorId: string, lastSentIndex: number): Promise<void> {
  const dir = join(dataDir, "cursors");
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${cursorId}.json.tmp`);
  const final = join(dir, `${cursorId}.json`);
  await writeFile(
    tmp,
    JSON.stringify({ lastSentIndex, updatedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  // Atomic replace so a crashed write never corrupts the cursor file.
  await rename(tmp, final);
}

async function handleSearch(args: string[], client: GatewayClient): Promise<string> {
  const query = args.join(" ").trim();
  if (!query) return "Usage: /memory-search <query>";
  const result = await client.searchMemories(query, { limit: 10 });
  return result.results || "No memories found.";
}

/**
 * Read the query from stdin instead of argv. Used by the memory-search skill
 * to avoid the cc `$ARGUMENTS` literal-replaceAll RCE surface (see Anthropic
 * GH issue #16163) — when the query rides on stdin it never touches a shell
 * word-split or expansion stage.
 */
async function handleSearchStdin(rawStdin: string, client: GatewayClient): Promise<string> {
  const query = rawStdin.trim();
  if (!query) return "Usage: pipe the query to stdin";
  const result = await client.searchMemories(query, { limit: 10 });
  return result.results || "No memories found.";
}

async function handleStatus(client: GatewayClient): Promise<string> {
  const ok = await client.health();
  const dataDir = resolveDataDir();
  const hookLog = join(dataDir, "hook.log");
  const daemonLog = join(dataDir, "daemon.log");
  const header = ok ? "TDAI memory daemon: healthy" : "TDAI memory daemon: unreachable";
  return `${header}\nhook log:   ${hookLog}\ndaemon log: ${daemonLog}`;
}

async function handleClearSession(data: HookStdin, client: GatewayClient): Promise<string> {
  const cwd = data.cwd ?? process.cwd();
  const sessionKey = getSessionKey(cwd);
  await client.sessionEnd(sessionKey);
  return `Cleared session buffer for: ${sessionKey}`;
}

// ============================================================================
// L0 jsonl direct search (last-resort fallback)
// ============================================================================

interface L0JsonlRecord {
  sessionKey?: string;
  role?: string;
  content?: string;
  recordedAt?: string;
}

async function searchL0JsonlDirect(
  convDir: string,
  query: string,
  sessionKey: string,
  limit: number,
): Promise<string> {
  let files: string[];
  try {
    files = (await readdir(convDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return "";
  }
  if (files.length === 0) return "";

  // Sort by mtime desc so newer conversations are scanned first. Filename
  // ordering used to assume "YYYY-MM-DD.jsonl" naming, which broke for any
  // other scheme (e.g. cc transcript UUIDs).
  const withMtime = await Promise.all(
    files.map(async (f) => {
      try {
        const st = await stat(join(convDir, f));
        return { name: f, mtime: st.mtimeMs };
      } catch {
        return { name: f, mtime: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const sortedFiles = withMtime.map((e) => e.name);

  // CJK 2-gram tokens, sans a small stop set. The previous list stopped
  // common content-bearing pronouns ("我们/你们/这个/可以/有没/没有" etc.)
  // which silently shredded recall for everyday Chinese queries — keep only
  // genuinely low-signal interrogative / connective fragments here.
  const CJK_STOP = new Set([
    "之前", "前聊", "聊的", "还记", "记得", "得么", "得吗",
    "一下", "怎么", "什么", "关于", "知道", "以前", "上次",
    "如何", "为何", "为啥", "哪里", "哪些", "为什",
    "请问", "请帮", "帮我", "麻烦",
  ]);
  const keywords: string[] = [];
  for (const seg of query.toLowerCase().replace(/[^\w一-鿿]/g, " ").split(/\s+/)) {
    if (!seg) continue;
    if (/[一-鿿]/.test(seg)) {
      for (let i = 0; i <= seg.length - 2; i++) {
        const gram = seg.slice(i, i + 2);
        if (!CJK_STOP.has(gram)) keywords.push(gram);
      }
    } else if (seg.length >= 2) {
      keywords.push(seg);
    }
  }
  if (keywords.length === 0) return "";

  type Match = { role: string; content: string; recordedAt: string; hits: number };
  const matches: Match[] = [];
  const seen = new Set<string>();

  for (const f of sortedFiles) {
    // Stream the file line-by-line: large jsonl (multi-MB) used to be
    // readFile'd into memory in full, which OOM'd on long-running sessions.
    let rl;
    try {
      rl = createInterface({
        input: createReadStream(join(convDir, f), { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });
    } catch {
      continue;
    }
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as L0JsonlRecord;
          if (rec.sessionKey !== sessionKey) continue;
          const text = rec.content ?? "";
          const textLower = text.toLowerCase();
          const hits = keywords.filter((kw) => textLower.includes(kw)).length;
          if (hits === 0) continue;
          // Deduplicate identical content (e.g. repeated user prompts).
          const fingerprint = text.slice(0, 120);
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          matches.push({
            role: rec.role ?? "unknown",
            content: text.length > 2000 ? text.slice(0, 2000) + "…" : text,
            recordedAt: rec.recordedAt ?? "",
            hits,
          });
        } catch {
          // skip malformed lines
        }
      }
    } finally {
      rl.close();
    }
  }

  if (matches.length === 0) return "";

  // Rank: assistant messages first (more informative than user prompts),
  // then by keyword hits (desc), then content length (desc).
  const rolePriority = (r: string) => (r === "assistant" ? 1 : 0);
  matches.sort(
    (a, b) =>
      rolePriority(b.role) - rolePriority(a.role) ||
      b.hits - a.hits ||
      b.content.length - a.content.length,
  );

  const selected = matches.slice(0, limit);
  const lines = [`Found ${selected.length} matching conversation(s):`, ""];
  for (const m of selected) {
    lines.push("---");
    lines.push(`**[${m.role}]** ${m.recordedAt}`);
    lines.push("");
    lines.push(m.content);
    lines.push("");
  }
  return `## Past conversations (relevant to current prompt)\n\n${lines.join("\n")}`;
}

// ============================================================================
// CLI entry — only runs when this file is executed directly via `node hook.js`
// ============================================================================

async function main(): Promise<void> {
  const event = (process.argv[2] ?? "") as HookEvent;
  const args = process.argv.slice(3);

  const { dir: dataDir, source: dataDirSource, isBackup: dataDirIsBackup } =
    resolveDataDirWithSource();
  const logPath = join(dataDir, "hook.log");

  // NO SILENT FAILURE #1: losing our own data dir is what actually happened on
  // 2026-08-13 (Claude Code changed the plugin install layout). Everything
  // downstream then failed with "no daemon, skipped" in a log nobody reads.
  if (dataDirSource === "fallback") {
    await raiseAlarm(
      dataDir,
      "data-dir-lost",
      "il plugin non trova la cartella del gateway — cattura e recall SPENTI",
    );
  } else {
    await clearAlarm(dataDir, "data-dir-lost");
  }

  // NO SILENT FAILURE #1b: landing on an ARCHIVE is worse than landing nowhere.
  // On 2026-08-23 the live state.json was truncated to 0 bytes while the gateway
  // was running, and a two-month-old `*.BACKUP-*` dir became the only parseable
  // candidate. Writing there would bury every new memory in a stale database
  // while everything looked healthy.
  if (dataDirIsBackup) {
    await raiseAlarm(
      dataDir,
      "writing-to-backup",
      "la memoria sta puntando a una cartella di BACKUP — i nuovi ricordi finirebbero in un archivio vecchio",
    );
  } else {
    await clearAlarm(dataDir, "writing-to-backup");
  }

  try {
    const stdin = await readStdin();

    const mgr = new DaemonManager({ dataDir });
    let state = await readDaemonState(dataDir);

    if (event === "session-start") {
      // A stale state.json (dead pid / unreachable port) used to wedge the
      // daemon forever: the old `!state` guard only spawned when state was
      // ABSENT, so a leftover file meant ensureRunning never ran and every
      // recall/capture hit ECONNREFUSED. Probe the recorded daemon; if it
      // doesn't answer /health, drop the stale state and respawn fresh.
      //
      // Exception: an externally-managed gateway (ccPid <= 0, owned by
      // start-gateway.ps1) is NEVER cleared or respawned when it's
      // temporarily unreachable. Clearing it would let ensureRunning spawn a
      // session-bound daemon that overwrites the operator's state.json and
      // then self-exits when this cc session ends (the Windows failure mode
      // this model was built to avoid). Leave it; the operator restarts it.
      if (state && state.ccPid > 0 && !(await mgr.probe())) {
        await safeLog(
          logPath,
          `session-start: stale daemon state (pid=${state.pid} port=${state.port}) unreachable — clearing and respawning`,
        );
        await clearDaemonState(dataDir);
        state = null;
      }
      if (!state) {
        try {
          state = await mgr.ensureRunning(process.ppid);
        } catch (err) {
          await safeLog(logPath, `session-start: spawn failed: ${(err as Error).message}`);
        }
      }
    }

    if (!state) {
      await safeLog(logPath, `${event}: no daemon, skipped`);
      // NO SILENT FAILURE #2: "no daemon, skipped" means memory is OFF. It was
      // logged 6 times over 10 days and nobody ever saw it. `user-prompt-submit`
      // is excluded only because it is the hook that DELIVERS alarms — it
      // already reports the condition below, without recording itself.
      if (event !== "user-prompt-submit") {
        await raiseAlarm(
          dataDir,
          "gateway-unreachable",
          "nessun gateway attivo — la sessione NON viene salvata",
        );
      } else {
        const line = await drainAlarms(dataDir);
        const msg =
          line || "🚨 SINAPSYS — la memoria NON sta funzionando: nessun gateway attivo";
        process.stdout.write(JSON.stringify({ systemMessage: msg }));
      }
      return;
    }

    // Phase 3: TOKEN/AUTH — read token fresh from disk (not cached at startup).
    // GatewayClient will also re-read it on each request via tokenPath.
    const token = await mgr.readToken(state.tokenPath);
    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${state.port}`,
      token,
      // Phase 3: HOOK CLIENT TIMEOUT — use named constants, not magic numbers.
      // recall: short (non-blocking prompt); capture: generous (don't drop saves);
      // other events: DEFAULT_TIMEOUT_MS (see gateway-client.ts constants).
      timeoutMs: event === "user-prompt-submit" ? RECALL_TIMEOUT_MS : CAPTURE_TIMEOUT_MS,
      logPath,
      // Phase 3: TOKEN/AUTH — pass tokenPath so the client always reads the
      // CURRENT token from file on each request; handles stale-token-after-restart.
      tokenPath: state.tokenPath,
    });

    const out = await handleHook(event, { stdin, client, args, dataDir });
    if (out) process.stdout.write(out);
  } catch (err) {
    await safeLog(logPath, `${event}: ${(err as Error).message}`);
    // NO SILENT FAILURE #3: this catch used to STOP at the line above. Every
    // exception raised after the data dir was resolved — a missing token file,
    // a corrupted state.json, a bug in any handler — turned recall AND capture
    // off while writing one line into the file nobody reads. Same shape as the
    // 2026-08-13 → 08-22 outage; none of the seven tripwires can see it,
    // because they all live inside the try block that never completes.
    // Verified live on 2026-08-23: with the token file removed, session-start,
    // user-prompt-submit and stop all exited 0 and said nothing at all.
    await reportHookCrash(dataDir, event, err);
    // The prompt hook is the only channel Claude Code renders to the user, so
    // when IT is the one that crashed, it must still speak before it dies.
    if (event === "user-prompt-submit") {
      try {
        const line = await drainAlarms(dataDir);
        if (line) process.stdout.write(JSON.stringify({ systemMessage: line }));
      } catch {
        // fail-open: an alarm that breaks the conversation is worse than the bug.
      }
    }
  }
}

/** Max chars of an error message forwarded to the user-facing alarm. */
const MAX_CRASH_MESSAGE_CHARS = 200;

/**
 * Turn an unexpected exception into a signal Lorenzo actually sees.
 * Never throws: reporting a failure must not become one.
 */
export async function reportHookCrash(
  dataDir: string,
  event: string,
  err: unknown,
): Promise<void> {
  const raw = err instanceof Error ? err.message : String(err);
  const detail = raw.slice(0, MAX_CRASH_MESSAGE_CHARS);
  await raiseAlarm(
    dataDir,
    "hook-crashed",
    `la memoria si è fermata con un errore (${event}) — nulla viene salvato né richiamato: ${detail}`,
  );
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", () => resolve(""));
  });
}

async function safeLog(path: string, msg: string): Promise<void> {
  try {
    await appendFile(path, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // ignore
  }
}

// Cross-platform main-module detection. The previous `file://${argv[1]}`
// string never matched import.meta.url on Windows (drive-letter path with
// backslashes vs a proper file:/// URL), so main() silently never ran.
const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(() => process.exit(0));
}
