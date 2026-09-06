# 🧭 SINAPSYS — STATO REALE

> **Vedi anche**: gli altri documenti vivi di Sinapsys — [MEMORIA-BLUEPRINT](01-vision-and-plan/MEMORIA-BLUEPRINT.md) ·
> [CODE-POINTER](CODE-POINTER.md) · [INTERCONNECTION-MAP](02-architecture/INTERCONNECTION-MAP.md) ·
> [SINAPSYS-ARCHITECTURE](../SINAPSYS-ARCHITECTURE.md) ·
> [SINAPSYS_FOUNDATIONS](../SINAPSYS_FOUNDATIONS.md). Il quadro di tutti e 5 i sistemi:
> `C:\RISTRUTTURAZIONE\04-I-CINQUE-SISTEMI.md`. Dove siamo adesso: `C:\RISTRUTTURAZIONE\00-STATO.md`.

> **Aggiornato: 2026-08-23.** Ogni numero qui è stato **misurato**, non ricordato.
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
| **Dati (DB live)** | `C:\Users\lo\.claude\plugins\data\tdai-memory-tdai-local\vectors.db` — **2,80 GB** |
| **Config attiva** | ⚠️ `C:\Users\lo\.memory-tencentdb\memory-tdai\tdai-gateway.yaml` — **NON** in `tdai-gateway\`, errore facile da fare |
| **Avvio / stop** | `C:\Users\lo\tdai-gateway\start-gateway.ps1` / `stop-gateway.ps1` |
| **Embedder** | DeepInfra **Qwen3-Embedding-4B @ 1024 dim** (verificato in `embedding_meta`) |
| **Estrazione** | Moonshot **`kimi-k2.6`** (`TDAI_LLM_MODEL`; ragionamento spento in automatico sugli host Moonshot, `TDAI_LLM_THINKING` per forzarlo), ripiego **su ogni chiamata LLM** `gpt-5.4-mini` (`TDAI_FALLBACK_LLM_*`, chiave `OPENAI_API_KEY`) — dal 05/09/2026, vedi §2-bis |

**Salute al 2026-08-23:** gateway `status: ok`, `embedding: ok`, recall live via `strategy=kb`
(**0,5 s a caldo**, 13,6 s la prima query a freddo), `/health` riporta ora anche `last_capture_at`.
**1.052 test verdi, 0 rossi** (2 saltati: solo-POSIX su Windows).

---

## 2-bis. AGGIORNAMENTO 05/09/2026 — quattro guasti riparati, tutti misurati

**Che cosa era rotto** (letto nei log del gateway vivo, `gateway.err.log`, 05/09):

1. **L'estrazione era morta da giorni**: Moonshot ha ritirato `moonshot-v1-auto` → ogni finestra dava
   `Not found the model moonshot-v1-auto or Permission denied` (2 tentativi, poi ripiego). Ma il ripiego
   `gpt-5.4-mini` copriva **solo** `extractKbDelta` (`tdai-core.ts`): le due **distillazioni** (lezioni e
   principi) non avevano ripiego e fallivano in silenzio contando i cluster come «elaborati».
2. **La cattura degli attriti non aveva mai prodotto un evento in 29 giorni**: il plugin ascoltava
   `PostToolUse` con `tool_output_is_error`, ma Claude Code ≥ 2.1 manda i fallimenti su un evento
   separato, `PostToolUseFailure`, con un campo `error`. Nessuno lo ascoltava.
3. **Un ricordo «da confermare» non era confermabile da Claude Code**: confirm/reject esistevano solo come
   tool in-process (OpenClaw). Il ricordo dell'IBAN BG20 è rimasto in attesa dal 04/09.
4. **26 sessioni vere mai (o solo in parte) digerite** perché il gateway era giù mentre giravano.

**Che cosa c'è ora** (branch `fix/sinapsys-20260905`, `npm run build` exit 0, `npx vitest run` →
1.276 verdi / 2 saltati, 05/09/2026):

| Pezzo | Dove | Prova |
|---|---|---|
| Ripiego su **ogni** chiamata LLM (estrazione + 2 distillazioni), `LLMFallbackExhaustedError` quando cadono entrambi | `src/adapters/standalone/llm-runner.ts`, `llm-provider.ts`, `gateway/config.ts` (`llm.fallback`) | test `distillation-llm-failure`, `llm-provider` |
| Host Moonshot/Kimi: `thinking: {type: "disabled"}` iniettato, `temperature` **omessa** (Kimi accetta un solo valore per modalità) | `llm-provider.ts` `resolveThinking`/`resolveTemperature` | live 05/09: `kimi-k2.6` risponde in 1,8 s con thinking spento |
| Distillazione onesta: contatore `skippedLlmFailed` + riga `[lessons] distillation LLM failed n/m clusters` | `src/core/kb/lessons-runner.ts`, `principle-runner.ts`, `usage-runner.ts` | test `distillation-llm-failure` |
| `PostToolUseFailure` → evento `bug` (dedup per firma, tetto per sessione) | `claude-code-plugin/hooks/hooks.json`, `lib/hook.ts` `handlePostToolUseFailure` | live 05/09: fallimento sintetico via stdin → riga `[friction] recorded` nel gateway + riga in `events` (`type='bug'`, chiave sessione `C:\Sofia-AI`); il ripetuto identico NON crea una seconda riga |
| Comandi distruttivi riusciti taggati `tool_risk: "destructive"` (osservazione, non attrito) | `lib/destructive-commands.ts`, `src/core/kb/destructive-capture.ts` | test `destructive-capture`, `destructive-correction-wiring` |
| `POST /memory/confirm` · `/memory/reject` + skill `/memory-confirm <id>` · `/memory-reject <id>` | `gateway/server.ts` `handleGatedMemory`, `claude-code-plugin/skills/memory-confirm|reject` | live 05/09: `fact_01KWT3SMSB0000M87KKS` (IBAN BG20 = nostro) → `{"ok":true}` |
| Installer che raggiunge anche la **sorgente** del marketplace (`~/.claude/plugins/tdai-mkt/plugin`) e copia le skill; `--dry-run` | `scripts/install-cc-plugin.mjs` | live 05/09: 2 destinazioni × 8 file, `cmp` cache == build |
| Riempimento delle sessioni mai catturate: `tools/backfill-cc-sessions.mts --list/--run/--digest` (classi: catturate-complete 49 · parziali 9 · mai 8 · figlie-Argus 3.124, escluse salvo `--include-argus-children`) | `src/cli/backfill-cc/*` (14 moduli, 74 test) | `--list` 05/09: 3.190 registrazioni, 570 MB |

**Verificato dal vivo dopo il riavvio** (gateway sulla build nuova dalle 15:48 ora locale del 05/09,
`gateway.out.log`): `run() completed: 85804ms, model=kimi-k2.6, output=15456 chars` per `kb-extraction`,
poi `lesson-distill`, `principle-distill` (356 char) e `usage-distill` completati sullo stesso modello;
**zero** righe `moonshot-v1-auto` dopo il riavvio. Riempimento: `--run` → 17/17 registrazioni rigiocate
(`replayed=11 partial=0 failed=0` nel secondo giro + 6 nel primo), 5 chiavi di sessione toccate; poi
`--digest 5/5`. Misurato il 06/09 alle 10:40Z: 11 estrazioni `kimi-k2.6` completate, `events` +32,
`facts` +25, `entities` +32 dalle 14:00Z del 05/09. ⚠️ Il drenaggio di `/digest` avviene **lato gateway**
a passi di ~50 messaggi (una chiamata LLM da 40-90 s l'uno) e per una chiave grossa dura ore: il
watchdog del tool (`--stall-minutes 30`) abortisce la richiesta HTTP e segna la chiave «failed», ma il
gateway **continua** il giro. Per ora la verità sul digest è nel log del gateway, non nello stato del tool.

**Guasto trovato riempiendo, ancora aperto in produzione (→ §6, riga 1):** la registrazione da 18 MB
(`3f0aa5cb…`) ha avuto bisogno di **29 s** per i suoi 50 turni; il client del plugin aspetta **12 s**
(`CAPTURE_TIMEOUT_MS`), riprova una volta, poi scrive «captureTurn failed — session not saved» **e il
gateway continua lo stesso a elaborare la richiesta abbandonata**. Il primo giro di riempimento ha così
accodato ~20 catture identiche e il cursore non si è mosso; `/health` non ha risposto per oltre 60 s. Le 9
sessioni «catturate a metà» sono con ogni probabilità questo stesso guasto dal vivo (⚠️ NON VERIFICATO una
per una). Riparato **solo per il riempimento**: `TDAI_CAPTURE_TIMEOUT_MS` (il tool lo mette a 300 s,
`--capture-timeout-ms`) e un freno nel ciclo (2 chiamate senza avanzamento → `failed`, non 20). Per le
sessioni vive resta aperto: il gateway deve rispondere subito a `/capture` e scrivere dopo.

**Variabili nuove** (lette all'avvio del gateway, quindi **riavviare** dopo averle cambiate):
`TDAI_LLM_THINKING` (`disabled`|`enabled`), `TDAI_FALLBACK_LLM_BASE_URL`, `TDAI_FALLBACK_LLM_API_KEY`
(altrimenti `OPENAI_API_KEY`), `TDAI_FALLBACK_LLM_MODEL` (default `gpt-5.4-mini`), `TDAI_FALLBACK_LLM_MAX_TOKENS`,
`TDAI_FALLBACK_LLM_TIMEOUT_MS`, `TDAI_FALLBACK_LLM_THINKING`. Su questa macchina `TDAI_LLM_MODEL=kimi-k2.6`
sta in `C:\Users\lo\tdai-gateway\gateway.secrets.env` (non versionato), che `start-gateway.ps1` inietta.

---

## 3. Quanto sa, oggi (numeri misurati sul DB live)

| | |
|---|---|
| Conversazioni grezze (L0) | **35.893** |
| Entità | **12.582** |
| Fatti | **20.416** |
| Eventi | **15.687** — di cui **1.708** errori (`bug`) e **18** principi |
| Relazioni | **7.958** |
| **Lezioni** (Quaderno Errori) | **68** — erano **6** la mattina del 2026-08-07 |
| Righe di consolidamento | **34.309** — **850** promosse a `long`, **1.517** rinforzate |
| DB | **2,80 GB** |
| **Registro del richiamo** (verdetto) | **67** iniezioni, **50** giudicate, **5** usate → **utilità 10%** |

---

## 4. Che cosa È VIVO (costruito, acceso, verificato)

| Pilastro | Stato | Dove |
|---|---|---|
| **Idea 1 — Context Fingerprint** | live | `src/core/hooks/{session-situation,fingerprint-*,task-type}.ts` |
| **Idea 2 — Implicit Priming** | live | `src/core/kb/{implicit-priming,spreading-activation}.ts` |
| **Idea 3 — Mistake Notebook** | **live e CRESCE** (6→68 lezioni) | `src/core/kb/{bug-clusters,bug-working-set,lessons-*}.ts` |
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
| `memory-degraded` | il gateway risponde ma l'embedder no (503) — richiamo peggiore, non morte | `lib/hook.ts` (session-start) |
| `writing-to-backup` | la cartella scelta è un **archivio** — i nuovi ricordi finirebbero in un DB vecchio | `lib/data-dir.ts` |

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

### Il quarto guasto, trovato mentre si verificava il banner

Il banner non compariva **nemmeno dopo il fix**. Motivo: il recall al **primo turno di ogni
sessione** impiegava **11,5 s** mentre il budget del plugin è **6 s** → l'iniezione veniva
scartata. In **ogni** progetto. E il gateway dichiarava `total=274 ms`: due numeri diversi per
la stessa cosa.

**Causa:** `scheduleBackgroundDistillation` lanciava tre compiti `(async () => …)()` chiamandoli
"staccati". Non lo erano: **il corpo di una funzione async gira in modo SINCRONO fino alla prima
attesa**, e `await store.runLessonDistillation(…)` deve prima *valutare* la chiamata — che arriva
a `selectFailureClusters`, un confronto a coppie interamente sincrono sul corpus degli errori.
Misurato sul DB vivo (1.706 errori): SQL 43 ms, letture vettori 505 ms, **aggregazione ~5,6 s** →
6,2 s a compito, tre di fila sullo stack del chiamante.

**Fix** (`src/core/tdai-core.ts`): cedere il controllo al ciclo eventi **prima** di ogni passo, in
catena (mai più di un blocco per volta), + **finestra di 30 minuti** — quei calcoli sono
idempotenti e il loro input cambia in giorni, non in minuti.

**Misurato dopo:** Argus 444/285 ms · Sinapsys 302/284 ms · Sofia-AI 317/376 ms.
**Banner verificato dal vivo attraverso il plugin installato**, su Argus, sessione nuova.

---

### Il debito di prestazione, chiuso (2026-08-23)

Il confronto a coppie fra tutti gli errori era **O(N²) sincrono**: 1.706 errori → **4.726 ms**
di ciclo eventi bloccato, e cresceva con la memoria.

Il rimedio ovvio (copiare `usage-clusters`: "tieni i 300 più recenti") **sarebbe stato sbagliato
qui**: 68 lezioni citano 612 errori, quindi **1.094 non sono citati da nessuno**. Un taglio per
sola recenza avrebbe sepolto quell'arretrato — proprio nel pilastro per cui esiste tutto questo.

**`src/core/kb/bug-working-set.ts`** — una finestra che *si consuma*: precedenza agli errori che
nessuna lezione ha mai citato, dal più recente; il **25% del budget resta riservato** a errori già
coperti, perché senza di loro un guasto nuovo non potrebbe agganciarsi a un gruppo vecchio e
genererebbe una lezione doppia. Budget **400 → ~240 ms**.

**Limite dichiarato** (nel modulo e in un test): la finestra scorre solo quando un errore *diventa
coperto*, cioè quando produce una lezione. Misurato oggi: 67 gruppi sul corpus intero, 15 nella
finestra, **zero nuovi in entrambi i casi** — il Quaderno è a regime, quindi il taglio oggi non
perde nulla. Se un giorno servisse, il rimedio è una finestra a rotazione.

**Provato dal vivo:** 8 recall lanciati *mentre* la distillazione girava → peggiore **970 ms**
(prima ~18.000 ms). Primo turno: 2.213 ms a freddo, poi 377–490 ms.

### Il rischio scoperto riavviando: scrivere in un ARCHIVIO

`state.json` della cartella viva si è troncato a **0 byte** con il gateway acceso. Non era più un
candidato, e ha vinto una cartella `*.BACKUP-20260614-pre-reindex` il cui file vecchio si leggeva
ancora: i nuovi ricordi sarebbero finiti in un database di due mesi prima, **senza un segnale**.

Tre rimedi: le cartelle si ordinano ora per *(PID vivo → NON-archivio → recenza)*; l'allarme
`writing-to-backup`; e `start-gateway.ps1` ricostruisce `state.json` anche quando il gateway è
già acceso (prima usciva senza toccarlo, quindi un file rotto non veniva mai riparato).

> ⚠️ Trappola PowerShell: un `.ps1` senza BOM viene letto come ANSI. Un trattino lungo UTF-8
> diventa `â€”`, e `”` **apre una stringa**: lo script non si compila più. I `.ps1` restano ASCII.

---

### Recupero

`tools/recover-sessions.mts` rigioca i transcript attraverso lo **stesso** `/capture` degli
agganci (nessuna porta di servizio): a vuoto per default, `--commit` per scrivere, riprendibile,
con doppia guardia anti-doppione (cursore **e** verifica sul database in sola lettura).
**Le 9 sessioni perse sono state recuperate: 152 turni, 0 fallimenti.**

---

## 4-ter. Il verdetto di utilità (2026-08-23) — la misura che mancava

Sinapsys **non ha mai saputo se serviva**. Peggio: l'unico anello di ritorno era rovesciato —
`reinforceRecalledOwners` rinforza i migliori risultati associativi di **ogni** richiamo, quindi un
ricordo iniettato e ignorato diventava **più forte per sempre**. Il recupero veniva scambiato per
utilità.

### Come si misura (e perché non si chiede al modello)

Chiedere a me *"ti è servito?"* è il disegno ovvio ed è sbagliato: mi valuto da solo, nessuno può
controllare, e ho ogni motivo per dire di sì. Quindi si misura una cosa verificabile:

> Un ricordo conta come **USATO** se nella risposta compaiono parole distintive che vengono dal
> **RICORDO** e **non dal messaggio dell'utente**.

Quella seconda condizione è tutto il disegno. Senza, la misura è un'eco: tu scrivi "Argus", il
ricordo dice "Argus", la risposta ripete "Argus" — e ogni ricordo sembra utile. Sottraendo il
vocabolario del prompt resta solo ciò che l'agente **non poteva avere dalla conversazione** — che
è esattamente ciò a cui serve la memoria. Deterministico: niente LLM, niente vettori.

### Tre stati, tenuti distinti apposta

| stato | significato |
|---|---|
| **usato** | la risposta porta parole che vengono solo dal ricordo |
| **rumore** | giudicabile, iniettato, mai atterrato |
| **non giudicabile** | non aggiungeva nulla che l'utente non avesse già scritto — nessuna risposta potrebbe provarne l'uso |

L'utilità si calcola **solo sui giudicabili**. Se non c'è nulla di giudicabile il verdetto dice
*"non lo so"* invece di inventare un numero.

### Dove vive

`src/core/kb/recall-usage.ts` (giudizio, puro) · `src/core/kb/recall-ledger.ts` + tabella
`recall_ledger` (registro) · richiamo → scrive · cattura → giudica · `tools/memory-verdict.mts` →
te lo mostra. **Ogni riga conserva le parole che hanno deciso**: un numero da controllare, non da
credere.

### Il numero, su traffico vero (2026-08-23)

| | |
|---|---|
| iniezioni registrate | **67** |
| giudicate | **50** |
| **usate davvero** | **5** |
| rumore (giudicabili, mai usate) | **45** |
| non giudicabili | 0 |
| **UTILITÀ** | **10%** |

Ogni verdetto porta con sé le parole che l'hanno deciso — il primo è provato da
`["fallback","lock","postgres","redis","supabase"]`.

**10% è basso, e va letto per quello che è:** su 10 ricordi che la memoria mi mette davanti, 1
lascia traccia nel lavoro. Non è ancora un giudizio sul valore di Sinapsys — è la prima volta che
esiste un numero da migliorare invece di un'impressione. Si legge con
`npx tsx tools/memory-verdict.mts`.

> ⚠️ **Non ancora fatto, di proposito:** l'anello di ritorno (usato → rinforza, rumore → decade)
> **non è collegato**. Cambia cosa la memoria conserva, quindi si accende solo dopo che il verdetto
> avrà girato abbastanza su traffico vero da meritare fiducia. Prima misurare, poi agire.

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
| **0** | **`/capture` deve rispondere subito e scrivere dopo** | Una sessione lunga manda 50 turni in una chiamata; sopra i ~12 s il plugin la abbandona («session not saved») ma il gateway la elabora lo stesso, e ogni Stop successivo rimanda gli stessi 50 turni: lavoro doppio, niente salvato, `/health` muto per un minuto (misurato 05/09/2026, §2-bis) | **aperto** — riparato solo per il riempimento offline (`TDAI_CAPTURE_TIMEOUT_MS`); per le sessioni vive serve ack immediato + scrittura in coda |
| **1** | **Sinapsys dentro Argus su Render** | Argus gira 24/7 nel cloud **senza la memoria associativa**: è il pezzo che chiude la stella polare | **progettato**, non costruito → [01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md](01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md) |
| **2** | **Decidere il rapporto con la memoria che Argus HA GIÀ** | Argus ha `argus-memory.mjs` su Supabase, viva e cablata in 10+ moduli. Sostituirla è rischioso; ignorarla crea due verità divergenti | **decisione aperta** — raccomandazione: due velocità (CLS), §3 del doc Punto 5 |
| 3 | **Decisione: un DB o due?** (portatile ↔ cloud) | Unificare crea dipendenza dalla rete su ogni tuo prompt (recall ha 6s) | **decisione aperta per Lorenzo** (§9 del doc Punto 5) |
| 4 | Il temporale crolla sotto distrattori (0/5) | È il terreno di Zep/Graphiti (validity windows) | non affrontato |
| 5 | `salience` a 0 per il **98,9%** dei ricordi | L'Idea 5 (Distinctive Terms) quasi non timbra | non affrontato |
| 6 | `state` = `active` per **34.309 su 34.309** | Il decadimento non declassa MAI nulla → "dimenticare" non funziona | non affrontato |
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
