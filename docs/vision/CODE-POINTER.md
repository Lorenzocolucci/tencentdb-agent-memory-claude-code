# 📍 Dove vive il CODICE

> Aggiornato **2026-08-07** (verificato, non a memoria). Stato del progetto: [STATO-REALE.md](STATO-REALE.md).

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
| Facciata host-neutrale (recall/capture/observe) | `src/core/tdai-core.ts` |
| Gateway HTTP | `src/gateway/server.ts` |
| Hook Claude Code | `claude-code-plugin/lib/hook.ts` |

## Gateway (memoria live)
- **Ascolto:** `127.0.0.1:8421`; token in `<dataDir>/token`.
- **Dati:** `C:\Users\lo\.claude\plugins\data\tdai-memory-tdai-local\` (`vectors.db`, 2,57 GB).
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
- **Sorgente:** `claude-code-plugin/` → build con `npm run build:cc-plugin`.
- **Installato (eseguito da CC):** `C:\Users\lo\.claude\plugins\tdai-mkt\plugin\`
  (`dist/lib/hook.mjs` + `hooks/hooks.json`).
- ⚠️ **Modificare la sorgente non basta:** il file installato va aggiornato, altrimenti il fix non arriva.

## Strumenti operativi
| Strumento | A cosa serve |
|---|---|
| `dist/src/cli/reindex-standalone.mjs --resume --force` | Ricalcola i vettori mancanti (additivo, sicuro col gateway acceso) |
| `tools/ab-consolidation.mts` | A/B del filo consolidamento→recall sulla memoria vera (sola lettura) |
| `tools/backfill-friction.mts` | Recupera i fallimenti dalle sessioni passate (dry-run di default, idempotente) |
| `tools/repair-backfill-fts.mts` | Ripara `kb_fts` mancante dopo un `insertEvent` diretto |
| `dist/src/cli/reconcile-apply-standalone.mjs` | Riconciliazione entità (dry-run di default) |
| `benchmark/longmemeval/` | Harness multi-arm + giudice ufficiale |
