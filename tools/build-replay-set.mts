/**
 * Build the fixed prompt set that tools/recall-replay.mts replays.
 *
 * Reads real USER prompts from Claude Code transcripts
 * (`~/.claude/projects/<project>/<session>.jsonl`), drops machine-generated ones
 * (task notifications, cross-session messages, slash-command wrappers, system
 * reminders, interrupts), scrubs secrets, and writes a JSON file that stays OUTSIDE
 * the repo — the prompts are private conversation text and this repo is public.
 *
 * Output shape:
 *   { generatedAt, projects: { "<name>": { cwd, prompts: string[] } } }
 *
 * USAGE
 *   node --max-old-space-size=1024 --import tsx tools/build-replay-set.mts \
 *        --out C:/Users/lo/tdai-perf-copy/replay-set.json [--min 10] [--max 14] [--projects 6]
 *
 * Never prints prompt text — only counts per project.
 */

import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../src/utils/redact-secrets.js";

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const ROOT = path.join(HOME, ".claude", "projects");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const MACHINE_PREFIXES = [
  "<task-notification>",
  "another claude session sent a message",
  "<command-",
  "<local-command",
  "<system-reminder>",
  "caveat:",
  "[request interrupted",
  "this session is being continued",
  "base directory for this skill",
];

/** True when a user "prompt" was produced by the harness, not typed by the user. */
export function isMachinePrompt(text: string): boolean {
  const head = text.trimStart().toLowerCase();
  if (MACHINE_PREFIXES.some((p) => head.startsWith(p))) return true;
  if (head.startsWith("<") && /^<[a-z-]+[ >]/.test(head)) return true;
  return false;
}

interface TranscriptLine {
  type?: string;
  cwd?: string;
  isSidechain?: boolean;
  entrypoint?: string;
  message?: { role?: string; content?: unknown };
}

function readUserPrompts(file: string): { cwd?: string; prompts: string[] } {
  const prompts: string[] = [];
  let cwd: string | undefined;
  const raw = fs.readFileSync(file, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    let rec: TranscriptLine;
    try {
      rec = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (rec.type !== "user" || rec.isSidechain) continue;
    if (rec.entrypoint?.startsWith("sdk")) continue; // `claude -p` children are not a person typing
    if (rec.cwd && !cwd) cwd = rec.cwd;
    const content = rec.message?.content;
    if (typeof content !== "string") continue; // tool results are arrays
    const text = content.trim();
    if (text.length < 8 || text.length > 1500) continue;
    if (isMachinePrompt(text)) continue;
    prompts.push(redactSecrets(text));
  }
  return { cwd, prompts };
}

function main(): void {
  const out = arg("out");
  if (!out) throw new Error("--out <file> is required");
  const min = Number(arg("min", "10"));
  const max = Number(arg("max", "14"));
  const maxProjects = Number(arg("projects", "6"));

  const result: Record<string, { cwd: string; prompts: string[] }> = {};
  for (const dir of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, dir);
    let files: Array<{ f: string; m: number }>;
    try {
      files = fs
        .readdirSync(full)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ f: path.join(full, f), m: fs.statSync(path.join(full, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)
        .slice(0, 25);
    } catch {
      continue;
    }
    const seen = new Set<string>();
    const collected: string[] = [];
    let cwd: string | undefined;
    for (const { f } of files) {
      if (fs.statSync(f).size > 60 * 1024 * 1024) continue; // keep memory bounded
      const r = readUserPrompts(f);
      cwd = cwd ?? r.cwd;
      for (const p of r.prompts) {
        if (seen.has(p)) continue;
        seen.add(p);
        collected.push(p);
      }
      if (collected.length >= max * 3) break;
    }
    if (!cwd || collected.length < min) continue;
    // Spread across the collected prompts so the sample is not one burst.
    const step = Math.max(1, Math.floor(collected.length / max));
    const picked = collected.filter((_, i) => i % step === 0).slice(0, max);
    if (/worktrees|[\\/]agent-[0-9a-f]{8,}/i.test(cwd)) continue; // throwaway agent worktrees
    const name = path.basename(path.resolve(cwd));
    if (result[name] && result[name]!.prompts.length >= picked.length) continue;
    result[name] = { cwd, prompts: picked };
  }

  const ranked = Object.entries(result)
    .sort((a, b) => b[1].prompts.length - a[1].prompts.length)
    .slice(0, maxProjects);
  fs.writeFileSync(
    out,
    JSON.stringify({ generatedAt: new Date().toISOString(), projects: Object.fromEntries(ranked) }, null, 1),
  );
  for (const [name, v] of ranked) console.log(`${name}: ${v.prompts.length} prompts`);
}

main();
