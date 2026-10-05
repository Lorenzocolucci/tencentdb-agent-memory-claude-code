/**
 * Re-distill the Mistake Notebook lessons that are about the agent's TOOL USE, with the
 * tool-aware distill prompt (lessons-distiller.ts, 05/10/2026).
 *
 * Why: lessons are distilled once per cluster and never revisited. Measured live 05/10:
 * the top tool lessons named the wrong cause — "implement signal trapping" for Bash
 * commands killed by the tool timeout (exit 143, 57 recurrences), "ask the user" for a
 * Render error that states its own resolution (list_workspaces). The agent reads exactly
 * these texts after the error.
 *
 * DRY by default: prints old → new, writes nothing. --commit inserts the new version
 * (same trigger, evidence, project) and marks the old one superseded — nothing is
 * deleted. The ids are saved to --backup so the change can be reverted by id.
 *
 *   npx tsx tools/redistill-tool-lessons.mts [--limit N] [--commit --backup FILE]
 *
 * Reads TDAI_LLM_* from the environment like tools/lessons-run.mts; never prints the key.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { distillLesson } from "../src/core/kb/lessons-distiller.js";
import { insertLesson, supersedeLesson } from "../src/core/kb/lessons-writer.js";
import { learnToolLesson } from "../src/core/kb/tool-lessons.js";
import { StandaloneLLMRunnerFactory } from "../src/adapters/standalone/llm-runner.js";

const DB = path.join(os.homedir(), ".claude", "plugins", "data", "tdai-memory-tdai-local", "vectors.db");
const MAX_EVIDENCE_IN_PROMPT = 12;

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const limit = Number(args[args.indexOf("--limit") + 1]) || 15;
const backup = args.includes("--backup") ? args[args.indexOf("--backup") + 1] : undefined;
if (commit && !backup) {
  process.stderr.write("STOP: --commit needs --backup FILE (rollback by id).\n");
  process.exit(1);
}
const apiKey = process.env.TDAI_LLM_API_KEY ?? "";
if (!apiKey) {
  process.stderr.write("STOP: TDAI_LLM_API_KEY is not set.\n");
  process.exit(1);
}

const quiet = { debug() {}, info() {}, warn: (m: string) => process.stderr.write(`${m}\n`), error: (m: string) => process.stderr.write(`${m}\n`) };
const runner = new StandaloneLLMRunnerFactory({
  config: {
    baseUrl: process.env.TDAI_LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey,
    model: process.env.TDAI_LLM_MODEL ?? "gpt-4o",
    maxTokens: Number(process.env.TDAI_LLM_MAX_TOKENS ?? 16000),
    temperature: Number(process.env.TDAI_LLM_TEMPERATURE ?? 1),
    timeoutMs: Number(process.env.TDAI_LLM_TIMEOUT_MS ?? 120_000),
  },
  logger: quiet,
}).createRunner({ enableTools: false });

interface Row {
  id: string; namespace: string; project: string; domain: string; trigger_pattern: string;
  lesson_text: string; evidence_event_ids_json: string; evidence_count: number; confidence: number;
}

const db = new DatabaseSync(DB, { readOnly: !commit });
db.prepare("PRAGMA busy_timeout = 8000").run();
const heads = db
  .prepare(`SELECT id, namespace, project, domain, trigger_pattern, lesson_text, evidence_event_ids_json, evidence_count, confidence
              FROM lessons WHERE superseded_by IS NULL ORDER BY evidence_count DESC`)
  .all() as unknown as Row[];
const evText = db.prepare("SELECT text FROM events WHERE id = ?");

const changes: Array<{ oldId: string; newId: string }> = [];
let done = 0;
for (const l of heads) {
  if (done >= limit) break;
  const ids = JSON.parse(l.evidence_event_ids_json || "[]") as string[];
  const texts = ids.map((id) => (evText.get(id) as { text: string } | undefined)?.text).filter((t): t is string => !!t);
  if (!learnToolLesson({ id: l.id, domain: l.domain, text: l.lesson_text, evidenceCount: l.evidence_count }, texts)) continue;
  done++;
  const distilled = await distillLesson(
    { project: l.project, bugTexts: texts.slice(0, MAX_EVIDENCE_IN_PROMPT), fixTexts: [] },
    runner,
  );
  process.stdout.write(`\n[${l.evidence_count}x ${l.domain}] ${l.id}\n  OLD: ${l.lesson_text.replace(/\s+/g, " ")}\n`);
  if (!distilled) {
    process.stdout.write("  NEW: (distillation failed — kept as is)\n");
    continue;
  }
  process.stdout.write(`  NEW: ${distilled.lessonText.replace(/\s+/g, " ")}\n`);
  if (!commit) continue;
  const now = new Date().toISOString();
  const inserted = insertLesson(db, {
    namespace: l.namespace,
    project: l.project,
    domain: distilled.domain,
    triggerPattern: l.trigger_pattern,
    lessonText: distilled.lessonText,
    antiPatterns: distilled.antiPatterns,
    evidenceEventIds: ids,
    confidence: distilled.confidence,
    version: 2,
    provenance: { sessionKeys: [], source: "redistill-tool-lessons-2026-10-05" },
    now,
  });
  supersedeLesson(db, l.id, inserted.id, now);
  changes.push({ oldId: l.id, newId: inserted.id });
  fs.writeFileSync(backup!, JSON.stringify(changes, null, 2));
}
process.stdout.write(`\n${commit ? `COMMITTED ${changes.length}` : "DRY RUN — nothing written"} (tool lessons seen: ${done})\n`);
db.close();
