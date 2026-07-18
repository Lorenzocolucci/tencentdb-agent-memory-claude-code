# 🗺️ Mappa delle Interconnessioni (viva — aggiornare ad ogni cambio strutturale)
> Ultimo aggiornamento: 24 giugno 2026. Regola: questo file si aggiorna PRIMA di considerare completo un cambio di struttura.

> **⚠️ NOTA 2026-07-18 (unificazione D-A3):** questa mappa è fotografata al commit `0f9f913` (24/06) — **116 commit indietro** rispetto a HEAD (`8556c31`, branch `feat/sinapsys-l4-consolidation`). Le sezioni A-D sotto restano valide come STRUTTURA, ma NON coprono tutto ciò che è stato costruito dopo. Verificato oggi: **le 5 idee originali (Parte 3 del blueprint) sono TUTTE implementate**, più Grounded Trust (Idea 6) e un L4 v1 contradiction-detector. Moduli mancanti da questa mappa (elenco da verdicts-sinapsys, 2026-07-18):
> - `src/core/kb/navigable-index.ts` — indice HNSW in-house (Incremento C del recall redesign, root `HANDOFF.md` del repo).
> - `src/core/kb/contradiction-detector.ts` — L4 v1, 3° passo del Consolidation Engine (commit `44a1625`).
> - `src/core/kb/{provenance,stakes,grounded-trust-ask}.ts` — Grounded Trust (Idea 6), 4 fasi.
> - `src/core/kb/{implicit-priming,spreading-activation}.ts` — Implicit Priming (Idea 2) + il cuore associativo, via co-occorrenza (non solo `relations` esplicite).
> - `src/core/distinctiveness/*` — Distinctive Terms (Idea 5), cornerstone.
> - `src/core/kb/{principle-*,usage-*}.ts` — Pilastro C (distillazione principi) + Behavioral Notebook (tendenze d'uso).
> - `src/core/continuity/*` — "Dove eravamo" (session-continuity recap).
> - `src/core/kb/situation-cue.ts` + wiring in `auto-recall.ts` — recall associativo-first (situazione semina lo spreading activation).
>
> Stato dettagliato per-modulo: `docs/SINAPSYS-ARCHITECTURE.md` (nel repo). Il corpo sotto (sezioni A-D) resta valido come mappa storica della struttura fino al 24/06.

## A — Documenti dell'hub (come si legano)
```
README → CODE-POINTER → (repo git)
       → 00-charter/COME-LAVORIAMO-SOCIO       (come lavoriamo)
       → 01-vision-and-plan/SINAPSYS-PLAN ──── basato su ── MEMORIA-BLUEPRINT
       → 02-architecture/FOUNDATIONS-POINTER ── punta a ── repo/docs/SINAPSYS_FOUNDATIONS
       → 03-research/round1 + round2 ───────── alimentano ── SINAPSYS-PLAN (PARTE 7-9)
       → 04-decisions/ADR-0001, ADR-0002      (vincoli a verbale)
```

## B — Codice: moduli esistenti (KB) e loro flusso
```
Stop hook → /capture → kb-extractor (LLM→KbDelta) → kb-writer.applyKbDelta
                                                       ├─ entities  (resolveOrCreateEntity)
                                                       ├─ events    (insertEvent, APPEND-ONLY)
                                                       ├─ facts     (kb-queries supersession, HEAD fact)
                                                       └─ relations (idempotent edge)
                                                          → embed → kb_vec / kb_fts
UserPromptSubmit hook → /recall → kbRecall (FTS + vec + entity → RRF → calibrate)
SessionStart → projections (persona.md + scene_blocks, deterministico, anti-segreti)
```

## C — Fondamenta nuove → quali moduli le useranno (da costruire)
| Fondamenta (tabella) | Modulo che la scrive | Modulo che la legge |
|---|---|---|
| `memory_lifecycle` | Fase A (L4 consolidation runner) | kbRecall (reweight), proiezioni |
| `lessons` | Fase B (distillatore in A) | Fase C (injection), kbRecall |
| `memory_audit` | A + kb-writer (supersession) | debug / UI futura |
| `context_fingerprints` | Fase C (hook PostToolUse + matcher) | Fase C (injection) |
| `relations.weight` | A (rinforzo) | Fase D (spreading activation) |

## C.1 — Fondamenta: IMPLEMENTATE (24 giugno 2026)
- **`repo/src/core/kb/foundations-schema.ts`** → `initFoundationsSchema(db, logger)` crea i 5 mattoni (additivo, best-effort, mai throw). Una funzione pubblica, ~190 righe.
- **Chiamato da** `repo/src/core/store/sqlite.ts` → `initKbSchema()` (1 riga, dopo le `relations`, prima di `kbReady=true`).
- **Test:** `repo/src/core/kb/__tests__/foundations-schema.test.ts` (6 test verdi: tabelle create, weight additivo, idempotenza, righe preservate, PK composta, best-effort senza relations). Suite KB: 80/80 verde. Typecheck pulito.
- **Stato runtime:** applicato al DB live al prossimo build+restart del gateway (additivo, sicuro). NON ancora deployato.

## C.2 — Fase A parte 1: lifecycle access layer (IMPLEMENTATO, commit bc0fb5e)
- **`repo/src/core/kb/memory-audit.ts`** → `recordAudit(db, entry, now)` (append-only su memory_audit).
- **`repo/src/core/kb/lifecycle-writer.ts`** → `ensureLifecycle` / `getLifecycle` / `reinforce` / `computePermanence`. `reinforce` applica la promozione a 2 condizioni (short→long) e scrive audit.
- **Test:** `__tests__/lifecycle-writer.test.ts` (5 test). Suite KB 85/85 verde, typecheck pulito.
## C.3 — Fase A parte 2: consolidamento deterministico (IMPLEMENTATO, commit f6dede2)
- **`repo/src/core/kb/lifecycle-decay.ts`** → `decay` + `applyStaleness` (i ricordi non rinforzati sbiadiscono long→short→dormant; mai cancellati).
- **`repo/src/core/kb/consolidation-runner.ts`** → `runConsolidation(db, {sessionKey, now})`: rinforza eventi+fatti della sessione, poi decade gli stantii. Deterministico, no LLM.
- **Test:** `__tests__/consolidation-runner.test.ts` (2). Suite KB 87/87 verde, typecheck pulito.

## C.4 — Fase A parte 3: aggancio live + deploy (IMPLEMENTATO+DEPLOYATO, commit 93abfad)
- **`repo/src/core/kb/consolidation-scheduler.ts`** → `scheduleConsolidation({store, sessionKey, now, register, unregister, logger})`: fire-and-forget via `setImmediate` (la risposta `/session/end` esce prima della sweep sincrona); traccia il task in `bgTasks` così `destroy()` lo drena prima di chiudere il DB; ingoia+logga gli errori; no-op se lo store non può consolidare (TCVDB/degraded).
- **`repo/src/core/store/sqlite.ts`** → `VectorStore.consolidateSession(params)` wrappa `runConsolidation(this.db, …)`; no-op se `!kbReady`. Firma opzionale su `IMemoryStore` (`store/types.ts`).
- **`repo/src/core/tdai-core.ts`** → `handleSessionEnd` flusha la sessione (se c'è scheduler) poi chiama `scheduleConsolidation`. Unico punto d'aggancio (copre gateway).
- **Test:** `kb/__tests__/consolidation-scheduler.test.ts`, `store/__tests__/consolidate-session.test.ts`, `__tests__/consolidation-wiring.test.ts` (drain-before-close provato). Suite motore 162/162. **Live:** gateway PID 6232, verificato end-to-end (265 memorie rinforzate su sessione reale).
- **Deferred (con trigger):** vedi scheda `sinapsys-phase-a-deferred` (coalesce decay sweep; namespace propagation — oggi prematuro, DB tutto `default`).

## C.5 — Fase B: Mistake Notebook (IN RIDISEGNO — non ancora mappato)
- ⚠️ Primo tentativo (clustering `bug→fix` per vicinanza temporale intra-sessione) **SCARTATO**: produce aneddoti, non lezioni. Il blueprint vuole clustering **per dominio, cross-sessione, con evidence_count**, trigger = Context Fingerprint, injection-ready. Mattoni riusabili: `lessons-writer.ts` (lezioni versionate, supersede), `lessons-distiller.ts` (LLM→struttura). Da rifare: `lessons-candidates.ts`. Vedi scheda `sinapsys-phase-b-direction`.

## C.6 — Track A: Proactive Injection — slice 1 (LIVE+VERIFICATO, commit 413ddbb)
- **Scoperta:** nel path gateway, `performAutoRecall` calcola DUE parti — `appendSystemContext` (stabile: persona/scene/guide) e `prependContext` (i `<relevant-memories>` mirati al prompt) — ma `handleRecall` rispediva **solo** la parte stabile. I ricordi rilevanti venivano buttati al confine HTTP → proactive injection di fatto SPENTA (solo profilo+lista scene).
- **`repo/src/gateway/recall-context.ts`** → `composeRecallContext({appendSystemContext, prependContext})`: unisce le due parti (stabile prima, ricordi dopo). **`server.ts` handleRecall** ora la usa.
- **Test:** `gateway/__tests__/recall-context.test.ts` (4, incl. il caso "solo memorie"). Suite motore 186/186.
- **Verifica live:** gateway PID 23744; `POST /recall "circuit breaker errorFilter Sofia"` → `memory_count=5`, blocco `<relevant-memories>` (relevance 0.54–0.63). Prima: scartato.
### Track A slice 2 — iniezione dei principi vincolanti (LIVE+VERIFICATO, commit 4d6f273)
- **`repo/src/core/hooks/principles.ts`** → `loadPrinciples(dataDir)` (legge `<dataDir>/principles.md`, curato/fidato) + `formatPrinciplesBlock` (blocco `<governing-principles>` con cornice BINDING — opposto al "solo riferimento" dei fatti). **`auto-recall.ts`** lo carica e lo mette PRIMO in `stableParts` (prima di persona/scene).
- **Dato vivo:** `<dataDir>/principles.md` (NON nel repo — è runtime, come il DB): non-negoziabili universali + ambition bar Sinapsys del focus attuale. Sorgente di verità della visione = blueprint + schede `sinapsys-*`; questo file è il riassunto iniettato.
- **Test:** `hooks/__tests__/principles.test.ts` (4). Suite 190/190. **Verifica live:** `/recall` → `<governing-principles>` in posizione 0 (prima di persona@2168, memorie@6111).
### Track A slice 3+4 — Proactive Injection per SITUAZIONE (LIVE motore, commit 0f9f913)
- **`repo/src/core/hooks/situation.ts`** → `extractSituation` (file in gioco da un evento PostToolUse; normalizza a posix con `split/join`, NON regex — il bundler mangiava la regex backslash).
- **`repo/src/core/hooks/situation-injection.ts`** → `buildFileInjection`: risolve l'entità file (chiave full-path → fallback basename; la KB salva i file in entrambi i modi) e rende fatti+eventi come blocco `<file-memory>`, oppure `null` (SILENZIO) se file ignoto/nulla di rilevante.
- **`tdai-core.ts`** → `handleToolObservation` (extract → dedup una-volta-per-file-per-sessione → buildFileInjection; mai throw). **`gateway/server.ts`** → `POST /observe`. **Plugin:** `handlePostToolUse` → `/observe` → `additionalContext`; `gateway-client.observe`; `hooks.json` registra PostToolUse (matcher Read|Edit|Write|MultiEdit|NotebookEdit, NON async così può iniettare).
- **Test:** `hooks/__tests__/situation*.test.ts` (9). Suite 199/199. **Verifica live (motore):** `/observe` con path Windows reale (JSON valido) → blocco `<file-memory>` 449 char per whatsapp-sofia.ts; file ignoto/tool non-file/secondo tocco → silenzio.
- ⚠️ **Il hook PostToolUse si attiva alla PROSSIMA sessione Claude Code** (carica il nuovo hooks.json). La verifica "apri un file → arriva la memoria" la fa Lorenzo in una chat nuova.
- ⚠️ **Trappola di test (lezione):** payload JSON con backslash costruiti nella shell collassano `\\`→`\` → JSON invalido → falso "rotto". Costruisci i path con `String.fromCharCode(92)` + `JSON.stringify`. Il vero hook usa JSON.stringify → sempre valido.
- **Restano:** principi PER-PROGETTO (oggi principles.md è globale); accumulo `context_fingerprints` (Idea 1, cross-sessione) — la tabella è ancora vuota. Vedi `sinapsys-dual-track-direction`.

## D — Regole di dipendenza (per restare manutenibili)
- `events` = APPEND-ONLY. Nessun modulo lo muta. Il "vivo" sta in `memory_lifecycle`.
- `facts` = NO DELETE. Solo supersession.
- Ogni nuovo modulo: una funzione per file, ~200 righe max.
- Ogni auto-modifica passa da `memory_audit` (tracciabilità obbligatoria).
