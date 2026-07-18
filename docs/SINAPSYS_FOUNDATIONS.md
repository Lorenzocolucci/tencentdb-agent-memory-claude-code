# 🏛️ SINAPSYS — Foundations Blueprint (le fondamenta che reggono tutto l'edificio)
> v1 — 24 giugno 2026 — Lorenzo + Socio. Schema validato e COSTRUITO.
> **STATO 2026-06-24 sera:** fondamenta LIVE · Fase A live · Fase B **B1 (`a3c81c4`) + B2a (`2a4cc5c`) costruite e live**. Dettaglio moduli/stato: `docs/superpowers/specs/2026-06-24-track-b-mistake-notebook-design.md` + `docs/HANDOFF-2026-06-24-trackB.md`.
> Principio: ogni fase futura (A→E) e ogni angolo vendibile si aggancia a queste fondamenta SENZA demolire. Tutto additivo (`IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`), stile `initKbSchema()` esistente. Il KB live non si rompe mai.

---

## 0 — Cosa esiste GIÀ (non si rifà)
| Tabella | Ruolo | Invariante da rispettare |
|---|---|---|
| `entities` | una riga per cosa reale (person/project/file/decision/bug/preference/concept) | dedup per canonical_key |
| `facts` | (entity, attribute, value) bi-temporale, HEAD fact, `support`, `confidence`, `source_event_id` | **NO DELETE** — supersession (audit trail già nativo) |
| `events` | episodi append-only, `type` (decision/bug/fix/config_change/observation/preference_stated/task/result) | **APPEND-ONLY** — mai mutare |
| `relations` | archi tipizzati (related-to/uses/caused/fixed-by/depends-on/decided-in), `support`, UNIQUE | idempotenti |
| `kb_vec` / `kb_fts` | recall ibrido vec0 + FTS5(BM25, jieba) | chunked, delete-then-insert |
| recall | `kbRecall`: FTS + vector + entity-match → RRF → score calibrato; rerank = stub no-op | mai throw, fail-open |
| proiezioni P5 | persona.md + scene_blocks deterministici dal KB (no LLM), filtro anti-segreti | gated `cfg.extraction.kbProjections` |
| hook | SessionStart, UserPromptSubmit(recall), Stop(capture). **PostToolUse = NO-OP già predisposto** | fail-silent |
| pipeline | scheduler fire-and-forget + checkpoint; runner L2/L3 esistono | — |

**Conseguenza chiave:** `events` è append-only e `facts` non si cancella mai. Quindi i dati "vivi" che cambiano (permanenza, decadimento, tier) NON possono stare lì dentro: vanno in uno strato separato. È la scelta strutturale n.1.

---

## 1 — Le fondamenta NUOVE (5 mattoni)

### Mattone 1 — `memory_lifecycle` (lo strato che rende viva la memoria)
Un layer sopra ogni unità di memoria (fact/event/lesson), così `events` resta append-only puro e il consolidamento aggiorna solo QUI.
```sql
CREATE TABLE IF NOT EXISTS memory_lifecycle (
  owner_id TEXT NOT NULL,            -- fact_/evt_/lesson_ id
  owner_kind TEXT NOT NULL,          -- 'fact' | 'event' | 'lesson'
  permanence_score REAL NOT NULL DEFAULT 0,   -- ripetizione + salienza + connessione (neuro round 1)
  salience REAL NOT NULL DEFAULT 0,           -- importanza dell'episodio (boost dei vicini correlati)
  reinforcement_count INTEGER NOT NULL DEFAULT 0,  -- "replay cumulativo": quante volte rivisto
  last_reinforced_at TEXT,
  tier TEXT NOT NULL DEFAULT 'short',         -- 'working' | 'short' | 'long' (promozione a 2 condizioni)
  state TEXT NOT NULL DEFAULT 'active',       -- 'active' | 'dormant' | 'archived'  (eviction/caching)
  retention_class TEXT NOT NULL DEFAULT 'default', -- 'permanent' | 'transient' | 'default' (archivistica: per categoria)
  function_importance REAL NOT NULL DEFAULT 0.5,   -- importanza della FUNZIONE che l'ha creato (archivistica)
  provenance_json TEXT NOT NULL DEFAULT '{}', -- {tool, agent, file, decision, session} = fonte autorevole (OPI)
  decay_at TEXT,                              -- quando scenderà di tier se non rinforzato
  namespace TEXT NOT NULL DEFAULT 'default',
  created_time TEXT NOT NULL, updated_time TEXT NOT NULL,
  PRIMARY KEY (owner_id, owner_kind)
);
```
→ Regge: permanenza/decadimento (Fase A), promozione a 2 condizioni + tier (neuro), retention per funzione+categoria + provenienza (archivistica = angolo vendibile #2), eviction (caching).

### Mattone 2 — `lessons` (il Quaderno degli Errori, L3 / Fase B)
```sql
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,                -- 'lesson_'+ulid
  namespace TEXT NOT NULL DEFAULT 'default', project TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL,               -- area (es. 'gateway', 'sqlite', 'deploy')
  trigger_pattern TEXT NOT NULL,      -- quando si applica (lega al context fingerprint)
  lesson_text TEXT NOT NULL,          -- la strategia distillata (ReasoningBank: da successi E fallimenti)
  anti_patterns_json TEXT NOT NULL DEFAULT '[]',
  evidence_event_ids_json TEXT NOT NULL DEFAULT '[]', -- i bug/fix da cui nasce
  evidence_count INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.5,
  version INTEGER NOT NULL DEFAULT 1, -- "accept-if-improves": nuova versione supersede
  superseded_by TEXT, superseded_at TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_time TEXT NOT NULL, updated_time TEXT NOT NULL
);
```
→ Regge: Fase B (materia prima = events type bug/fix), supersession delle lezioni (accept-if-improves), separazione procedurale-vs-dichiarativa (bussola di design).

### Mattone 3 — `memory_audit` (l'auto-evoluzione SENZA corruzione = angolo vendibile #1)
Ogni modifica automatica (consolidamento/evoluzione/promozione/decadimento) lascia traccia. È ciò che A-MEM NON ha e MemOS sì.
```sql
CREATE TABLE IF NOT EXISTS memory_audit (
  id TEXT PRIMARY KEY,                -- 'aud_'+ulid (time-sortable)
  ts TEXT NOT NULL,
  owner_id TEXT NOT NULL, owner_kind TEXT NOT NULL,
  operation TEXT NOT NULL,            -- 'supersede'|'reinforce'|'decay'|'promote'|'demote'|'evolve'|'merge'|'lesson_distilled'
  actor TEXT NOT NULL,                -- 'extraction'|'consolidation'|'user'
  before_json TEXT, after_json TEXT,  -- diff verificabile
  reason TEXT,
  namespace TEXT NOT NULL DEFAULT 'default'
);                                    -- APPEND-ONLY
```
→ Regge: angolo vendibile #1 (evoluzione + audit trail), debug della memoria, reversibilità.

### Mattone 4 — `context_fingerprints` (l'iniezione proattiva = angolo vendibile #3, Fase C)
```sql
CREATE TABLE IF NOT EXISTS context_fingerprints (
  id TEXT PRIMARY KEY,                -- 'fp_'+ulid
  session_key TEXT NOT NULL, ts TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',         -- file aperti/toccati
  error_signatures_json TEXT NOT NULL DEFAULT '[]',
  task_type TEXT NOT NULL DEFAULT '',            -- bugfix/feature/refactor/...
  tool_sequence_json TEXT NOT NULL DEFAULT '[]',
  matched_owner_ids_json TEXT NOT NULL DEFAULT '[]', -- cosa è stato iniettato (per misurare l'efficacia)
  namespace TEXT NOT NULL DEFAULT 'default'
);
```
→ Regge: Fase C (illness-script matching: file+errori+task → iniezione su fit forte, fallback a ricerca su contesto ambiguo).

### Mattone 5 — `relations.weight` (per lo spreading activation, Fase D)
```sql
ALTER TABLE relations ADD COLUMN weight REAL NOT NULL DEFAULT 1.0;
```
→ Regge: Fase D (constrained spreading activation: propaga lungo gli archi pesati, con limiti hop/fan-out/soglia). NB: si attiva solo dopo che la Fase A densifica il grafo (oggi 0.28 rel/entità).

> NOTA (2026-07-18): il codice ha già superato questo documento — `foundations-schema.ts` include anche Mattone 6 (`lessons` reinforcement: exposure/avoidance) e Mattone 7 (stance track record) mai registrati qui. Aggiungo solo il mattone della mia consegna (L4 v1); un aggiornamento completo del documento è fuori dal perimetro di questo task.

### Mattone 8 — `memory_lifecycle.contradiction_json` (contradiction check, L4 v1 Consolidation Engine)
```sql
ALTER TABLE memory_lifecycle ADD COLUMN contradiction_json TEXT;
```
→ Regge: il terzo passo del Consolidation Engine (Fase A) — `contradiction-detector.ts`. Due fatti ATTIVI (HEAD) sulla stessa (entity_id, attribute) con valori diversi non dovrebbero mai coesistere sotto scrittura normale (la supersession bi-temporale di `upsertFact` li collassa già in un unico HEAD): questo è un **safety net** per qualunque percorso che aggiri quell'invariante (migrazione, insert manuale, race). Flag/clear, MAI cancellazione del fatto. Ogni cambio di stato specchiato in `memory_audit` (`contradiction_flagged` / `contradiction_resolved`). Idempotente (firma del conflitto confrontata prima di riscrivere). Bounded: `MAX_ACTIVE_FACTS_SCANNED = 10_000` per passata, `scanCapped` esposto nelle stats.

---

## 2 — Matrice "ogni piano usa quale fondamenta" (prova che non si demolisce)
| Fase / Angolo | Fondamenta usate | Codice nuovo (cemento) |
|---|---|---|
| **A** Consolidation Engine | memory_lifecycle (permanence/reinforce/decay/tier), memory_audit | L4 runner fire-and-forget |
| **B** Mistake Notebook | lessons, memory_audit, events(bug/fix) | distillatore lezioni dentro A |
| **C** Proactive Injection | context_fingerprints, lessons, memory_lifecycle | hook PostToolUse (già predisposto) + matcher |
| **D** Implicit Priming | relations.weight, memory_lifecycle | CSA in kbRecall |
| **E** Embeddings locali | embedding_meta (già pronto, traccia provider/dim, re-index path esiste) | adapter ONNX |
| **Vendibile #1** evoluzione sicura | memory_audit + facts(supersession) | — già coperto |
| **Vendibile #2** retention per funzione | memory_lifecycle(retention_class/function_importance/provenance) | scorer in A |
| **Vendibile #3** iniezione proattiva | context_fingerprints | matcher in C |

**Nessuna fase richiede di alterare le tabelle esistenti** (solo 1 ADD COLUMN su relations). Tutto il resto sono tabelle nuove additive. Le fondamenta prevedono già tutti i piani.

---

## 3 — Ordine di costruzione (dopo l'OK)
1. **Schema delle fondamenta** (i 5 mattoni) — additivo, con test che il KB live apre invariato.
2. **Fase A** (Consolidation Engine) che POPOLA memory_lifecycle + scrive memory_audit.
3. **Fase B** (Mistake Notebook) dentro A.
4. **Eval set** costruito dai dati KB reali (recall/canary) per "accept-if-improves".
5. Poi C, poi D, poi E (come da piano).

> Regola: questo documento è la fondazione condivisa. Si tocca il codice SOLO dopo l'OK di Lorenzo su questo schema.
