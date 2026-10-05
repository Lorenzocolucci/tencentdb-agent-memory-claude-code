/**
 * pretool-match.ts — "memory that arrives BEFORE the agent acts".
 *
 * Given the tool call about to run (or that just failed), find at most ONE thing
 * memory knows about THIS project that is relevant to it:
 *   1. a Mistake-Notebook lesson whose trigger names this file / this command's
 *      file / this failure's error signature;
 *   2. a command or file that already failed ≥ 2 times in this project (bug events).
 *
 * HARD RULES
 *  - Project scoping: only lessons/events whose project is a REAL project key and
 *    equals the request's project are ever considered. Never another project's.
 *  - File identity is project + path (repo CLAUDE.md): a bare basename recorded
 *    without a project proves nothing and is ignored.
 *  - No table scans on the request path: everything is precomputed into an
 *    in-memory index, rebuilt at most every REFRESH_MS, built in pages with
 *    event-loop yields so it never starves recall.
 *
 * `match()` is synchronous and in-memory only (p95 well under 1 ms).
 */

import { posix } from "node:path";
import { canonicalKey, isAbsoluteFilePath, normalizeProjectTag } from "./kb-queries.js";
import { normalizeForSignature } from "./friction-capture.js";
import { SIGNATURE_TAG_PREFIX } from "./destructive-capture.js";
import { isRealProjectKey } from "./project-key.js";
import { willingnessTier } from "./stance-track-record.js";
import type { PretoolBugRow, PretoolEntityRow, PretoolLessonRow, PretoolSource } from "./pretool-queries.js";
import { learnToolLesson, matchToolLesson, renderToolLesson, type ToolLesson } from "./tool-lessons.js";

/** Index lifetime. */
export const REFRESH_MS = 5 * 60 * 1000;
/** Bug events read per page between event-loop yields. */
const BUG_PAGE = 500;
/** A lesson is "attested" (may block) from this many evidence events… */
export const ATTESTED_EVIDENCE = 3;
const MAX_TRACKED_SESSIONS = 200;
const MIN_REL_PATH_LEN = 4;
const MAX_TEXT = 220;

export type PretoolPhase = "pre" | "failure";
export type PretoolSeverity = "warn" | "deny";
export type PretoolKind = "lesson" | "recurring-bug";

export interface PretoolRequest {
  sessionKey: string;
  project: string;
  cwd?: string;
  toolName: string;
  toolInput: unknown;
  /** Destructive-command label (claude-code-plugin/lib/destructive-commands.ts), if the action is one-way. */
  oneWay?: string | null;
  /** Failure text (phase "failure"). */
  errorText?: string;
  phase: PretoolPhase;
}

export interface PretoolItem {
  severity: PretoolSeverity;
  kind: PretoolKind;
  lessonId?: string;
  eventId?: string;
  /** Human text for additionalContext / the deny reason. */
  text: string;
}

// ── Index types ──────────────────────────────────────────────────────────────

interface FileRef {
  /** Absolute posix lowercase path (self-identifying). */
  abs?: string;
  /** Project-scoped relative path as recorded. */
  rel?: string;
}

interface LessonEntry {
  id: string;
  domain: string;
  text: string;
  evidenceCount: number;
  confidence: number;
  /** evidence_count >= 3, or a stance fire Lorenzo confirmed. */
  attested: boolean;
  /** willingness tier "trusted" (not demoted by past false alarms). */
  trusted: boolean;
  files: FileRef[];
  errorSignatures: string[];
}

interface BugGroup {
  count: number;
  lastEventId: string;
  lastText: string;
}

interface ProjectIndex {
  lessons: LessonEntry[];
  bugGroups: Map<string, BugGroup>;
}

type Index = Map<string, ProjectIndex>;

// ── Pure helpers (exported for tests) ────────────────────────────────────────

const READONLY_HEADS: ReadonlySet<string> = new Set([
  "ls", "cd", "echo", "cat", "pwd", "head", "tail", "grep", "rg", "find", "where",
  "which", "type", "dir", "wc", "sort", "test", "true", "false", "sleep", "date",
]);

/**
 * Stable "command head" of an already-normalized signature label: the first
 * pipeline segment, env assignments dropped, first ≤3 tokens. null when the
 * command is too generic/read-only to be worth warning about.
 */
export function commandHead(normalizedLabel: string): string | null {
  const segment = normalizedLabel.split(/&&|\|\||;|\|/)[0] ?? "";
  const tokens = unwrapLauncher(segment.trim().split(/\s+/).filter((t) => t && !/^\w+=\S*$/.test(t)));
  if (tokens.length < 2) return null;
  if (READONLY_HEADS.has(tokens[0])) return null;
  if (tokens[0] === "git" && ["status", "log", "diff", "show", "branch"].includes(tokens[1])) return null;
  return tokens.slice(0, 3).join(" ");
}

const LAUNCHERS: ReadonlySet<string> = new Set(["powershell", "powershell.exe", "pwsh", "cmd", "cmd.exe", "bash", "sh"]);

/**
 * A shell launcher says nothing about the command: live 05/10/2026 the head
 * "powershell -noprofile -command" tied a process listing to a past `New-Item
 * -ItemType Junction` failure. Skip the launcher and its flags and use the inner
 * command; a script run with -File keeps the script as its head.
 */
function unwrapLauncher(tokens: string[]): string[] {
  if (!LAUNCHERS.has(tokens[0] ?? "")) return tokens;
  let i = 1;
  while (i < tokens.length && /^[-/]/.test(tokens[i]!)) {
    if (/^-f(ile)?$/.test(tokens[i]!)) return [tokens[0]!, "-file", tokens[i + 1] ?? ""].filter(Boolean);
    i++;
  }
  const inner = tokens.slice(i).map((t, k) => (k === 0 ? t.replace(/^["']/, "") : t));
  if (inner.length > 0) inner[inner.length - 1] = inner[inner.length - 1]!.replace(/["']$/, "");
  return inner.filter(Boolean);
}

/** Head of a raw Bash command, computed exactly like friction-capture's signature label. */
export function commandHeadOfRaw(command: string): string | null {
  return commandHead(normalizeForSignature(command.slice(0, 120)));
}

function toPosixLower(p: string): string {
  return canonicalKey("file", p).slice("file:".length);
}

/** Absolute posix-lowercase path of the file a tool call targets, or undefined. */
export function targetFilePath(toolName: string, toolInput: unknown, cwd?: string): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const o = toolInput as Record<string, unknown>;
  const raw =
    typeof o.file_path === "string" ? o.file_path :
    toolName === "NotebookEdit" && typeof o.notebook_path === "string" ? o.notebook_path :
    undefined;
  if (!raw) return undefined;
  let p = raw.replace(/\\/g, "/");
  if (!isAbsoluteFilePath(p.toLowerCase()) && cwd) p = `${cwd.replace(/\\/g, "/")}/${p}`;
  return posix.normalize(toPosixLower(p));
}

function bashCommand(toolName: string, toolInput: unknown): string | undefined {
  if (toolName !== "Bash" || !toolInput || typeof toolInput !== "object") return undefined;
  const c = (toolInput as { command?: unknown }).command;
  return typeof c === "string" && c.trim() ? c : undefined;
}

/** Project-aware reading of a file entity's identity; null = unattributable. */
export function fileRefFromEntity(e: PretoolEntityRow, projectTag: string): FileRef | null {
  const key = e.canonical_key.startsWith("file:") ? e.canonical_key.slice(5) : e.canonical_key;
  const sep = key.indexOf("::");
  if (sep >= 0) {
    const proj = key.slice(0, sep);
    const rel = key.slice(sep + 2);
    return proj === projectTag && rel ? { rel } : null;
  }
  if (isAbsoluteFilePath(key)) return { abs: key };
  // Bare relative name: provable only through the entity's own project tag.
  return normalizeProjectTag(e.project) === projectTag && key ? { rel: key } : null;
}

function fileRefMatchesPath(ref: FileRef, reqAbs: string, cwdPosix: string | undefined): boolean {
  if (ref.abs) return ref.abs === reqAbs;
  if (!ref.rel) return false;
  if (cwdPosix && !reqAbs.startsWith(`${cwdPosix}/`)) return false;
  return reqAbs === ref.rel || reqAbs.endsWith(`/${ref.rel}`);
}

function commandMentionsFile(cmdLower: string, ref: FileRef): boolean {
  const needle = ref.abs ?? ref.rel;
  if (!needle || needle.length < MIN_REL_PATH_LEN) return false;
  const i = cmdLower.indexOf(needle);
  if (i < 0) return false;
  const before = i === 0 ? "" : cmdLower[i - 1];
  return before === "" || !/[\w.-]/.test(before);
}

function errorMentionsSignature(errLower: string, sig: string): boolean {
  const http = sig.match(/^HTTP_(\d{3})$/);
  if (http) return new RegExp(`\\b${http[1]}\\b`).test(errLower);
  return errLower.includes(sig.toLowerCase());
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseTrigger(raw: string): { files: string[]; errorSignatures: string[] } {
  try {
    const o = JSON.parse(raw) as { files?: unknown; error_signatures?: unknown };
    return { files: strings(o.files), errorSignatures: strings(o.error_signatures) };
  } catch {
    return { files: [], errorSignatures: [] };
  }
}

function parseStringArray(raw: string): string[] {
  try {
    return strings(JSON.parse(raw));
  } catch {
    return [];
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── Index build ──────────────────────────────────────────────────────────────

function buildLessonEntry(
  row: PretoolLessonRow,
  projectTag: string,
  entities: ReadonlyMap<string, PretoolEntityRow>,
): LessonEntry | null {
  const trig = parseTrigger(row.trigger_pattern);
  const files: FileRef[] = [];
  for (const id of trig.files) {
    const ent = entities.get(id);
    const ref = ent ? fileRefFromEntity(ent, projectTag) : null;
    if (ref) files.push(ref);
  }
  if (files.length === 0 && trig.errorSignatures.length === 0) return null; // empty trigger can't match
  const tier = willingnessTier(row.stance_willingness);
  if (tier === "suppressed") return null; // a stance that cried wolf stays silent
  return {
    id: row.id,
    domain: row.domain,
    text: row.lesson_text,
    evidenceCount: row.evidence_count,
    confidence: row.confidence,
    attested: row.evidence_count >= ATTESTED_EVIDENCE || row.stance_confirmed_count >= 1,
    trusted: tier === "trusted",
    files,
    errorSignatures: trig.errorSignatures,
  };
}

function projectBucket(index: Index, projectTag: string): ProjectIndex {
  let b = index.get(projectTag);
  if (!b) {
    b = { lessons: [], bugGroups: new Map() };
    index.set(projectTag, b);
  }
  return b;
}

function addBugToGroup(bucket: ProjectIndex, key: string, row: PretoolBugRow): void {
  const g = bucket.bugGroups.get(key);
  bucket.bugGroups.set(key, { count: (g?.count ?? 0) + 1, lastEventId: row.id, lastText: row.text });
}

/** Group keys of one bug event: its Bash command head and/or its file identities. */
function bugGroupKeys(
  row: PretoolBugRow,
  files: ReadonlyMap<string, PretoolEntityRow>,
  projectTag: string,
): string[] {
  const keys: string[] = [];
  for (const item of parseStringArray(row.entities_json)) {
    if (item.startsWith(SIGNATURE_TAG_PREFIX)) {
      const [tool, label] = item.slice(SIGNATURE_TAG_PREFIX.length).split("|");
      const head = tool === "Bash" && label ? commandHead(label) : null;
      if (head) keys.push(`bash:${head}`);
      continue;
    }
    const ent = files.get(item);
    const ref = ent ? fileRefFromEntity(ent, projectTag) : null;
    if (ref?.abs) keys.push(`abs:${ref.abs}`);
    else if (ref?.rel) keys.push(`rel:${ref.rel}`);
  }
  return keys;
}

/** Tool-shaped lessons learned from their evidence (suppressed stances stay silent). */
function buildToolLessons(rows: readonly PretoolLessonRow[], evidenceText: ReadonlyMap<string, string>): ToolLesson[] {
  const out: ToolLesson[] = [];
  for (const r of rows) {
    if (willingnessTier(r.stance_willingness) === "suppressed") continue;
    const texts = parseStringArray(r.evidence_event_ids_json ?? "[]")
      .map((id) => evidenceText.get(id))
      .filter((t): t is string => typeof t === "string");
    const t = learnToolLesson({ id: r.id, domain: r.domain, text: r.lesson_text, evidenceCount: r.evidence_count }, texts);
    if (t) out.push(t);
  }
  return out;
}

// ── Matcher ──────────────────────────────────────────────────────────────────

export interface PretoolMatcherOptions {
  now?: () => number;
  refreshMs?: number;
  logger?: { warn?(msg: string): void };
}

export class PretoolMatcher {
  private index: Index | null = null;
  private builtAt = 0;
  private building: Promise<void> | null = null;
  /** sessionKey → "phase:id" already shown (an item speaks once per session per phase). */
  private readonly shown = new Map<string, Set<string>>();
  /** Tool-behaviour lessons (tool-lessons.ts), rebuilt with the index. */
  private toolLessons: ToolLesson[] = [];
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(private readonly source: PretoolSource, private readonly opts: PretoolMatcherOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.refreshMs = opts.refreshMs ?? REFRESH_MS;
  }

  /** Is an index loaded? A request before the first build returns null (fail open). */
  get ready(): boolean {
    return this.index !== null;
  }

  /** Start a background rebuild when the index is missing/stale. Never blocks, never throws. */
  kickRefresh(): void {
    if (this.building) return;
    if (this.index && this.now() - this.builtAt < this.refreshMs) return;
    this.building = this.refresh()
      .catch((err) => {
        this.opts.logger?.warn?.(`[pretool] index refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        // Keep serving the previous index; retry after refreshMs, not in a hot loop.
        this.builtAt = this.now();
      })
      .finally(() => {
        this.building = null;
      });
  }

  /** Await a rebuild (tests / warm-up). */
  async warm(): Promise<void> {
    this.kickRefresh();
    await this.building;
  }

  private async refresh(): Promise<void> {
    // Yield FIRST: an async function runs synchronously up to its first await,
    // and the queries below must never run inside the caller's tick.
    await yieldToEventLoop();
    const next: Index = new Map();

    const allLessons = this.source.listHeadLessons();
    const lessons = allLessons.filter((l) => isRealProjectKey(l.project));
    const evidenceIds = new Set<string>();
    for (const l of allLessons) for (const id of parseStringArray(l.evidence_event_ids_json ?? "[]")) evidenceIds.add(id);
    const evidenceText = new Map<string, string>();
    await yieldToEventLoop();
    const lessonFileIds = new Set<string>();
    for (const l of lessons) for (const id of parseTrigger(l.trigger_pattern).files) lessonFileIds.add(id);
    const lessonEntities = new Map(this.source.listFileEntities([...lessonFileIds]).map((e) => [e.id, e]));
    for (const l of lessons) {
      const tag = normalizeProjectTag(l.project);
      const entry = buildLessonEntry(l, tag, lessonEntities);
      if (entry) projectBucket(next, tag).lessons.push(entry);
    }

    let after = "";
    for (;;) {
      await yieldToEventLoop();
      const page = this.source.listBugEvents(after, BUG_PAGE);
      if (page.length === 0) break;
      after = page[page.length - 1].id;
      this.indexBugPage(next, page);
      for (const r of page) if (evidenceIds.has(r.id)) evidenceText.set(r.id, r.text);
      if (page.length < BUG_PAGE) break;
    }

    this.toolLessons = buildToolLessons(allLessons, evidenceText);
    this.index = next;
    this.builtAt = this.now();
  }

  private indexBugPage(next: Index, page: readonly PretoolBugRow[]): void {
    const real = page.filter((r) => isRealProjectKey(r.project));
    const ids = new Set<string>();
    for (const r of real) {
      for (const item of parseStringArray(r.entities_json)) {
        if (!item.startsWith(SIGNATURE_TAG_PREFIX)) ids.add(item);
      }
    }
    const ents = new Map(this.source.listFileEntities([...ids]).map((e) => [e.id, e]));
    for (const r of real) {
      const tag = normalizeProjectTag(r.project);
      for (const key of bugGroupKeys(r, ents, tag)) addBugToGroup(projectBucket(next, tag), key, r);
    }
  }

  /** Synchronous, in-memory. At most one item; null = say nothing. */
  match(req: PretoolRequest): PretoolItem | null {
    this.kickRefresh();
    if (!this.index) return null;
    const bucket = isRealProjectKey(req.project) ? this.index.get(normalizeProjectTag(req.project)) : undefined;

    if (bucket) {
      for (const lesson of this.lessonCandidates(bucket, req)) {
        const item = this.lessonItem(lesson, req);
        if (item) return item;
      }
    }
    // Tool-behaviour lessons speak in every project: how a tool fails is not project data.
    const tool = this.toolLessonItem(req);
    if (tool) return tool;
    if (!bucket) return null;
    const bug = this.bugItem(bucket, req);
    return bug && this.firstTime(req, bug.eventId ?? "") ? bug : null;
  }

  private lessonCandidates(bucket: ProjectIndex, req: PretoolRequest): LessonEntry[] {
    const cwdPosix = req.cwd ? posix.normalize(toPosixLower(req.cwd.replace(/\\/g, "/"))) : undefined;
    const reqAbs = targetFilePath(req.toolName, req.toolInput, req.cwd);
    const cmd = bashCommand(req.toolName, req.toolInput)?.replace(/\\/g, "/").toLowerCase();
    const err = req.phase === "failure" ? (req.errorText ?? "").toLowerCase() : "";
    const hits = bucket.lessons.filter((l) => {
      // 4.6: the file-targeted ("file-memory") path speaks only for ATTESTED gotchas.
      if (reqAbs && l.attested && l.files.some((f) => fileRefMatchesPath(f, reqAbs, cwdPosix))) return true;
      if (cmd && l.files.some((f) => commandMentionsFile(cmd, f))) return true;
      return err !== "" && l.errorSignatures.some((s) => errorMentionsSignature(err, s));
    });
    return hits.sort((a, b) => b.evidenceCount - a.evidenceCount || b.confidence - a.confidence);
  }

  private toolLessonItem(req: PretoolRequest): PretoolItem | null {
    if (this.toolLessons.length === 0) return null;
    const hit = matchToolLesson(this.toolLessons, {
      phase: req.phase,
      toolName: req.toolName,
      command: bashCommand(req.toolName, req.toolInput),
      errorText: req.errorText,
    });
    if (!hit || !this.firstTime(req, `tool:${hit.lesson.id}`)) return null;
    return { severity: "warn", kind: "lesson", lessonId: hit.lesson.id, text: renderToolLesson(hit.lesson, hit.why) };
  }

  private lessonItem(lesson: LessonEntry, req: PretoolRequest): PretoolItem | null {
    const deny = req.phase === "pre" && !!req.oneWay && lesson.attested && lesson.trusted;
    // A warning already shown for a lesson must not hide a later one-way action: severity is part of the key.
    if (!this.firstTime(req, `${deny ? "deny" : "warn"}:${lesson.id}`)) return null;
    const body = `lesson [${lesson.domain}, ${lesson.evidenceCount}× evidence]: ${clip(lesson.text)}`;
    if (deny) {
      return {
        severity: "deny",
        kind: "lesson",
        lessonId: lesson.id,
        text:
          `Memory stop: you have been burned here before and this is a one-way action (${req.oneWay}). ` +
          `${body} Confirm with the user this is intentional, then retry. ` +
          `If the user says the stop was right: tdai_stance_confirmed(lesson_id:"${lesson.id}"); ` +
          `if it was a false alarm: tdai_stance_rejected(lesson_id:"${lesson.id}").`,
      };
    }
    return { severity: "warn", kind: "lesson", lessonId: lesson.id, text: `Memory warning — ${body} (lesson id ${lesson.id})` };
  }

  private bugItem(bucket: ProjectIndex, req: PretoolRequest): PretoolItem | null {
    const keys: string[] = [];
    const cmd = bashCommand(req.toolName, req.toolInput);
    const head = cmd ? commandHeadOfRaw(cmd) : null;
    if (head) keys.push(`bash:${head}`);
    const abs = targetFilePath(req.toolName, req.toolInput, req.cwd);
    if (abs) {
      keys.push(`abs:${abs}`);
      const parts = abs.split("/").filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) keys.push(`rel:${parts.slice(i).join("/")}`);
    }
    let best: BugGroup | undefined;
    for (const k of keys) {
      const g = bucket.bugGroups.get(k);
      if (g && g.count >= 2 && (!best || g.count > best.count)) best = g;
    }
    if (!best) return null;
    return {
      severity: "warn",
      kind: "recurring-bug",
      eventId: best.lastEventId,
      text: `Memory warning — this ${abs ? "file" : "command"} already failed ${best.count}× in this project: ${clip(best.lastText)} (event ${best.lastEventId})`,
    };
  }

  /** True the first time `id` is shown to `req.sessionKey` in this phase; records it. */
  private firstTime(req: PretoolRequest, id: string): boolean {
    const tag = `${req.phase}:${id}`;
    let seen = this.shown.get(req.sessionKey);
    if (seen?.has(tag)) return false;
    if (!seen) {
      if (this.shown.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.shown.keys().next().value;
        if (oldest !== undefined) this.shown.delete(oldest);
      }
      seen = new Set();
      this.shown.set(req.sessionKey, seen);
    }
    seen.add(tag);
    return true;
  }
}
