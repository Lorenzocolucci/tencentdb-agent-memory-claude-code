# 🗺️ Mappa delle Interconnessioni

> **Aggiornata 2026-08-23** — riscritta sui flussi REALI. Regola: questo file si aggiorna PRIMA di considerare completo
> un cambio di struttura.
>
> Stato/numeri: [../STATO-REALE.md](../STATO-REALE.md) · Moduli: [../../SINAPSYS-ARCHITECTURE.md](../../SINAPSYS-ARCHITECTURE.md)

---

## A — Documenti: come si legano

```
STATO-REALE  ◄── punto d'ingresso, l'unico che si aggiorna ogni sessione
   ├─► README ──────────────► CODE-POINTER ──► (repo git, gateway, strumenti)
   ├─► 00-charter/COME-LAVORIAMO-SOCIO            (il patto di lavoro)
   ├─► 01-vision-and-plan/MEMORIA-BLUEPRINT       (LA VISIONE: 5 idee + Grounded Trust)
   │        └─ SINAPSYS-PLAN  (piano storico per fasi)
   │        └─ PIANO-FILO-CONSOLIDAMENTO-RECALL   (aperto → misurato → acceso)
   │        └─ PUNTO5-SINAPSYS-IN-ARGUS-RENDER    ◄── IL PROSSIMO PASSO
   ├─► 02-architecture/INTERCONNECTION-MAP (questo) + FOUNDATIONS-POINTER
   ├─► 03-research/round1+round2                  (alimentano il blueprint)
   └─► 04-decisions/ADR-0001, ADR-0002            (vincoli a verbale)
```

---

## B — Il flusso VIVO, oggi (Claude Code sul portatile)

```
 ┌─ ogni tuo messaggio ────────────────────────────────────────────────┐
 │ UserPromptSubmit hook → POST /recall                                │
 │   → performAutoRecall → kbRecall  (FTS + vettori + entità → RRF     │
 │       → recency/importanza (+ CONSOLIDAMENTO, acceso 2026-08-07)    │
 │       → Implicit Priming (spreading activation) → top-K calibrato)  │
 │   → composeRecallContext: principi + persona + scene + ricordi      │
 │   → hook estrae il banner "🧠" e lo emette come systemMessage       │
 │     (VISIBILE all'utente; prima era solo un'istruzione al modello)  │
 └─────────────────────────────────────────────────────────────────────┘

 ┌─ mentre l'agente lavora (PostToolUse: Bash|Read|Edit|Write|…) ──────┐
 │ POST /observe → handleToolObservation                               │
 │   ├─ se il tool è FALLITO → friction-capture (OFFICINA)             │
 │   │     ├─ firma normalizzata (numeri/hash/path collassati)         │
 │   │     ├─ 1ª volta → evento `bug`                                  │
 │   │     ├─ 3ª volta uguale → LOOP: evento + ⚠️ avviso iniettato     │
 │   │     └─ segreti redatti PRIMA di salvare; cap 40/sessione        │
 │   ├─ iniezione per FILE (una volta per file per sessione)           │
 │   └─ iniezione per SITUAZIONE (Context Fingerprint)                 │
 │   → l'avviso di LOOP va SEMPRE per PRIMO (rompe il loop adesso)     │
 └─────────────────────────────────────────────────────────────────────┘

 ┌─ a fine turno ──────────────────────────────────────────────────────┐
 │ Stop hook → POST /capture → L0 (conversazioni grezze)               │
 │   → estrazione L1 (LLM → KbDelta) → applyKbDelta:                   │
 │        entities · events(APPEND-ONLY) · facts(supersession) ·        │
 │        relations → embed → kb_vec + kb_fts                          │
 └─────────────────────────────────────────────────────────────────────┘

 ┌─ in sottofondo (sleep-time) ────────────────────────────────────────┐
 │ scheduleConsolidation → runConsolidation                            │
 │     rinforza ciò che ricorre · fa sbiadire lo stantio · contraddiz. │
 │            └──► memory_lifecycle ──► LETTO dal recall (§B, acceso)  │
 │ distillLessons: bug → cluster (≥2 bug, ≥2 sessioni) → LEZIONI       │
 │     (fix 2026-08-07: i cluster già distillati non consumano più     │
 │      il budget → le lezioni sono passate da 6 a 68)                 │
 │     ⚠️ i tre passi di distillazione CEDONO il ciclo eventi prima di │
 │        partire e girano al massimo 1 volta ogni 30 min: prima       │
 │        bloccavano il primo turno per 11,5 s (budget hook: 6 s)      │
 └─────────────────────────────────────────────────────────────────────┘
```

### Il verdetto di utilità (2026-08-23) — l'unico anello che misura

```
 recall  ──► scrive nel recall_ledger CIÒ CHE HA DAVVERO INIETTATO
             (una riga per ricordo, NON giudicata)
 capture ──► giudica: il ricordo è USATO solo se nella risposta compaiono
             parole distintive che vengono dal RICORDO e NON dal prompt
             (senza quella sottrazione si misura un'eco)
             └─► salva le parole che hanno deciso → verificabile
 report  ──► npx tsx tools/memory-verdict.mts        (10% al 2026-08-23)

 ⚠️ ASIMMETRIA DA CONOSCERE: `reinforceRecalledOwners` rinforza ciò che il
    recall PESCA. Quindi un ricordo iniettato e ignorato diventa più forte.
    Il verdetto esiste per correggerlo, ma l'anello di ritorno
    (usato → rinforza / rumore → decade) NON è ancora collegato: prima
    si misura su traffico vero, poi si agisce.
```

### Le 7 trappole "mai in silenzio" (2026-08-22/23)

```
 data-dir-lost · gateway-unreachable · capture-failed · capture-empty
 memory-stale  · memory-degraded     · writing-to-backup
        │
        └─► briciola in alarms.json ─► il primo UserPromptSubmit la mostra
            come systemMessage (l'unico canale che CC rende all'utente)
            UN ALLARME BATTE SEMPRE IL BANNER: la falsa rassicurazione è
            ciò che ha nascosto 10 giorni di cattura morta.

 Rete INDIPENDENTE dal plugin (se il plugin è rotto non può lamentarsi):
 ~/.claude/scripts/hooks/session-start-tdai-health.js confronta
 /health.last_capture_at con l'ultima sessione realmente avvenuta.
```

---

## C — Chi scrive e chi legge le fondamenta

| Tabella | Chi la SCRIVE | Chi la LEGGE | Stato |
|---|---|---|---|
| `l0_conversations` | auto-capture | recall di riserva, digest | vivo |
| `entities` / `facts` / `events` / `relations` | `kb-writer.applyKbDelta`, `recordFriction` | `kbRecall`, proiezioni, cluster | vivo |
| `kb_vec` / `kb_fts` | embed step di kb-writer, `reindexKb` | `kbRecall` (vettori + BM25) | vivo |
| `memory_lifecycle` | `runConsolidation`, `reinforceRecalledOwners` | **`kbRecall` (dal 2026-08-07)** | **filo attaccato** |
| `lessons` | `distillLessons` | injection, `kbRecall` | vivo (68) |
| **`recall_ledger`** | `kbRecall` (scrive non giudicato) | `judgePendingRecalls` alla cattura, `memory-verdict` | **vivo (2026-08-23)** |
| `memory_audit` | consolidamento + supersession | debug | vivo |
| `context_fingerprints` | hook PostToolUse | `fingerprint-injection` | vivo |

---

## D — Le due catene di apprendimento (Complementary Learning Systems)

```
 VELOCE (Track A)                          LENTA (Track B)
 ───────────────                           ───────────────
 cattura → estrazione → recall             fallimenti → cluster per dominio
 valore SUBITO, ogni turno                  → lezione generalizzata
 + interruzione dei LOOP (subito)           accumulo lento, MAI aneddoti
                                            (serve ricorrenza in ≥2 sessioni)
```

**Perché due:** un loop va rotto **adesso** (Track A); un pattern che torna nelle settimane
diventa una **lezione** (Track B). Confonderli produce o rumore o cecità.
Il fix del 2026-08-07 nasce esattamente da lì: il clustering richiede ≥2 sessioni, quindi
5 errori uguali **in una sola sessione** non producevano nulla → ora li intercetta Track A.

---

## E — Dove si innesta Argus (prossimo passo)

```
  argus-brain   ┐
  argus-maker   ├─► http://sinapsys-memory:8421  ─► [disco] vectors.db
  argus-nightly ┘   (servizio privato Render)
     (worker/cron: possono INVIARE, non ricevere → forma compatibile)

  punto d'innesto unico in Argus: askLLM — C:\Argus\engine\lib\llm.mjs:115
```

Vincolo verificato: un disco Render appartiene a **un solo servizio** e i **cron non possono
usarlo**. Argus è tre servizi → il disco NON può stare su Argus.
Dettagli, costi e fasi: [../01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md](../01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md)

---

## F — Regole di dipendenza (per restare manutenibili)

- `events` = **APPEND-ONLY**. Nessun modulo lo muta. Il "vivo" sta in `memory_lifecycle`.
- `facts` = **NO DELETE**. Solo supersession (HEAD + storia).
- La memoria **non rompe mai** la conversazione: fail-open ovunque, errori ingoiati e loggati.
- Ogni nuovo modulo: una funzione per file, ~200 righe max.
- Ogni auto-modifica passa da `memory_audit` (tracciabilità obbligatoria).
- ⚠️ **`insertEvent` NON crea `kb_fts`/`kb_vec`**: chi scrive eventi fuori da `kb-writer` deve
  aggiungerli, altrimenti il ricordo è invisibile a ricerca e clustering (lezione del backfill).
