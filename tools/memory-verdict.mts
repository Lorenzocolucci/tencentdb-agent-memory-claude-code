/**
 * "Quanto è stata utile la memoria?" — the answer, with the evidence attached.
 *
 * Reads the recall ledger (what was injected) and its settled verdicts (what
 * the agent's replies actually drew on) and prints a report in plain Italian.
 *
 * Read-only. Safe to run while the gateway is up.
 *
 * USAGE
 *   npx tsx tools/memory-verdict.mts                     # everything on record
 *   npx tsx tools/memory-verdict.mts --since 2026-08-23  # from a date
 *   npx tsx tools/memory-verdict.mts --project C:/Argus  # one project only
 */

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readVerdict } from "../src/core/kb/recall-ledger.js";
import { readInjectionStats, type InjectionStats } from "../src/core/kb/recall-stats.js";

const DB_PATH =
  process.env.TDAI_VERDICT_DB ??
  join(process.env.USERPROFILE ?? "", ".claude", "plugins", "data", "tdai-memory-tdai-local", "vectors.db");

/** Same key the plugin computes from a cwd (claude-code-plugin/lib/session-key.ts). */
function sessionKeyFor(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function bar(fraction: number, width = 24): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
}

function trim(text: string, max = 76): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** Phase 3.12 targets: ≤5 lines/turn, ≥50% silent turns, 0 cross-project lines, used rate per tier. */
function printInjectionStats(s: InjectionStats): void {
  const f1 = (n: number | null): string => (n === null ? "n/d" : n.toFixed(1));
  console.log("  ── Quanto spinge, e dove ──");
  console.log(`  righe di memoria per turno    : ${f1(s.linesPerTurn)}   (obiettivo ≤ 5)`);
  console.log(`  turni senza memoria (silenzio): ${f1(s.silentTurnsPct)}%   (obiettivo ≥ 50%)`);
  console.log(`    turni con iniezione ${s.turnsInjected}, turni silenziosi ${s.turnsSilent}`);
  console.log(`  righe di un ALTRO progetto    : ${s.crossProjectLines}   (obiettivo 0)`);
  for (const t of s.tiers) {
    const rate = t.usedRate === null ? "n/d" : `${(t.usedRate * 100).toFixed(1)}%`;
    const name = `${t.kind}${t.associative ? " associativo" : " da query"}`;
    console.log(`   ${name.padEnd(20)} iniettati ${String(t.injected).padStart(6)}  giudicabili ${String(t.judgeable).padStart(6)}  usati ${String(t.used).padStart(5)}  → ${rate}`);
  }
  console.log("");
}

function main(): void {
  const project = arg("project");
  const since = arg("since");
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  try {
    const v = readVerdict(db, {
      sessionKey: project ? sessionKeyFor(project) : undefined,
      sinceTs: since,
      limit: 5,
    });

    console.log("\n╔══ VERDETTO DI UTILITÀ DELLA MEMORIA ═══════════════════════════╗");
    if (project) console.log(`  progetto: ${project}`);
    if (since) console.log(`  da:       ${since}`);
    console.log("");

    printInjectionStats(
      readInjectionStats(db, { sessionKey: project ? sessionKeyFor(project) : undefined, sinceTs: since }),
    );

    const judgeable = v.judged - v.unjudgeable;
    if (judgeable === 0) {
      console.log("  Non c'è ancora abbastanza materiale per un verdetto onesto.");
      console.log(`  Iniettati e in attesa di giudizio: ${v.pending}`);
      console.log(`  Giudicati ma non giudicabili:      ${v.unjudgeable}`);
      console.log("\n  (un ricordo è 'non giudicabile' quando non aggiunge nulla che tu");
      console.log("   non abbia già scritto: nessuna risposta potrebbe dimostrarne l'uso)");
      console.log("╚════════════════════════════════════════════════════════════════╝\n");
      return;
    }

    const pct = (v.usefulness ?? 0) * 100;
    console.log(`  UTILI     ${bar(v.usefulness ?? 0)}  ${pct.toFixed(0)}%`);
    console.log("");
    console.log(`  ricordi iniettati e giudicati : ${v.judged}`);
    console.log(`    ├─ usati davvero            : ${v.used}`);
    console.log(`    ├─ rumore (mai usati)       : ${v.noise}`);
    console.log(`    └─ non giudicabili          : ${v.unjudgeable}`);
    console.log(`  ancora in attesa di giudizio  : ${v.pending}`);

    if (v.topUsed.length > 0) {
      console.log("\n  ── I ricordi che si guadagnano il posto ──");
      for (const r of v.topUsed) {
        console.log(`   ${String(r.uses).padStart(3)}/${String(r.injections).padEnd(3)} usi  ${trim(r.lastText)}`);
      }
    }
    if (v.topNoise.length > 0) {
      console.log("\n  ── Iniettati e mai serviti a niente ──");
      for (const r of v.topNoise) {
        console.log(`   ${String(r.injections).padStart(3)} volte    ${trim(r.lastText)}`);
      }
    }

    console.log("\n  Come si misura: un ricordo conta come USATO solo se nella risposta");
    console.log("  compaiono parole distintive che vengono dal RICORDO e NON dal tuo");
    console.log("  messaggio. Le parole che hanno deciso restano salvate, verificabili.");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");
  } finally {
    db.close();
  }
}

main();
