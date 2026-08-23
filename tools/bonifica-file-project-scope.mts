/**
 * Bonifica della contaminazione fra progetti sulle entità di tipo `file`.
 *
 * IL GUASTO (misurato). Le entità `file` create prima dello scoping avevano
 * `canonical_key` costruita sul solo nome base (`file:readme.md`) e `project`
 * vuoto: una chiave GLOBALE. La memoria di un progetto colava dentro un altro.
 * Il caso capostipite: i fatti "argus canary" del 13–14/07/2026, iniettati da
 * allora ogni volta che una sessione apriva un QUALUNQUE README.md.
 *
 * Due interventi, entrambi NON distruttivi:
 *
 *   1. RITIRO dei fatti di collaudo (canary). Non sono conoscenza: sono il
 *      residuo di una prova. Usano la via pulita già esistente — `superseded_by`
 *      + `superseded_at` + `valid_to` — quindi escono dall'insieme HEAD
 *      (queryHeadFacts, retrieval) senza che una riga venga cancellata.
 *
 *   2. ATTRIBUZIONE del progetto alle entità file che ne hanno UNO SOLO
 *      dimostrabile dai propri eventi. Restituisce la voce a ricordi veri che
 *      altrimenti — giustamente — resterebbero muti, perché il percorso di
 *      lettura ora rifiuta ciò che non sa attribuire.
 *      Le entità toccate da eventi di PIÙ progetti sono lasciate mute: sono le
 *      contaminate, e indovinare sarebbe peggio del silenzio.
 *
 * Le entità NON vengono ri-chiavate: cambiare `canonical_key` cambierebbe l'id
 * deterministico e staccherebbe fatti, eventi e vettori già scritti. La chiave
 * legacy resta, ma il guardiano di lettura (situation-injection) la mostra solo
 * dentro il suo progetto.
 *
 * USO
 *   npx tsx tools/bonifica-file-project-scope.mts                # prova a vuoto
 *   npx tsx tools/bonifica-file-project-scope.mts --apply        # scrive
 *   npx tsx tools/bonifica-file-project-scope.mts --apply --backup-dir <dir>
 *
 * Scrive SEMPRE il backup delle righe toccate (JSON) prima di qualunque
 * scrittura: il DB è 2,8 GB, copiarlo intero non è praticabile.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DB_PATH =
  process.env.TDAI_DB_PATH ??
  join(
    process.env.USERPROFILE ?? "",
    ".claude", "plugins", "data", "tdai-memory-tdai-local", "vectors.db",
  );

const DEFAULT_BACKUP_DIR = "C:/RISTRUTTURAZIONE/90-prove";

/** Marcatore di ritiro: non è l'id di un fatto più nuovo, è il motivo del ritiro. */
const RETIRED_BY = "retired:canary-collaudo-argus-2026-07";

/**
 * I fatti di collaudo da ritirare: attributi scritti dalla prova canary di
 * luglio su un'entità file. Il valore DEVE nominare il canary — così un fatto
 * legittimo che per caso si chiama "contents" non viene toccato.
 */
const CANARY_ATTRS = new Set([
  "canary_line",
  "canary_line_present",
  "canary_pipeline_status",
  "content_updated",
  "contents",
  "modified",
]);
const CANARY_MARK = /argus\s*(canary|maker probe)|canary\s*:/i;

interface Args { apply: boolean; backupDir: string }

function parseArgs(argv: string[]): Args {
  const i = argv.indexOf("--backup-dir");
  return {
    apply: argv.includes("--apply"),
    backupDir: i >= 0 && argv[i + 1] ? argv[i + 1] : DEFAULT_BACKUP_DIR,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = new DatabaseSync(DB_PATH, { readOnly: !args.apply });
  const now = new Date().toISOString();
  const run = (sql: string): void => { db.prepare(sql).run(); };

  // ── 1. Fatti canary su entità file globali ──
  const canaryFacts = (
    db
      .prepare(
        `SELECT f.id, f.entity_id, f.attribute, f.value, f.valid_to, f.superseded_by,
                f.superseded_at, f.source_event_id, e.canonical_key, e.project,
                ev.text AS source_event_text
           FROM facts f
           JOIN entities e ON e.id = f.entity_id
           LEFT JOIN events ev ON ev.id = f.source_event_id
          WHERE e.type = 'file' AND f.superseded_by IS NULL AND f.valid_to IS NULL`,
      )
      .all() as Array<Record<string, unknown>>
  ).filter(
    // Attributo plausibile + prova che il canary lo ha generato: nel valore,
    // nel nome dell'attributo, o nel testo dell'evento che lo ha scritto
    // ("modified: true" da solo non direbbe nulla).
    (r) =>
      CANARY_ATTRS.has(String(r.attribute)) &&
      (CANARY_MARK.test(String(r.value)) ||
        String(r.attribute).startsWith("canary_") ||
        CANARY_MARK.test(String(r.source_event_text ?? ""))),
  );

  // ── 2. Entità file senza progetto, ma con UN SOLO progetto negli eventi ──
  const orphanFiles = db
    .prepare(
      `SELECT id, canonical_key FROM entities
        WHERE type = 'file' AND (project IS NULL OR project = '')`,
    )
    .all() as Array<{ id: string; canonical_key: string }>;
  const orphanKeyById = new Map(orphanFiles.map((e) => [e.id, e.canonical_key]));

  const seen = new Map<string, Set<string>>();
  for (const ev of db
    .prepare("SELECT project, entities_json FROM events WHERE project <> '' AND entities_json <> '[]'")
    .all() as Array<{ project: string; entities_json: string }>) {
    let ids: string[] = [];
    try { ids = JSON.parse(ev.entities_json); } catch { continue; }
    for (const id of ids) {
      if (!orphanKeyById.has(id)) continue;
      if (!seen.has(id)) seen.set(id, new Set());
      seen.get(id)!.add(ev.project);
    }
  }

  const attributable: Array<{ id: string; key: string; project: string }> = [];
  let ambiguous = 0;
  for (const [id, projects] of seen) {
    if (projects.size !== 1) { ambiguous++; continue; }
    attributable.push({ id, key: orphanKeyById.get(id)!, project: [...projects][0] });
  }

  console.log(`DB: ${DB_PATH}`);
  console.log(`Fatti canary ancora in HEAD (da ritirare): ${canaryFacts.length}`);
  console.log(`Entità file senza progetto: ${orphanFiles.length}`);
  console.log(`  attribuibili a un solo progetto: ${attributable.length}`);
  console.log(`  toccate da più progetti (lasciate mute): ${ambiguous}`);
  console.log(`  senza alcuna prova di progetto: ${orphanFiles.length - seen.size}`);

  if (!args.apply) {
    console.log("\nProva a vuoto — nessuna scrittura. Aggiungi --apply per eseguire.");
    db.close();
    return;
  }

  // ── Backup PRIMA di scrivere ──
  mkdirSync(args.backupDir, { recursive: true });
  const stamp = now.replace(/[:.]/g, "-");
  const backupPath = join(args.backupDir, `bonifica-file-project-scope-${stamp}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify(
      {
        db: DB_PATH,
        at: now,
        retired_by: RETIRED_BY,
        facts_before: canaryFacts,
        entities_before: attributable.map((a) => ({ ...a, project_before: "" })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nBackup delle righe toccate: ${backupPath}`);

  const retire = db.prepare(
    "UPDATE facts SET superseded_by = ?, superseded_at = ?, valid_to = ? WHERE id = ?",
  );
  const attribute = db.prepare("UPDATE entities SET project = ?, updated_time = ? WHERE id = ?");
  run("BEGIN");
  try {
    for (const f of canaryFacts) retire.run(RETIRED_BY, now, now, String(f.id));
    for (const a of attributable) attribute.run(a.project, now, a.id);
    run("COMMIT");
  } catch (err) {
    run("ROLLBACK");
    throw err;
  }
  console.log(`Ritirati ${canaryFacts.length} fatti · attribuite ${attributable.length} entità.`);
  db.close();
}

main();
