# 📍 Dove vive il CODICE

> Aggiornato **2026-08-23** (verificato, non a memoria). Stato del progetto: [STATO-REALE.md](STATO-REALE.md).

Il codice di Sinapsys si costruisce **sopra TencentDB Agent Memory** (decisione [ADR-0001](04-decisions/ADR-0001-build-on-tencentdb.md)).

## Repo
- **Path:** `C:\Users\lo\tencentdb-agent-memory`
- **Branch corrente:** **`main`** (locale). Remoto consentito: `fork`. **MAI push su `tencent`** (upstream open-source).
  *(Verificare comunque con `git branch --show-current`: i branch cambiano.)*
- **Doc tecnici (fonte di verità, accanto al codice):** `docs/`
  - [`SINAPSYS-ARCHITECTURE.md`](../SINAPSYS-ARCHITECTURE.md) — architettura corrente, source-grounded
  - [`SINAPSYS_FOUNDATIONS.md`](../SINAPSYS_FOUNDATIONS.md) — i mattoni del DB
  - `ENTITY_CORE_BLUEPRINT.md` — ARCHIVIATO (vedi [storico](../archive/SINAPSYS-STORICO-DOCS-20260718.md))

## File chiave
| Area | File |
|---|---|
| Schema DB + tutte le query | `src/core/store/sqlite.ts` |
| Embedding (provider remoto, resilienza) | `src/core/store/embedding.ts` |
| Estrazione KB (LLM→KbDelta) | `src/core/kb/kb-extractor.ts`, `src/core/prompts/kb-extraction.ts` |
| Scrittura deterministica | `src/core/kb/kb-writer.ts`, `src/core/kb/kb-queries.ts` |
| **Recall associativo** (FTS+vec+entità→RRF→priming) | `src/core/kb/retrieval.ts` |
| Consolidamento (rinforzo/decadimento/contraddizioni) | `src/core/kb/{consolidation-runner,lifecycle-*}.ts` |
| **Quaderno Errori** (cluster→lezioni) | `src/core/kb/{bug-clusters,bug-cluster-graph,lessons-*}.ts` |
| **Officina** (fallimenti tecnici → ricordi, loop) | `src/core/kb/friction-capture.ts` |
| **Verdetto di utilità** (usato vs solo recuperato) | `src/core/kb/{recall-usage,recall-ledger}.ts` |
| Limite al confronto a coppie degli errori | `src/core/kb/bug-working-set.ts` |
| **Allarmi "mai in silenzio"** (7 trappole) | `claude-code-plugin/lib/{alarm,staleness}.ts` |
| Trovare la cartella dati (indipendente dal layout) | `claude-code-plugin/lib/data-dir.ts` |
| Facciata host-neutrale (recall/capture/observe) | `src/core/tdai-core.ts` |
| Gateway HTTP | `src/gateway/server.ts` |
| Hook Claude Code | `claude-code-plugin/lib/hook.ts` |

## Gateway (memoria live)
- **Ascolto:** `127.0.0.1:8421`; token in `<dataDir>/token`.
- **Dati:** `C:\Users\lo\.claude\plugins\data\tdai-memory-tdai-local\` (`vectors.db`, 2,80 GB).
- **⚠️ CONFIG ATTIVA:** `C:\Users\lo\.memory-tencentdb\memory-tdai\tdai-gateway.yaml`
  — **NON** in `C:\Users\lo\tdai-gateway\`. Ordine di risoluzione (`src/gateway/config.ts`):
  `TDAI_GATEWAY_CONFIG` → CWD del processo → data-dir di default. *Errore facile da fare.*
- **Segreti:** `C:\Users\lo\tdai-gateway\gateway.secrets.env` (`OPENAI_API_KEY`, `DEEPINFRA_API_KEY`). **Mai committare.**
- **Riavvio:** `C:\Users\lo\tdai-gateway\start-gateway.ps1` (stop: `stop-gateway.ps1`).
  ⚠️ Il pidfile può disallinearsi: se lo stop dice "already stopped" ma il gateway risponde,
  trovare il PID vero dalla command line e terminarlo.
- **Il gateway gira dal `dist/`**: dopo una modifica al codice serve `npm run build` **e** riavvio,
  altrimenti la modifica NON è viva.
- ⚠️ Se non riparte: `netsh interface portproxy show all` (regola fantasma su 8421).

## Plugin Claude Code (quello che gira davvero)
- **Sorgente:** `claude-code-plugin/`.
- **Installato (eseguito da CC):**
  `C:\Users\lo\.claude\plugins\cache\tdai-local\tdai-memory\0.1.0\`
  (`dist/lib/hook.mjs` + `hooks/hooks.json`).
  ⚠️ **Questo percorso è CAMBIATO** (prima: `plugins\tdai-mkt\plugin\`). Claude Code ha aggiunto
  `cache/` e la cartella di versione. È il cambiamento che il 2026-08-13 ha ucciso la cattura per
  10 giorni, perché il plugin trovava la propria cartella dati **contando i salti**.
  **Non contare mai i salti in un percorso:** `data-dir.ts` risale finché trova.
- ✅ **Un solo comando:** `npm run install:cc-plugin` — costruisce **e** installa, scoprendo la
  cartella invece di assumerla. Il passo manuale che si poteva dimenticare non esiste più: per due
  settimane il plugin installato è rimasto indietro di una build proprio così.
- Dopo l'installazione **riapri Claude Code**: gli agganci si caricano all'avvio.

## Strumenti operativi
| Strumento | A cosa serve |
|---|---|
| `dist/src/cli/reindex-standalone.mjs --resume --force` | Ricalcola i vettori mancanti (additivo, sicuro col gateway acceso) |
| `tools/ab-consolidation.mts` | A/B del filo consolidamento→recall sulla memoria vera (sola lettura) |
| `tools/backfill-friction.mts` | Recupera i fallimenti dalle sessioni passate (dry-run di default, idempotente) |
| `tools/repair-backfill-fts.mts` | Ripara `kb_fts` mancante dopo un `insertEvent` diretto |
| `dist/src/cli/reconcile-apply-standalone.mjs` | Riconciliazione entità (dry-run di default) |
| `tools/recover-sessions.mts` | Recupera sessioni mai arrivate in memoria (dry-run, riprendibile, doppia guardia anti-doppione) |
| `tools/dedupe-l0.mts` | Rimuove righe L0 duplicate (esporta prima, esige il gateway fermo) |
| **`tools/memory-verdict.mts`** | **Quanto è stata utile la memoria**: iniettati / usati / rumore, con le parole che l'hanno deciso |
| `benchmark/longmemeval/` | Harness multi-arm + giudice ufficiale |

## Trappole che ci sono già costate tempo
- **`VectorStore` va inizializzato con `init()`** dopo il costruttore, altrimenti ogni `deleteL0`
  fallisce restituendo `false` **in silenzio** (nessuna eccezione).
- **Gli avvisi del gateway finiscono in `gateway.err.log`**, non in `gateway.out.log`.
- **I file `.ps1` restano ASCII.** PowerShell 5.1 legge uno script senza BOM come ANSI: un `—`
  UTF-8 diventa `â€”`, e `”` **apre una stringa** → lo script non compila più.
- **`Parser::ParseFile` con `[ref]$null` NON lancia**: serve un vero `[ref]$errs` da leggere,
  altrimenti si "verifica" la sintassi di uno script rotto.
- **Un `state.json` vuoto** fa perdere al plugin la cartella viva e può fargli scegliere un
  **archivio** `*.BACKUP-*`. Ordine corretto: PID vivo → NON-archivio → recenza.
- **In Python, `C:\Users` contiene `\U`**: negli script di supporto usare stringhe grezze.
