# Punto 5 — Sinapsys dentro Argus su Render (DESIGN)

> **Versione 2 — 2026-08-07.** Fonde e sostituisce `PUNTO5-SINAPSYS-ARGUS-RENDER-DESIGN.md`
> (21/07), di cui conserva le verifiche ancora valide e **corregge due premesse sbagliate**.
> Stato: **PROPOSTA — nulla toccato su Render.** Stato generale: [../STATO-REALE.md](../STATO-REALE.md).

---

## 0. ⚠️ Due correzioni alla versione precedente (verificate oggi)

| Affermazione vecchia | Realtà verificata 2026-08-07 |
|---|---|
| «Argus parla GIÀ a un gateway Sinapsys via `engine/lib/memory.mjs`» | **FALSO oggi.** Quel file **non esiste più**: cancellato nel commit `a98bf24` ("delete the retired fortress pipeline"). Non c'è alcun client Sinapsys in Argus. |
| «Argus è senza memoria» (mia, di stamattina) | **FALSO.** Argus ha una memoria permanente **già viva e profondamente integrata**. |

### Che memoria ha Argus, davvero
`C:\Argus\engine\lib\argus-memory.mjs` (308 righe) — **Supabase/PostgREST**, non SQLite:

- `argus_chat_memory` — una riga per turno, **append-only**;
- `argus_facts` — conoscenza curata (`fact` / `not_error` / `mistake` / `charter_rule`),
  deduplicata per `idempotency_key`, con **`evidence_count`** che si incrementa sui duplicati;
- fail-safe per costruzione: ogni funzione torna un oggetto neutro, **non lancia mai** nel loop.

**È usata da 10+ moduli**: `argus-guardian.mjs`, `guardian-brain.mjs`, `guardian-actions.mjs`,
`guardian-compose-brief.mjs`, `guardian-brief-memory.mjs` ("ciò che Lorenzo ha già detto che NON
è un errore non deve tornare domattina"), e perfino una consolidazione propria
(`consolidazione.mjs`, `consolidazione-distill.mjs`).

**Perché Supabase e non un disco:** perché risolve da solo il problema qui sotto (§1) —
un Postgres è condivisibile fra i tre servizi, un disco Render no. Non è stata una scorciatoia:
è stata la risposta giusta al vincolo.

---

## 1. Il vincolo Render che decide tutto (verificato su documentazione ufficiale)

- Un **disco persistente appartiene a UN SOLO servizio**, non condivisibile, niente multi-istanza
  (protezione anti-corruzione — combacia con SQLite single-writer).
- **I cron job non possono accedere ai dischi** (girano su compute separato).
- **Worker e cron NON ricevono traffico privato, ma POSSONO inviarlo.**
- Un servizio **privato** ha hostname interno `http://<nome>:<porta>`, stessa region+workspace,
  nessuna esposizione pubblica, traffico non fatturato.

Argus su Render (verificato via API, 2026-08-07) — **tre servizi, una immagine, nessun disco**:

| servizio | tipo | comando | piano |
|---|---|---|---|
| `argus-brain` (`srv-d9bqa8r7uimc73cgno7g`) | worker | CMD del Dockerfile | starter |
| `argus-maker` (`srv-d9d4qbt7vvec73esijhg`) | worker | `argus-guardian.mjs --maker` | standard |
| `argus-nightly` (`crn-d9bqa9bbc2fs73aqs44g`) | **cron** 05:00 | `argus-guardian.mjs --once` | starter |

⟹ **Mettere `vectors.db` su un disco di Argus è impossibile.**

---

## 2. Architettura: "Gateway-as-a-Service"

```
        RETE PRIVATA RENDER (stessa region + workspace, nessun URL pubblico)
  ┌───────────────┐   ┌───────────────┐   ┌────────────────┐
  │  argus-brain  │   │  argus-maker  │   │ argus-nightly  │
  └───────┬───────┘   └───────┬───────┘   └────────┬───────┘
          │   HTTP (Bearer token): /recall /observe /capture │
          └───────────────────┬─────────────────────────────┘
                              ▼
              ┌──────────────────────────────────┐
              │  sinapsys-memory (PRIVATE)       │  ← 1 sola istanza
              │  node dist/src/gateway/cli.mjs   │
              │  disco persistente /var/data     │  ← vectors.db (2,57 GB)
              └──────────────────────────────────┘
```

Il gateway **è già** questo server HTTP: non si riscrive nulla, gira lo stesso codice del portatile.

**Perché non riscrivere Sinapsys su Supabase/pgvector** (idea circolata a luglio): zero riscrittura
dello store, zero re-embed (i 2,57 GB sono già Qwen3/1024), zero ricompilazione di vec0, e
soprattutto **le 5 idee associative restano intatte** (spreading activation, priming: JS puro).
Portarle su Postgres async sarebbe settimane di lavoro col rischio di regredire proprio il
differenziatore. **Scartata con motivo.**

---

## 3. 🔑 La domanda vera (e non è tecnica)

Argus ha **già** una memoria che funziona. Sinapsys non va "aggiunta": va **collocata**.

| Opzione | Cosa significa | Rischio |
|---|---|---|
| **A. Sostituzione** | Sinapsys prende il posto di `argus-memory` | **Alto**: 10+ moduli cablati, incluso il filtro anti-falsi-allarmi del brief |
| **B. Affiancamento cieco** | Le due memorie convivono senza parlarsi | Due verità che divergono: il difetto peggiore per una memoria |
| **C. Due velocità (CLS)** ✅ | `argus-memory` resta la memoria **operativa veloce** (turni, fatti curati, correzioni di Lorenzo); Sinapsys diventa lo **strato profondo associativo** (recall per significato, Quaderno degli Errori cross-progetto, loop) | Contenuto: nessuna riscrittura, si accende a pezzi |

**Raccomandazione: C.** È letteralmente la nostra stella polare — *Complementary Learning Systems*:
ippocampo (veloce, episodico) + neocorteccia (lenta, semantica). Argus ha già l'ippocampo;
Sinapsys è la neocorteccia che gli manca. Non si butta niente e non si rompe niente.

---

## 4. Innesto nel codice di Argus

**Punto unico:** `askLLM` — `C:\Argus\engine\lib\llm.mjs:115`. È l'**unico** posto dove Argus
parla con l'LLM (lo chiamano guardian, maker-loop, alert-window, brain-resilience).

**Nuovo file** `engine/lib/sinapsys.mjs` (~150 righe, nome diverso da `argus-memory.mjs` per non
confonderli), modellato sul fail-safe già in uso in Argus:
- `recall(prompt)` → `POST /recall` → testo da anteporre al `system`;
- `observe(tool, isError, output)` → `POST /observe` — porta l'**officina** nel cloud: i
  fallimenti di Argus alimentano il Quaderno degli Errori e fanno scattare l'**interruzione dei loop**;
- `capture(prompt, answer)` → `POST /capture` fire-and-forget.

**Configurazione:** `SINAPSYS_URL` + `SINAPSYS_TOKEN` da env Render. Se mancano → **disabilitato**,
comportamento byte-identico a oggi. Flag `ARGUS_SINAPSYS=1`, default OFF.
**Regola invariabile:** la memoria non rompe MAI Argus (timeout corto, errori ingoiati, fail-open).

---

## 5. Migrazione dei 2,57 GB

I dischi Render **non sono accessibili in build/pre-deploy**: il DB non può stare nell'immagine
(e non deve — sarebbe un'immagine con dentro dati personali).

1. **Backup locale** + `PRAGMA integrity_check`. Il DB del portatile **non si tocca mai**.
2. `VACUUM` su una **copia** (i vec0 non rilasciano spazio morto — è già successo, vedi
   `tools/kb-defrag-vec.mts`): meno GB da spostare, disco più economico.
3. Servizio con disco **10 GB** su `/var/data`, deploy con DB vuoto.
4. **SSH nel servizio** → `rsync -P --append-verify` (resumibile sui GB). Copiare anche
   `kb-nav-index.v1.snapshot.json`.
5. Restart → `/health` verde → **smoke recall**: una query nota, confronto col portatile.

**Reversibile:** il DB locale resta intatto; per abortire si elimina il servizio.

---

## 6. Manifest env del servizio `sinapsys-memory`

| Env | Valore | Note |
|---|---|---|
| `TDAI_GATEWAY_HOST` | `0.0.0.0` | bind sulla rete privata |
| `TDAI_GATEWAY_ALLOW_REMOTE` | `1` | escape hatch necessaria (default è solo loopback) |
| `TDAI_GATEWAY_PORT` | porta assegnata da Render | |
| `TDAI_DATA_DIR` | `/var/data` | il disco |
| `TDAI_GATEWAY_TOKEN` | segreto | lo stesso che va in `SINAPSYS_TOKEN` su Argus |
| `DEEPINFRA_API_KEY` | segreto | embeddings Qwen3-4B/1024 |
| `TDAI_LLM_*` | segreti | estrazione (Moonshot) |

**Mai committati.** ⚠️ Nota Node 22: `node:sqlite` è built-in ma emette un warning
sperimentale — da verificare all'avvio sul `node:22-slim`.

---

## 7. Costi (verificati)

| voce | costo |
|---|---|
| servizio privato | da **$7/mese** (0.5 vCPU / 512 MB) |
| disco 10 GB | **$2,50/mese** ($0,25/GB) |
| traffico interno | non fatturato |

**~$10–20/mese.** Onestà: 512 MB potrebbero essere stretti (sqlite-vec scansiona in memoria);
si misura prima di consigliare una taglia superiore.

---

## 8. Fasi (ognuna verificabile e reversibile)

| # | Fase | Tocca cose vive? |
|---|---|---|
| 1 | Dockerfile del gateway + prova in container Linux locale | ❌ |
| 2 | Servizio privato + disco su Render, DB vuoto → `/health` | ✅ OK + costi |
| 3 | Migrazione DB via SSH (dopo VACUUM su copia) → conteggi identici | ✅ OK |
| 4 | `engine/lib/sinapsys.mjs` + innesto in `askLLM`, flag OFF, TDD | ❌ |
| 5 | Accensione su **`argus-nightly`** (il meno critico) e osservazione | ✅ OK |
| 6 | Estensione a brain + maker; poi si valuta il rapporto con `argus-memory` | ✅ OK |

**Gate fermi:** nessun servizio Render creato, nessun costo attivato, nessuna migrazione senza
OK esplicito di Lorenzo. Le fasi **1 e 4 non toccano nulla di vivo**.

---

## 9. Decisione aperta: una memoria o due? (portatile ↔ cloud)

Indipendente da §3 (che riguarda Argus). Qui si parla del **DB di Sinapsys**:

- **(A) Due DB** — portatile e cloud separati. Zero rischi sul lavoro quotidiano, ma divergono.
- **(B) Un DB solo nel cloud** — anche il portatile punta lì. È la stella polare ("una sola testa"),
  **ma ogni prompt dipende dalla rete** e il recall ha 6s di budget: un rallentamento lo azzera.

**Raccomandazione: (A) ora, (B) dopo aver MISURATO la latenza reale** verso Frankfurt.
Partire da (B) significherebbe scommettere il lavoro quotidiano su un numero non ancora misurato.
