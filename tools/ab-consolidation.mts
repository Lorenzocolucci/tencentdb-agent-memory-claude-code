/**
 * A/B of the consolidation → recall wire on the REAL memory (READ-ONLY).
 *
 * Runs the same realistic queries through kbRecall twice — boost OFF vs ON — on
 * the live vectors.db opened read-only, and reports where the top-K changed and
 * WHAT rose. LongMemEval cannot measure this (every question seeds a virgin
 * memory, so nothing is ever reinforced); only a long-lived memory can.
 *
 * Usage: node --import tsx tools/ab-consolidation.mts
 */
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { VectorStore } from "../src/core/store/sqlite.js";
import { OpenAIEmbeddingService } from "../src/core/store/embedding.js";
import { kbRecall } from "../src/core/kb/retrieval.js";

const require = createRequire(import.meta.url);
void require;
void DatabaseSync;

const DB_DIR = "C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local";
const EMB = {
  provider: "deepinfra",
  baseUrl: "https://api.deepinfra.com/v1/openai",
  model: "Qwen/Qwen3-Embedding-4B",
  dimensions: 1024,
};

const QUERIES = [
  "Sofia si autoavvia da sola?",
  "qual è il costo mensile del piano",
  "su quale branch stiamo lavorando",
  "quale modello LLM usiamo come backup",
  "problema del circuit breaker in Sofia",
  "come mandiamo i messaggi Telegram allo staff",
  "il database di produzione si può scrivere?",
  "che embedder usiamo per la memoria",
  "problemi di encoding e accenti nel codice",
  "come si riavvia il gateway della memoria",
  "cosa fa Argus quando trova un problema",
  "regole su push e merge su main",
  "dashboard di Sofia cosa mostra",
  "errore nei grafici della dashboard",
  "quali test falliscono di continuo",
  "decisione sul piano GLM",
  "cosa abbiamo deciso sul benchmark LongMemEval",
  "come funziona la riconciliazione delle entità",
  "problema di deploy su Render",
  "quali lezioni abbiamo imparato dagli errori",
];

const logger = {
  debug: () => {},
  info: () => {},
  warn: (m: string) => { if (!/non-fatal/.test(m)) console.error("[wrn]", m); },
  error: (m: string) => console.error("[err]", m),
};

function key(): string {
  const k = process.env.DEEPINFRA_API_KEY ?? "";
  if (!k) throw new Error("DEEPINFRA_API_KEY non impostata");
  return k;
}

async function main(): Promise<void> {
  const store = new VectorStore(`${DB_DIR}/vectors.db`, EMB.dimensions, logger);
  store.init({ provider: EMB.provider, model: EMB.model });
  const emb = new OpenAIEmbeddingService(
    { ...EMB, apiKey: key(), timeoutMs: 60_000 },
    logger,
  );

  let changed = 0;
  let top1Changed = 0;
  const risers: string[] = [];

  for (const q of QUERIES) {
    const off = await kbRecall(q, { store, embeddingService: emb, maxResults: 8, logger });
    const on = await kbRecall(q, {
      store, embeddingService: emb, maxResults: 8, consolidationBoost: true, logger,
    });
    const idsOff = off.map((r) => r.owner_id);
    const idsOn = on.map((r) => r.owner_id);
    const sameOrder = idsOff.join("|") === idsOn.join("|");
    if (!sameOrder) changed++;
    if (idsOff[0] !== idsOn[0]) top1Changed++;

    console.log(`\n— "${q}"`);
    if (sameOrder) {
      console.log("   nessun cambiamento");
    } else {
      // What moved UP the most?
      for (const r of on) {
        const before = idsOff.indexOf(r.owner_id);
        const after = idsOn.indexOf(r.owner_id);
        if (before === -1 || after < before) {
          const label = before === -1 ? "NUOVO in top-8" : `${before + 1}° → ${after + 1}°`;
          console.log(`   ↑ ${label}: ${r.text.replace(/\s+/g, " ").slice(0, 95)}`);
          if (risers.length < 40) risers.push(r.text.replace(/\s+/g, " ").slice(0, 80));
        }
      }
    }
  }

  console.log(`\n================ RIEPILOGO A/B ================`);
  console.log(`domande testate            : ${QUERIES.length}`);
  console.log(`con top-8 cambiata         : ${changed}`);
  console.log(`con il 1° risultato cambiato: ${top1Changed}`);
  store.close();
}

main().catch((e) => { console.error("A/B FALLITA:", e); process.exit(1); });
