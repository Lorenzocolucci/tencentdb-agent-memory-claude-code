# 📍 Dove vive il CODICE

Il codice di Sinapsys NON è in questo hub. Si costruisce **sopra TencentDB Agent Memory** (decisione [ADR-0001](04-decisions/ADR-0001-build-on-tencentdb.md)).

## Repo
- **Path:** `C:\Users\lo\tencentdb-agent-memory`
- **Branch di lavoro:** `feat/sinapsys-l4-consolidation` — **mai push su main** (corretto 2026-07-18: era `feat/memory-excellence`, stantio; verificare comunque il branch corrente con `git branch --show-current` prima di assumere, i branch cambiano)
- **Doc tecnici (fonte di verità):** `C:\Users\lo\tencentdb-agent-memory\docs\`
  - `SINAPSYS_FOUNDATIONS.md` — il blueprint delle fondamenta (i mattoni, oggi 8)
  - `SINAPSYS-ARCHITECTURE.md` — mappa architettura corrente (source-grounded, generata dal codice reale)
  - `ENTITY_CORE_BLUEPRINT.md` — design storico del KB (ARCHIVIATO 2026-07-18, tutto implementato — vedi `docs/archive/SINAPSYS-STORICO-DOCS-20260718.md`)

## File chiave del codice esistente
| Area | File |
|---|---|
| Schema DB | `src/core/store/sqlite.ts` |
| Estrazione KB (LLM→KbDelta) | `src/core/kb/kb-extractor.ts`, `src/core/prompts/kb-extraction.ts` |
| Scrittura deterministica | `src/core/kb/kb-writer.ts`, `src/core/kb/kb-queries.ts` |
| Recall ibrido (FTS+vec+entity→RRF) | `src/core/kb/retrieval.ts` |
| Proiezioni persona/scene | `src/core/kb/projections.ts` |
| Gateway HTTP | `src/gateway/server.ts` |
| Hook (SessionStart/UserPromptSubmit/Stop/PostToolUse) | `claude-code-plugin/lib/hook.ts` |

## Gateway (memoria live)
- In ascolto su `127.0.0.1:8421`, token in `<dataDir>/token`.
- Dati: `C:\Users\lo\.claude\plugins\data\tdai-memory-tdai-local\` (vectors.db).
- Riavvio: `C:\Users\lo\tdai-gateway\start-gateway.ps1`.
- ⚠️ Se non riparte: `netsh interface portproxy show all` (regola fantasma su 8421).
