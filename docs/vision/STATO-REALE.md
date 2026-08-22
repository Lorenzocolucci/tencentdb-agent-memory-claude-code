# 🧭 SINAPSYS — STATO REALE

> **Aggiornato: 2026-08-22.** Ogni numero qui è stato **misurato**, non ricordato.
> **Questo è il documento da leggere PER PRIMO.** Tutti gli altri partono da qui.
>
> Regola di questo file: se una cosa non è stata verificata con una prova reale
> (comando, test, riga di codice, risposta live), è scritto esplicitamente.

---

## 1. Che cos'è Sinapsys, in una riga

La memoria persistente e **associativa** per agenti AI: un grafo dove un ricordo ne innesca
un altro e i ricordi **arrivano all'agente** senza che li cerchi. Non un motore di ricerca.

- **Visione integrale:** [01-vision-and-plan/MEMORIA-BLUEPRINT.md](01-vision-and-plan/MEMORIA-BLUEPRINT.md)
- **Come lavoriamo (patto Lorenzo–Socio):** [00-charter/COME-LAVORIAMO-SOCIO.md](00-charter/COME-LAVORIAMO-SOCIO.md)

---

## 2. Dove gira, adesso

| | |
|---|---|
| **Codice** | `C:\Users\lo\tencentdb-agent-memory` — branch **`main`** (locale; `fork` come remoto consentito, **mai `tencent`**) |
| **Gateway** | processo Node dal `dist/` del repo, in ascolto su **`127.0.0.1:8421`** (token in `<dataDir>/token`) |
| **Dati (DB live)** | `C:\Users\lo\.claude\plugins\data\tdai-memory-tdai-local\vectors.db` — **2,57 GB** |
| **Config attiva** | ⚠️ `C:\Users\lo\.memory-tencentdb\memory-tdai\tdai-gateway.yaml` — **NON** in `tdai-gateway\`, errore facile da fare |
| **Avvio / stop** | `C:\Users\lo\tdai-gateway\start-gateway.ps1` / `stop-gateway.ps1` |
| **Embedder** | DeepInfra **Qwen3-Embedding-4B @ 1024 dim** (verificato in `embedding_meta`) |
| **Estrazione** | Moonshot/Kimi (`TDAI_LLM_*`), fallback `gpt-5.4-mini` |

**Salute al 2026-08-22:** gateway `status: ok`, `embedding: ok`, recall live via `strategy=kb`
(**0,5 s a caldo**, 13,6 s la prima query a freddo), `/health` riporta ora anche `last_capture_at`.
**1.005 test verdi**, 3 rossi noti (§9).

---

## 3. Quanto sa, oggi (numeri misurati sul DB live)

| | |
|---|---|
| Conversazioni grezze (L0) | **35.676** |
| Entità | **12.422** |
| Fatti | **20.092** |
| Eventi | **15.439** — di cui **1.699** errori (`bug`) |
| Relazioni | **7.831** |
| **Lezioni** (Quaderno Errori) | **53** — erano **6** il 2026-08-07 mattina |
| Righe di consolidamento | **33.728** — **844** promosse a `long`, **1.511** rinforzate |
| DB | **2,76 GB** |

---

## 4. Che cosa È VIVO (costruito, acceso, verificato)

| Pilastro | Stato | Dove |
|---|---|---|
| **Idea 1 — Context Fingerprint** | live | `src/core/hooks/{session-situation,fingerprint-*,task-type}.ts` |
| **Idea 2 — Implicit Priming** | live | `src/core/kb/{implicit-priming,spreading-activation}.ts` |
| **Idea 3 — Mistake Notebook** | **live e finalmente CRESCE** (6→45 lezioni) | `src/core/kb/{bug-clusters,lessons-*}.ts` |
| **Idea 4 — Proactive Injection** | live | `src/core/hooks/{situation,situation-injection}.ts` |
| **Idea 5 — Distinctive Terms** | live (ma timbra poco: vedi §6) | `src/core/distinctiveness/*` |
| **Idea 6 — Grounded Trust** | live | `src/core/kb/{provenance,stakes,grounded-trust-ask}.ts` |
| **Consolidamento → recall** | **ACCESO** il 2026-08-07 | `recall.consolidationBoost: true` |
| **Officina (friction capture)** | **ACCESO** il 2026-08-07 | `src/core/kb/friction-capture.ts` |
| **Interruzione dei loop** | **ACCESO** il 2026-08-07 | idem + `tdai-core.recordFriction` |
| **Banner visibile all'utente** | acceso | `claude-code-plugin/lib/hook.ts` (`systemMessage`) |

Dettaglio modulo-per-modulo: [../SINAPSYS-ARCHITECTURE.md](../SINAPSYS-ARCHITECTURE.md) ·
mappa dei flussi: [02-architecture/INTERCONNECTION-MAP.md](02-architecture/INTERCONNECTION-MAP.md)

---

## 4-bis. Il guasto del 13–22 agosto e la garanzia "MAI in silenzio"

### Che cosa è successo (accertato, non ipotizzato)

Dal **12/08 23:13** al **22/08** la memoria non ha registrato **nulla**. Tre guasti in fila,
tutti silenziosi:

| # | guasto | prova |
|---|---|---|
| 1 | Claude Code ha cambiato il layout d'installazione dei plugin (`<plugins>/cache/<mkt>/<plugin>/<versione>/dist/lib/`). Il plugin calcolava la propria cartella dati risalendo **4 livelli**; ne servono **6** → cartella inesistente → `no daemon, skipped` ad ogni aggancio | `~/.tdai-memory/hook.log`; il calcolo sbagliato dava `…/cache/tdai-local/data` |
| 2 | il gateway è morto il 13/08 alle 22:56 ed è rimasto giù fino al 18/08 | `hook.log`: `ECONNREFUSED` il 14, 15, 17 e 18 agosto |
| 3 | il plugin **installato** era la build del **29/06**: le correzioni del 07/08 (banner + officina) erano nel repo e **mai copiate** | `hooks.json` installato senza `PostToolUse`; bundle senza il fix del banner |

Ogni guasto scriveva in un file di log che nessuno legge. **Un log non è un segnale.**

### Le cinque trappole ora in funzione (ognuna con test che nomina il guasto che coglie)

| trappola | scatta quando | dove |
|---|---|---|
| `data-dir-lost` | il plugin non trova la propria cartella (guasto 1) | `lib/hook.ts` → `lib/data-dir.ts` |
| `gateway-unreachable` | `/health` non risponde (guasto 2) | `lib/hook.ts` (session-start) |
| `capture-failed` | la cattura fallisce dopo il ritentativo | `lib/hook.ts` (stop) |
| `capture-empty` | il gateway risponde OK ma scrive **0 righe** | `lib/hook.ts` (stop) |
| `memory-stale` | hai lavorato **>24 h** dopo l'ultimo ricordo salvato | `lib/staleness.ts` + `/health.last_capture_at` |

Come arrivano a Lorenzo: un allarme viene scritto come briciola (`alarms.json`) e il primo
`UserPromptSubmit` successivo lo mostra come **`systemMessage`**, l'unico canale che Claude Code
rende direttamente all'utente. **Un allarme batte sempre il banner "mi ricordo di te"**: una
falsa rassicurazione è ciò che ha nascosto il guasto per dieci giorni.

**Rete di sicurezza indipendente:** `~/.claude/scripts/hooks/session-start-tdai-health.js` ripete
il controllo di anzianità **senza dipendere dal plugin** — è l'unico punto che può accorgersene se
il plugin stesso è rotto o spento. Provato dal vivo con soglia forzata a 1 s.

**Perché in ferie non urla:** l'anzianità confronta l'ultimo ricordo con l'ultima sessione
**realmente avvenuta**. Senza sessioni nuove i due orologi restano fermi insieme.

### Contro il ritorno del guasto 3 (deriva repo → installato)

`npm run install:cc-plugin` costruisce **e installa** in un colpo solo, scoprendo la cartella
d'installazione invece di assumerla. Il passaggio manuale che si poteva dimenticare non esiste più.

### Recupero

`tools/recover-sessions.mts` rigioca i transcript attraverso lo **stesso** `/capture` degli
agganci (nessuna porta di servizio): a vuoto per default, `--commit` per scrivere, riprendibile,
con doppia guardia anti-doppione (cursore **e** verifica sul database in sola lettura).
**Le 9 sessioni perse sono state recuperate: 152 turni, 0 fallimenti.**

---

## 5. Le tre verità scomode (misurate, non opinioni)

### 5.1 Su LongMemEval il nostro differenziatore NON batte il RAG piatto
Prova su 40 domande reali, giudice **ufficiale** GPT-4o:

| | flat (RAG normale) | kb (associativo) |
|---|---|---|
| oracle (senza distrattori) | **60%** | **60%** |
| s_cleaned (con distrattori) | **30%** | **20%** |

**EDGE = 0, e −10 sotto distrattori.** Non è "rotto": LongMemEval misura chiacchiere di vita
quotidiana, Sinapsys è memoria per **coding agent** e scarta il chit-chat di proposito.
**È il metro sbagliato.** Non usarlo come benchmark di vendita.
→ [../../benchmark/longmemeval/DESIGN-2026-07-21.md](../../benchmark/longmemeval/DESIGN-2026-07-21.md)

### 5.2 LongMemEval non può misurare la consolidazione (lezione metodologica)
Ogni domanda del benchmark semina una memoria **vergine**: nessun ricordo è mai stato ripetuto,
quindi non c'è nulla da consolidare. **Ecco perché l'arm `kb_consol` diede esattamente 0.**
Falliva il banco di prova, non il motore. La consolidazione va misurata su una memoria **vissuta**
(A/B su memoria vera: 9 query su 20 cambiano la top-8).
→ [01-vision-and-plan/PIANO-FILO-CONSOLIDAMENTO-RECALL.md](01-vision-and-plan/PIANO-FILO-CONSOLIDAMENTO-RECALL.md)

### 5.3 La memoria è stata mezza cieca per 9 giorni e nessuno se n'è accorto
Chiave DeepInfra revocata → gateway `degraded` con **517 avvisi solo nel log**, mai mostrati.
Dal 29/07 al 07/08: **zero vettori** su 1.604 ricordi nuovi. Risanato, **1.483/1.604 recuperati (92%)**.
**Lezione permanente:** un guasto che grida solo dentro un file di log **non esiste**.
La salute deve arrivare a Lorenzo, non al disco.

---

## 6. Che cosa manca DAVVERO (lista onesta, in ordine di valore)

| # | Cosa manca | Perché conta | Stato |
|---|---|---|---|
| **1** | **Sinapsys dentro Argus su Render** | Argus gira 24/7 nel cloud **senza la memoria associativa**: è il pezzo che chiude la stella polare | **progettato**, non costruito → [01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md](01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md) |
| **2** | **Decidere il rapporto con la memoria che Argus HA GIÀ** | Argus ha `argus-memory.mjs` su Supabase, viva e cablata in 10+ moduli. Sostituirla è rischioso; ignorarla crea due verità divergenti | **decisione aperta** — raccomandazione: due velocità (CLS), §3 del doc Punto 5 |
| 3 | **Decisione: un DB o due?** (portatile ↔ cloud) | Unificare crea dipendenza dalla rete su ogni tuo prompt (recall ha 6s) | **decisione aperta per Lorenzo** (§9 del doc Punto 5) |
| 4 | Il temporale crolla sotto distrattori (0/5) | È il terreno di Zep/Graphiti (validity windows) | non affrontato |
| 5 | `salience` a 0 per il **98,9%** dei ricordi | L'Idea 5 (Distinctive Terms) quasi non timbra | non affrontato |
| 6 | `state` = `active` per **33.649 su 33.649** | Il decadimento non declassa MAI nulla → "dimenticare" non funziona | non affrontato |
| 7 | Budget di recall fisso (top-5) | Le domande di aggregazione ("quanti/elenca") hanno bisogno di più | non affrontato |
| 8 | Embedding/reranker locali (Fase E) | Toglie la dipendenza da un fornitore esterno (il guasto §5.3) | non costruito |
| 9 | Chat di claude.ai non catturate | Solo Claude Code è agganciato | parcheggiato |

---

## 7. La sessione GLOBALE che viene: mettere Sinapsys in Render

**Obiettivo:** Argus (24/7 su Render) usa Sinapsys perfettamente.

⚠️ **Premessa da non sbagliare (verificata 2026-08-07):** Argus **non è senza memoria**.
Ha `C:/Argus/engine/lib/argus-memory.mjs` (308 righe) su **Supabase** - storico chat
append-only + fatti curati con `evidence_count` — usata da **10+ moduli**, inclusa una sua
consolidazione. Hanno scelto Supabase proprio perché un disco Render non è condivisibile
fra i tre servizi. Quindi Sinapsys non va "aggiunta": va **collocata**.
**Raccomandazione: due velocità (Complementary Learning Systems)** — `argus-memory` resta
la memoria operativa veloce, Sinapsys diventa lo strato profondo associativo (recall per
significato, Quaderno degli Errori, interruzione dei loop). È la nostra stella polare
applicata alla lettera: ippocampo + neocorteccia.

**Il vincolo che decide tutto** (verificato sulla documentazione Render):
un disco persistente appartiene a **UN SOLO servizio** e **i cron non possono usarlo affatto**.
Argus è **tre** servizi (`argus-brain`, `argus-maker`, `argus-nightly`), **nessuno con disco**.
→ "montare un disco su Argus" è **impossibile**.

**La strada:** Sinapsys diventa un **servizio privato Render con disco**; i tre servizi Argus lo
chiamano sulla rete privata (worker e cron **possono inviare** richieste, anche se non riceverle).
Il gateway **è già** quel server HTTP: non si riscrive nulla.

**Punto d'innesto unico in Argus:** `askLLM` — `C:\Argus\engine\lib\llm.mjs:115`.

Piano in 6 fasi, costi verificati (~$10–20/mese), gate espliciti:
→ **[01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md](01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md)**

---

## 8. Mappa dei documenti (che cosa trovi dove)

| Documento | A cosa serve |
|---|---|
| **QUESTO FILE** | Stato reale, numeri veri, cosa manca. **Punto d'ingresso.** |
| [README.md](README.md) | Hub: struttura delle cartelle e regole di progetto |
| [CODE-POINTER.md](CODE-POINTER.md) | Dove vive il codice, file chiave, come si riavvia il gateway |
| [00-charter/COME-LAVORIAMO-SOCIO.md](00-charter/COME-LAVORIAMO-SOCIO.md) | Il patto di lavoro (partner, non esecutore) |
| [01-vision-and-plan/MEMORIA-BLUEPRINT.md](01-vision-and-plan/MEMORIA-BLUEPRINT.md) | **La visione** — le 5 idee originali, le fonti scientifiche |
| [01-vision-and-plan/SINAPSYS-PLAN.md](01-vision-and-plan/SINAPSYS-PLAN.md) | Il piano tecnico storico per fasi |
| [01-vision-and-plan/PIANO-FILO-CONSOLIDAMENTO-RECALL.md](01-vision-and-plan/PIANO-FILO-CONSOLIDAMENTO-RECALL.md) | Il filo consolidamento→recall: design, misura A/B, limiti |
| [01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md](01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md) | **Il prossimo passo:** Sinapsys in Argus su Render |
| [02-architecture/INTERCONNECTION-MAP.md](02-architecture/INTERCONNECTION-MAP.md) | Come i pezzi si parlano (flussi reali) |
| [02-architecture/FOUNDATIONS-POINTER.md](02-architecture/FOUNDATIONS-POINTER.md) | Puntatore alle fondamenta (tabelle del DB) |
| [../SINAPSYS-ARCHITECTURE.md](../SINAPSYS-ARCHITECTURE.md) | Architettura modulo-per-modulo (accanto al codice) |
| [../SINAPSYS_FOUNDATIONS.md](../SINAPSYS_FOUNDATIONS.md) | I mattoni del DB (lifecycle, lessons, audit, fingerprints) |
| [../SINAPSYS-NEXT-BLUEPRINT.md](../SINAPSYS-NEXT-BLUEPRINT.md) | Il "Sinapsys socio, non bibliotecario" |
| [03-research/](03-research/) | Ricerca verificata (memoria umana + stato dell'arte AI) |
| [04-decisions/](04-decisions/) | ADR — decisioni a verbale |
| [../archive/SINAPSYS-STORICO-DOCS-20260718.md](../archive/SINAPSYS-STORICO-DOCS-20260718.md) | Storico dei design chiusi |

---

## 9. Regole ferme (valgono sempre, anche nella sessione globale)

1. **Determinismo:** mai "dovrebbe funzionare". Se non è verificato, si scrive "non l'ho verificato".
2. **Design-first:** ricerca dei vincoli reali **prima** del codice.
3. **Backup del DB prima di toccarlo.** Ogni modifica live: non-distruttiva e reversibile.
4. **Mai push su `tencent`.** Mai committare segreti (`.env`, chiavi, token).
5. **La memoria non rompe MAI la conversazione:** fail-open, errori ingoiati e loggati.
6. **Ambition bar:** se il design è la cosa ovvia che fanno tutti, è sbagliato.
