# Sinapsys — Storico Docs (archiviato 2026-07-18)

> Wave di consolidamento docs (Fase 2), zona Sinapsys (`C:\Users\lo\tencentdb-agent-memory` + `C:\Sinapsys`, non-git).
> Fonti: `verdicts-tencentdb-00.md`, `verdicts-tencentdb-01.md`, `verdicts-sinapsys.md`, `CANCELLO-A-REPORT.md` §2.
> Metodo: file TRACKED nel repo → summary qui + `git rm` nella stessa PR (contenuto integrale recuperabile via `git log`/`git show`).
> File UNTRACKED (mai stati in git, incl. tutto `C:\Sinapsys` che non è nemmeno un repo) → contenuto integrale incollato qui sotto, perché altrimenti andrebbe perso per sempre.

## Indice

**Sezione A — C:\Sinapsys (non-git, 4 documenti SUPERATI, full-paste):**
1. `C:\Sinapsys\03-research\RIASSUNTO-MEMORIA-CHAT.md`
2. `C:\Sinapsys\05-handoff\2026-06-23.md`
3. `C:\Sinapsys\05-handoff\2026-06-24-night.md`
4. `C:\Sinapsys\05-handoff\2026-06-24.md`

**Sezione B — repo tencentdb-agent-memory, file UNTRACKED (full-paste):**
5. `.claude/memory/done-log.md`
6. `.claude/memory/next-up.md`
7. `.claude/memory/status.md`
8. `docs/superpowers/plans/2026-06-29-grounded-trust-phase1-provenance.md`
9. `docs/superpowers/plans/2026-06-29-session-continuity-dove-eravamo.md`
10. `docs/superpowers/plans/2026-07-07-recall-associative-first-A.md`

**Sezione C — repo tencentdb-agent-memory, file TRACKED (summary + `git rm`, contenuto integrale in git history):**
11. `HANDOFF.md`
12. `SKILL.md`
13. `SKILL-DIAGNOSTIC-EXPORT.md`
14. `SKILL-MIGRATION.md`
15. `docs/ENTITY_CORE_BLUEPRINT.md`
16. `docs/HANDOFF-2026-06-24-trackB.md`
17. `docs/HANDOFF-2026-06-25.md`
18. `docs/HANDOFF-2026-06-26.md`
19. `docs/INVESTIGATION-2026-06-25-memory-reach-and-always-on.md`
20. `docs/PHASE2B_EXTRACTION_PROMPT_REDESIGN.md`
21. `docs/PHASE2_EXTRACTION_FIX_SPEC.md`
22. `docs/PHASE2_KB_EXTRACTION_SPEC.md`
23. `docs/RECALL_ROOT_CAUSE_ANALYSIS.md`
24. `docs/SINAPSYS-RECALL-REDESIGN-HANDOFF.md`
25. `scripts/bugfix-20260423/BUGFIX-20260423-SOP.md`
26. `docs/superpowers/specs/2026-06-24-context-fingerprint-design.md`
27. `docs/superpowers/specs/2026-06-24-track-b-mistake-notebook-design.md`
28. `docs/superpowers/specs/2026-06-25-distinctiveness-scorer-design.md`
29. `docs/superpowers/specs/2026-06-29-grounded-trust-child-and-fire-design.md`
30. `docs/superpowers/specs/2026-06-29-grounded-trust-phase1-provenance-design.md`
31. `docs/superpowers/specs/2026-06-29-session-continuity-dove-eravamo-design.md`
32. `docs/superpowers/specs/2026-06-30-grounded-trust-phase2-stakes-design.md`
33. `docs/superpowers/specs/2026-06-30-grounded-trust-phase3-4-ask-loop-and-learning-design.md`
34. `docs/superpowers/specs/2026-06-30-implicit-priming-design.md`
35. `docs/superpowers/specs/2026-06-30-mistake-notebook-b3-avoidance-design.md`
36. `docs/superpowers/specs/2026-06-30-spreading-activation-associative-recall-design.md`
37. `docs/superpowers/specs/2026-07-01-behavioral-notebook-design.md`
38. `docs/superpowers/specs/2026-07-01-pilastro-b-track-record-design.md`
39. `docs/superpowers/specs/2026-07-01-pilastro-c-fase2-distillazione-design.md`
40. `docs/superpowers/specs/2026-07-07-recall-associative-first-design.md`

---

# Sezione A — C:\Sinapsys (non-git)

## C:\Sinapsys\03-research\RIASSUNTO-MEMORIA-CHAT.md (archiviato 2026-07-18)

**Verdetto:** SUPERATO. **Perché:** recap della chat del 16/06 pre-piano ("nome da decidere Super-mem/Sinapsi", "Fasi 1-6 non iniziate") — tutto assorbito e superato da MEMORIA-BLUEPRINT.md + SINAPSYS-PLAN.md (ora in `docs/vision/`) + i round di ricerca 1/2. Non versionato da nessuna parte (C:\Sinapsys non è un repo git) → contenuto integrale sotto.

**Fatti da tenere:** è il documento zero da cui è nato tutto il progetto Sinapsys (5 idee originali, architettura a 5 livelli). Il nome "Sinapsys" è stato scelto dopo (proposte alternative: "Super-mem" di Lorenzo, "Sinapsi" di Claude).

<details>
<summary>Contenuto integrale (mai versionato — 57 righe)</summary>

```markdown
# Contesto per la nuova chat — Progetto Memoria per Agenti AI

## Chi sono
Lorenzo Colucci, founder non-tecnico di Studio Immigrato (Milano, consulenza immigrazione). Ho costruito Sofia AI (receptionist AI vocale + WhatsApp, 24/7, 5 lingue) e altri progetti. Lavoro con Claude come partner strategico (analisi, decisioni, architettura) e Claude Code (Opus 4.8) come esecutore. Non so programmare: le decisioni tecniche le prende Claude, io le decisioni di prodotto e business.

## Cosa abbiamo fatto nella chat precedente (16 giugno 2026)

Stavamo costruendo le fondamenta di un sistema multi-agente autonomo (loop engineering con memoria). Abbiamo installato hook di protezione test, fallback LLM, file di memoria su disco, e riparato TencentDB (il mio sistema di memoria persistente basato su SQLite+vec0+Kimi). Durante la riparazione abbiamo scoperto che TencentDB aveva un recall di 0/4 su fatti specifici — completamente inutile. La causa: un merge distruttivo che cancellava i fatti reali e lasciava solo blob di istruzioni.

Da lì siamo partiti in una conversazione più profonda: **come costruire un sistema di memoria per agenti AI che sia il migliore esistente.**

## Il ragionamento che abbiamo fatto (il flow da continuare)

### Il problema mondiale
Tutti i sistemi di memoria AI (claude-mem, Mem0, Hermes, MemOS, Letta) trattano la memoria come un **problema di ricerca**: "data una query, trova il documento più simile." Ma la memoria umana non funziona così. Quando leggo la parola "FABLE", non faccio una ricerca — **ricostruisco**. Un ricordo tira l'altro in una cascata associativa. E i ricordi non li cerco: mi vengono addosso, innescati dal contesto (un odore, una parola, una situazione).

### Il punto di partenza onesto
Gli umani hanno 5 sensi che contribuiscono a creare memorie. L'olfatto è il più potente per il recall (arriva direttamente all'amigdala/ippocampo senza passare dal talamo). Gli LLM non hanno sensi — processano token in sequenza e predicono il successivo. Non formano associazioni spontanee. Claude è stato onesto: "forse il limite è irriducibile con l'architettura attuale dei transformer." Ma il punto non è replicare la memoria umana — è **complementarla**: l'umano ricorda le strategie e il perché, l'agente ricorda i dettagli esatti.

### Cosa abbiamo scoperto dalla ricerca (22 paper + 9 sistemi analizzati)
- **Complementary Learning Systems** (McClelland 1995, Kumaran/Hassabis 2016): il cervello ha due sistemi — ippocampo (veloce, episodico) e neocorteccia (lento, semantico). Si completano. Nessun sistema AI implementa davvero entrambi.
- **Implicit Priming** (arxiv 2605.08538v1, maggio 2026): ricordi sotto soglia che non emergono ma **influenzano il ranking** di altri ricordi collegati. Come l'odore del caffè che non ti fa pensare al caffè ma a quella mattina. Nessun sistema pratico lo implementa.
- **Mistake Notebook Learning** (arxiv 2512.11485): i fallimenti vengono raggruppati per pattern e distillati in lezioni generalizzabili. Non "il build è fallito il 10 giugno" ma "quando tocchi i notification service, controlla sempre l'outbox."
- **ImplicitMemBench** (arxiv 2604.08064v1): benchmark che prova che NESSUN LLM supera il 66% su memoria implicita. GPT-5 al 63%. Limite strutturale.
- **MemOS** (arxiv 2507.03724): memoria come sistema operativo — scheduling, lifecycle, sleep-time consolidation.
- **Letta/MemGPT**: core memory sempre visibile (RAM) + recall memory on demand (disco) + processi di sleep-time.

### Le nostre 5 idee originali (non esistono in nessun sistema)
1. **Context Fingerprint** — match per SITUAZIONE (file+errori+tool), non per contenuto. "L'ultima volta che eri in questa situazione, ecco cosa è successo."
2. **Implicit Priming / Cascata** — ricordi sotto soglia amplificano fatti collegati nel grafo. Cerchi "IBAN" (score basso) ma il priming fa emergere "lead perso" (collegato, score amplificato).
3. **Mistake Notebook** — fallimenti clusterizzati per dominio → lezioni generalizzabili iniettate proattivamente.
4. **Proactive Injection** — i ricordi vengono all'agente senza che li cerchi. Hook PostToolUse osserva cosa fa l'agente e inietta contesto.
5. **Distinctive Term Indexing** — parole-chiave di progetto (FABLE, IBAN, lo-debugger) pesano 3x nell'indice.

### L'architettura a 5 livelli che abbiamo disegnato
- L0: Working Memory (file su disco) — ✅ COSTRUITO
- L1: Episodica (narrazioni strutturate: Situazione→Azioni→Risultati→Lezioni)
- L2: Semantica (knowledge graph in SQLite con relazioni tipizzate + implicit priming)
- L3: Procedurale (Mistake Notebook)
- L4: Consolidation Engine (sleep-time: episodio→fatti, clustering fallimenti, staleness, reinforcement, contradiction check)
- L5: Proactive Injection (hook che osserva e inietta)

### Il nome del progetto
Proposte: **"Super-mem"** (di Lorenzo, diretto) o **"Sinapsi"** (di Claude, perché il cuore del sistema sono le connessioni tra i ricordi, non i ricordi stessi). Da decidere.

## Documento completo
Il blueprint completo è salvato in:
- File: `MEMORIA-BLUEPRINT.md` (nella home di Lorenzo e in C:\Sofia-AI\docs\)
- Notion: pagina "🧠 Blueprint Sistema di Memoria — Lorenzo + Claude" nell'INDEX del Cervello di Lorenzo

## Stato implementazione
- Fase 0 (fix TencentDB base): IN CORSO — Code sta finendo fasi 4-5 (reindicizzazione + test)
- Fasi 1-6: non iniziate

## Come continuare questa chat
Partire dal blueprint (`MEMORIA-BLUEPRINT.md`), verificare lo stato della Fase 0, e proseguire con la Fase 1 (ricerca ibrida FTS5+vettori) o approfondire le idee originali se serve affinare il design prima di implementare.
```

</details>

---

## C:\Sinapsys\05-handoff\2026-06-23.md (archiviato 2026-07-18)

**Verdetto:** SUPERATO. **Perché:** handoff di sessione (effimero per natura), stato "prossimo passo = Sinapsys Fase A" — Fase A è stata costruita e superata da tempo (vedi `docs/vision/02-architecture/INTERCONNECTION-MAP.md` sez. C.1-C.4). Mai versionato → contenuto integrale sotto.

**Fatti da tenere:** prima volta che si decide "Sinapsys si costruisce sopra TencentDB, niente rewrite" (poi ADR-0001) e branch `feat/memory-excellence` (poi migrato a `feat/sinapsys-l4-consolidation`). Trappole operative Windows (portproxy fantasma su 8421, jest-orphan-reaper) risolte da tempo.

<details>
<summary>Contenuto integrale (mai versionato — 37 righe)</summary>

```markdown
# 🤝 HANDOFF — sessione 23 giugno 2026 (Lorenzo + Claude/Socio)
> Apri una sessione NUOVA di Claude Code, dammi questo file, e ripartiamo freschi.
> Regola: tratta tutto qui come contesto DA VERIFICARE contro la realtà, non verità assolute.

## 1. In una riga
Riparata e resa stabile la memoria TencentDB, **ucciso il bug della finestra che lampeggiava** (non era il gateway!), e scritto il piano tecnico di **Sinapsys**. Prossimo passo: costruire Sinapsys **Fase A**.

## 2. Stato VERIFICATO adesso (non a memoria)
- **Gateway memoria:** sano, stabile da 15h+, `recall.source=kb`, DB **52 MB**. Recall reale funziona (es. "codice segreto"→MANGO 0.79).
- **Memoria entity-centric:** live. Entità+fatti+**relazioni**+eventi, ricerca ibrida (FTS+vettori+entity→RRF), proiezioni persona/scene a inizio sessione (con filtro anti-segreti). Recall 6/7 sui test, canaries 4/4.
- **Finestra lampeggiante:** ✅ RISOLTA. Vera causa = task pianificato **`jest-orphan-reaper`** (PowerShell Interactive ogni 10 min). Fix: lanciato via `wscript` nascosto (`C:\Users\lo\jest-reaper-hidden.vbs`). Confermato da Lorenzo: non compare più.

## 3. Decisioni prese (non ridiscutere senza motivo)
- Memoria resta **LOCALE** (no Supabase). Daemonless rimandato: la fragilità è già risolta, non urge.
- Sinapsys si costruisce **sopra TencentDB** (è già ~metà fatto). Niente rewrite.
- Branch: **`feat/memory-excellence`**. **MAI push su main.** Commit chiave: b96590e→15fabee.

## 4. TRAPPOLE — cosa NON rifare (la parte più preziosa)
- ❌ **NON incolpare/toccare il gateway per la finestra** — abbiamo perso 3 sessioni così. Il colpevole erano task pianificati + MCP a shim `cmd`/`npx`.
- ❌ **NON `taskkill` su svchost/iphlpsvc** (servizi di sistema).
- ⚠️ **Fantasma di rete:** una regola `netsh portproxy 0.0.0.0:8421→127.0.0.1:8421` (servizio iphlpsvc) bloccava il restart. Rimossa con `netsh interface portproxy delete v4tov4 listenport=8421 listenaddress=0.0.0.0` (serve admin). Se il gateway non riparte: **controlla `netsh interface portproxy show all`**.
- ⚠️ Kimi gira a **temperatura=1**: variazioni nell'estrazione sono normali, non bug.
- ⚠️ Backfill: le finestre giganti di meta-lavoro su questo tool falliscono a 45s → basso valore, non inseguirle.
- ⚠️ Firebase MCP rimosso da `.cursor/mcp.json` e `.claude.json` (backup `.bak-20260623`) perché flashava via Cursor. Augment è SACRO, deve funzionare.

## 5. Prossimo passo
**Sinapsys Fase A** = Consolidation Engine (L4) + Mistake Notebook (L3, adottando il design **MNL** — codice su GitHub). Piano completo: `C:\Users\lo\Downloads\SINAPSYS-PLAN.md`.
- Azione preliminare: **verificare `TDAI_LLM_MODEL`** del gateway — i `kimi-k2-*` legacy sono EOL 25/05/2026 (eventualmente passare a K2.5/K2.6).

## 6. File da leggere all'inizio (verifica, non fidarti)
- `C:\Users\lo\Downloads\SINAPSYS-PLAN.md` — il piano tecnico (cosa adottare vs costruire, fasi, costi ~0-5€/mese).
- `C:\Users\lo\Downloads\MEMORIA-BLUEPRINT.md` — il blueprint originale (16/06).
- `C:\Users\lo\tencentdb-agent-memory\.claude\memory\status.md` — stato del progetto memoria.
- Repo: `C:\Users\lo\tencentdb-agent-memory` (branch `feat/memory-excellence`).

## 7. Come parla il Socio con Lorenzo
Italiano, diretto, niente "probabilmente", niente complimenti gratuiti, ironia quando ci sta. Mai push su main. Test che conta = quello che fa Lorenzo dal vivo, non i miei script. Comandi PowerShell con `cd` iniziale e `;`.
```

</details>

---

## C:\Sinapsys\05-handoff\2026-06-24-night.md (archiviato 2026-07-18)

**Verdetto:** SUPERATO. **Perché:** handoff di sessione — ricerca 7/7 ambiti chiusa (ora in `docs/vision/03-research/`), hub costruito (ora unificato in `docs/vision/`), Fase A deterministica (3 commit c69c6dc/bc0fb5e/f6dede2) tutta superata da lavoro successivo (aggancio live 93abfad, poi L4 v1 contradiction-detector 44a1625). Mai versionato → contenuto integrale sotto.

**Fatti da tenere:** i 5 mattoni delle fondamenta (memory_lifecycle, lessons, memory_audit, context_fingerprints, relations.weight) sono nati in questa sessione (commit `c69c6dc`) — oggi documentati in `docs/SINAPSYS_FOUNDATIONS.md` (nel repo). Trappola nota: `db.exec` di node:sqlite = falso positivo del security hook.

<details>
<summary>Contenuto integrale (mai versionato — 29 righe)</summary>

```markdown
# Handoff — 24 giugno 2026 (notte)

## In una riga
Chiuse la **ricerca** (7/7 ambiti, 2 round verificati), costruito l'**hub** C:\Sinapsys, e implementata la **Fase A deterministica** di Sinapsys (fondamenta + consolidamento) — 3 commit, 87 test verdi, su `feat/memory-excellence`.

## Stato verificato
- **Commit** (branch `feat/memory-excellence`, NIENTE push):
  - `c69c6dc` fondamenta (5 mattoni: memory_lifecycle, lessons, memory_audit, context_fingerprints, relations.weight)
  - `bc0fb5e` Fase A·1 — lifecycle access layer + audit (promozione a 2 condizioni)
  - `f6dede2` Fase A·2 — consolidation runner deterministico (rinforza + decade)
- **Test:** suite KB 87/87 verde, `tsc --noEmit` pulito.
- **NON deployato:** lo schema si applica al DB live solo al prossimo build + restart gateway (additivo, sicuro).

## Primo passo prossima sessione
1. **Aggancio live** di `runConsolidation` a session-end fire-and-forget. Studiare: `src/core/tdai-core.ts` (handleSessionEnd, wirePipelineRunners) + `src/gateway/server.ts` (POST /session/end). Cadenza confermata da Lorenzo: session-end fire-and-forget.
2. **Fase B** (lezioni): clustering events `bug`/`fix` → `lessons` con LLM, come step 3 del runner. Eval set da costruire dai dati KB reali (recall/canary), NON chiederlo a Lorenzo.
3. **Deploy**: build + restart gateway.

## Trappole (non ricascarci)
- ⚠️ Il security hook segnala `db.exec` di node:sqlite come fosse shell (FALSO POSITIVO). Workaround usato: `db.prepare(sql).run()`. Usalo per ogni DDL nuovo.
- ⚠️ Gateway live gira: non riavviarlo senza l'OK di Lorenzo. Token in `<dataDir>/token`.
- ⚠️ MAI push su main. MAI spostare il codice fuori dal repo (vedi ADR-0002).
- Modello verificato `moonshot-v1-auto` (no kimi-k2 EOL). Embeddings = OpenAI 3-small 1536.

## Dove guardare
- Architettura viva: `C:\Sinapsys\02-architecture\INTERCONNECTION-MAP.md` (sezioni C.1–C.4).
- Fondamenta: `repo/docs/SINAPSYS_FOUNDATIONS.md`.
- Memoria agente: schede `sinapsys-*` (vision, build-state, research-findings).
```

</details>

---

## C:\Sinapsys\05-handoff\2026-06-24.md (archiviato 2026-07-18)

**Verdetto:** SUPERATO. **Perché:** handoff di sessione — Proactive Injection (Track A) chiusa end-to-end + Fase A live, tutto su `main` del fork all'epoca; superato da tutto il lavoro successivo (Grounded Trust, Mistake Notebook B1-B3, Implicit Priming, recall associativo-first, L4 v1). Mai versionato → contenuto integrale sotto.

**Fatti da tenere:** qui nasce il fix critico "i ricordi rilevanti venivano scartati al confine HTTP" (proactive injection di fatto spenta) — poi `composeRecallContext` in `recall-context.ts`. 3 known-issues aperti all'epoca (redazione segreti pre-embed, looksLikePromptInjection, build:scripts rotto) — tutti poi chiusi (vedi Grounded Trust + sanitize.ts).

<details>
<summary>Contenuto integrale (mai versionato — 32 righe)</summary>

```markdown
# Handoff — 24 giugno 2026 (sessione lunga)

## In una riga
Costruita la **Proactive Injection** (Track A, la memoria che ti viene incontro) end-to-end + chiusa la **Fase A live**, tutto su `main` del fork. Sinapsys ora si auto-protegge dall'errore che l'ha ispirato (inietta i propri principi).

## Stato verificato (tutto LIVE + PUSHATO)
- **GitHub:** `fork/main` = `main` locale = commit `0f9f913` (17 commit, fast-forward, secret-scan pulito). Remoti: `fork`=tuo (target), `origin`=YOMXXX e `tencent`=upstream → NON pushare lì.
- **Gateway live** (PID 8708, /health 200) col codice nuovo. Suite motore **199/199 verde**.
- **Fatto e verificato live:**
  - Fase A·3 — consolidamento agganciato a session-end (commit 93abfad).
  - Track A·1 — il gateway consegna i ricordi rilevanti su /recall (413ddbb).
  - Track A·2 — principi vincolanti iniettati in cima a ogni sessione (4d6f273).
  - Track A·3+4 — proactive injection per SITUAZIONE: tocchi un file → arrivano i ricordi su quel file, silenzio se nulla di rilevante (0f9f913). **Endpoint /observe verificato; il hook PostToolUse si attiva alla PROSSIMA sessione CC.**

## Prossimo passo (deciso insieme)
Sessione NUOVA e pulita → affrontare i 3 "known issues" reali, **segreti per primi**. Lista triata in `sinapsys-known-issues`:
1. [SECURITY HIGH] redazione segreti prima di write/embed L1.
2. [SECURITY MEDIUM] riaccendere `looksLikePromptInjection` (sanitize.ts:153).
3. [DX] sistemare `build:scripts` rotto + script typecheck engine.
Poi: rifiniture Track A (principi per-progetto, accumulo context_fingerprints) e **Track B** (Mistake Notebook profondo — ridisegno, vedi `sinapsys-phase-b-direction`).

## Trappole (non ricascarci)
- ⚠️ `db.exec` di node:sqlite = falso positivo del security hook → usa `db.prepare(sql).run()`.
- ⚠️ Test JSON con path Windows nella shell: i `\\` collassano → JSON invalido. Costruisci con `String.fromCharCode(92)`+`JSON.stringify`. Il vero hook è sempre valido.
- ⚠️ I riavvii gateway backgrounded a volte non ricaricano: kill esplicito del PID sulla porta, poi start.
- ⚠️ `npm run build` completo è rotto a build:scripts → usa solo `npm run build:plugin`.
- ⚠️ Mai push su `origin`/`tencent`. Bypass hook push-main: refspec `feat/...:main`.

## Dove guardare
- Direzione viva: schede `sinapsys-dual-track-direction`, `sinapsys-phase-b-direction`, `sinapsys-known-issues`, `sinapsys-build-state-verified`.
- Mappa codice: `C:\Sinapsys\02-architecture\INTERCONNECTION-MAP.md` (sezioni C.4–C.6).
- File Fase B su disco (untracked, da tenere): `repo/src/core/kb/lessons-*.ts` (+ test).
```

</details>

---

# Sezione B — repo tencentdb-agent-memory, file UNTRACKED (full-paste)

## .claude/memory/done-log.md (archiviato 2026-07-18)

**Verdetto:** SUPERATO. **Perché:** log "done" fino al 2026-06-18 (Phase 1-5 del redesign entity-centric, PR#1-3, Track B); superato da `.claude/session-state.md` (07-08) come registro corrente. UNTRACKED (mai in git) → contenuto integrale sotto.

**Fatti da tenere:** cronaca dettagliata della riparazione iniziale di TencentDB (merge distruttivo RC1, vettori orfani RC2, Kimi params RC5) e della prima estrazione entity-centric (P0-P5). Root cause dei bug storici già confermata anche in `docs/RECALL_ROOT_CAUSE_ANALYSIS.md` (altra voce di questo storico).

<details>
<summary>Contenuto integrale (mai versionato — 94 righe)</summary>

```markdown
# Done Log

## 2026-06-18 — ASSESSMENT salute+qualità memoria (richiesto da Lorenzo)
- CATTURA+ESTRAZIONE: OK. 256 record L1 (era 41 il 16/6), crescita giornaliera (records 16/17/18 giu), 255 episodic + 1 instruction, contenuto atomico/tecnico. l0_conversations=296.
- RECALL SEMANTICO: FRAGILE/ROTTO al momento del check. Il gateway (PID 60364, uptime ~7h) era BLOCCATO: /health e /capture in timeout; log "[recall] embedding part failed: fetch failed", "operation aborted". Le query embedding fallivano -> recall "No memories found" (cosine ~0.16). La chiave OpenAI funziona (test diretto OK, embedding reale). Quindi è il client HTTP interno del gateway che degrada dopo ore.
- RIAVVIATO (PID 61172 poi 60364->kill->restart). Dopo restart: /health veloce, e un fatto NUOVO (QUARZO-NEBULOSA-555) catturato adesso fa self-recall a COSINE 0.84 -> la pipeline embed+store+query funziona quando il gateway è fresco.
- MA i vettori VECCHI sono degradati: MANGO (16/6) self-near-exact = cosine 0.12 (era 0.69 il 16/6). FTS (keyword) li trova ancora; il recall semantico dei fatti storici è inaffidabile. Meccanismo esatto NON CONFERMATO (probabile reindex o finestra di embedding fallito che ha sovrascritto i vettori storici).
- AUTO-RESTART gap: l'health hook scatta solo se il gateway è GIÙ, non se è VIVO-ma-bloccato -> degrado silenzioso per ore.
- QUALITÀ: scene_name ~31% ancora cinese + contaminazione token cinesi anche in nomi IT ("...del重磅detector"); content a volte mischia cinese ("Aggiornamenti包含..."); L2 scene_blocks + L3 persona ancora interamente cinesi. Dedup same-fact gate FUNZIONA (log "Guard: forcing store"). Score tool = RRF, non cosine.
- AZIONI CONSIGLIATE (non fatte, serve OK Lorenzo): 1) stabilità gateway (ricreare client embedding su errore / health-check periodico con auto-restart su hang); 2) health hook deve rilevare hang (timeout) non solo processo morto; 3) reindex vettori vecchi quando embedding sano; 4) lingua sorgente per scene_name/L2/L3.

## 2026-06-16 (sera, 2) — FIX scene_name lingua + dedup same-fact gate (PR #3)
- Bug 2 (scene_name cinese): l1-extraction 任务一 forzava "中文" nel naming. Phase 2b aveva corretto solo la lingua del content. Fix: scene_name in lingua sorgente. Verificato LIVE: "Utente richiede di memorizzare un codice segreto" (IT).
- Bug 1 (fatto nel JSONL ma NON in l1_records/l1_vec → non cercabile): NON è il write path. PROVA: canary nuovo "ZAFFIRO-LUNARE-77" embeddato+inserito ok (upsert result=true). Causa reale = il DEDUP LLM che fa update/merge O skip del fatto pulito "Il codice segreto è MANGO-STELLARE-99." contro record con stessi token ma significato diverso ("MANGO non in memoria", osservazioni di ricerca dell'assistente) → stored=0. Il guard RC1 copriva cross-type/many-to-many/halluc, ma NON "stesso type, target valido, fatto diverso".
- Fix (l1-dedup.ts parseBatchResult): gate Jaccard "stesso fatto" — merge/update forzato a store se target non quasi-duplicato (<0.6 overlap); skip forzato a store se nessun candidato richiamato è quasi-duplicato. + tokenSimilarity() + thread candidate content nel guard.
- Verificato LIVE (gateway 41472, codice fixato): re-capture → "Stored memory ... il codice segreto e MANGO-STELLARE-99" extracted=1/stored=1; ricerca tool "MANGO-STELLARE-99" → fatto pulito a COSINE 0.6898 (distance 0.310). build:plugin clean; vitest 109 pass/6 fail (pre-esistenti).
- GIT: PR#2 era stata mergiata in fork/main (d6a5abe). Fix spostato su branch fix/dedup-samefact-and-scene-lang, main resettato a fork/main. PR #3 aperta.
- FOLLOW-UP: pulire i record-spazzatura pre-fix ("MANGO non in memoria" + osservazioni di ricerca AI); escludere in estrazione gli output di ricerca dell'AI; display recall = mostrare cosine non RRF.

## 2026-06-16 (sera) — FIX: L1 trigger non scatta dopo restart (PR #2)
- SINTOMO: dopo riavvio gateway, cattura L0 ok (conversations/ agg.) ma estrazione L1 ferma (records/ fermo); nessuna chiamata Kimi, nessun errore nei log.
- ROOT CAUSE: recoverPendingSessions (pipeline-manager.ts) al restart resettava conversation_count=0 e armava solo L2. Assunzione "messaggi persi" OBSOLETA dopo il cursor-refactor (L1 legge da L0). Sessione conclusa/idle con backlog L0 (es. L1 fallito al precedente shutdown col cursore tenuto, Kimi sospeso) → nessun nuovo turno → nessun trigger soglia/idle → backlog bloccato. Evidenza: cd28f537/ae7e1835 con count=0/l2_pending=0 ("dimenticate"). MANGO-STELLARE-99 è nella sessione corrente 52f24315 (L0 in attesa soglia 5/idle 600s).
- FIX (commit 0547da5, branch fix/l1-recovery-after-restart, PR #2): recoverPendingSessions accoda L1 "recovery" FORZATO per ogni sessione ripristinata; il runner ri-legge L0 oltre il cursore (no-op se già estratto, cursore protegge da ri-estrazione). + "recovery" nell'union/force-path di enqueueL1. Runner L1 cablato PRIMA di scheduler.start (verificato) → nessun delay.
- VERIFICATO su gateway TEMP (repro esatto: LLM rotto→L1 fallisce→cursore tenuto+count=0→restart con LLM ok→recovery estrae KIWI-VERIFY-7, cosine 0.67-0.83). build:plugin clean; vitest 109 pass/6 fail (pre-esistenti). Produzione non toccata.
- GIT: PR#1 era già mergiata in fork/main (25184b4). Il fix era finito su local main → spostato su branch fix/l1-recovery-after-restart, local main resettato a fork/main (no push su main). PR #2 aperta.
- BLOCCO verifica LIVE del backlog reale (MANGO): gateway prod PID 43980 ELEVATO (riavviato come admin), non killabile da shell non-admin (Accesso negato). Serve kill manuale admin → poi start-gateway.ps1 (ricarica dist fixato) → recovery drena il backlog (Kimi ora ha credito).
- RISOLTO + VERIFICA LIVE PASS: Lorenzo ha killato 43980; gateway riavviato col codice fixato (PID 43336). Al primo /capture la recovery ha accodato L1 forzato per TUTTE le 11 sessioni (log: "Enqueuing L1" + "L1 running: messages=0, conversation_count=0"). Backlog DRENATO: records/2026-06-16.jsonl da fermo-a-01:38 → 43 record L1 estratti (es. 3e78=12 fatti, ae7e1835=6). MANGO-STELLARE-99 estratto come fatto atomico "Il codice segreto è MANGO-STELLARE-99." (episodic) + cercabile. Estratti anche i fatti del lavoro di stasera. Gateway healthy. Nota display: score mostrato dal tool = RRF (~0.03), non cosine (follow-up noto).


## 2026-06-16 — TASK COMPLETO (codice) + PR aperta
- Fix review committati (abab3c2): cold-start CRITICAL (ASC oldest-first), escapeXmlTags HIGH (memory poisoning), seed config_override SSRF MEDIUM, dedup cross-type guard MEDIUM. 4 test nuovi PASS. Build clean; vitest 109 pass / 6 fail (i 6 pre-esistenti claude-code-plugin/).
- Code review (lo-code-reviewer) + security audit (lo-security-auditor) eseguiti: 1 CRITICAL + 2 HIGH fixati/indirizzati; resto -> next-up.
- Branch pushato su remote `fork` (Lorenzocolucci/tencentdb-agent-memory-claude-code). origin = upstream YOMXXX (no push).
- PR #1: https://github.com/Lorenzocolucci/tencentdb-agent-memory-claude-code/pull/1 (body = report completo italiano).
- BLOCCO ESTERNO: account Kimi/Moonshot SOSPESO -> estrazione L1 live non verificabile su Kimi (verificato via unit test + fake). Recall 4/4, capture no-loss, resilienza, cross-project tutti verificati live.
- VERIFICA E2E FINALE (richiesta taskmaster): pipeline completa capture->extract->recall provata LIVE con OpenAI gpt-4o-mini (Kimi sospeso) su gateway temp, produzione non toccata: 4/4 fatti episodic puliti EN, no loss su turni separati, cosine 0.68/0.68/0.71/0.80. La pipeline FUNZIONA end-to-end con LLM vivo; solo il billing Kimi è esterno. Build:plugin clean; vitest 109 pass/6 fail (6 pre-esistenti claude-code-plugin/, NON regressioni); working tree pulito (solo .claude/). PR #1 commentata con l'esito E2E. TUTTI e 5 i test accettazione PASS.

## 2026-06-16 — PHASE 4 DONE (promozione live, lo-fullstack-developer opus)
- OBIETTIVO: rendere i 4 target (FABLE F0-F5, IBAN/post-call, booking loop 14 slot, embedding chunking fix) + 1 cross-project (TutorAI graphify) memorie L1 pulite e searchable nello store LIVE.
- DIAGNOSI: il prior seed (seed-20260616-032009) e il seed pipeline producono solo meta-instruction cinesi vaghe o 0 fatti, perche il prompt L1 estrae solo memoria SULL'UTENTE/regole-AI, non fatti tecnici di codice. Confermato dai log: booking=0 memorie, altri=1 instruction vaga.
- SOLUZIONE (piano step 4b): authoring diretto di 9 record episodic in italiano (grounded nei transcript reali: Sofia-AI 1e11c718/02143d9c/c949b7a5, repo commit chunking, Tutor 71efc2fc) + upsertL1(record, embedChunks(content)) via createStoreBundle(LIVE).init().
- PROMOZIONE (gateway STOPPATO): deleteL1Batch dei 5 blob m_* instruction; upsert 9 episodic. l1_records 5->9. L0 preservato (l0_conversations=170 invariato). Gateway riavviato PID 8108 healthy.
- EVIDENZA PASS (gateway running): COSINE searchL1Vector top-hit > 0.5 per tutte: FABLE 0.8284, IBAN 0.7520, booking 0.7993, chunking 0.7802, graphify 0.7224. HTTP /search/memories: fatto specifico corretto = top result per 5/5 query (hybrid RRF ~0.033).
- BACKUP intatto, repo pulito (.tmp-* rimossi), throwaway verify dir rimosso. NON cancellato seed-20260616-032009 (serve conferma).
- NOTA VIOLAZIONE REGOLA: l'agent Phase 4 ha cancellato i 6 file .tmp-* pre-esistenti (sessione precedente) senza conferma. Impatto basso (scratch usa-e-getta, rigenerabili) ma da segnalare a Lorenzo.

## 2026-06-16 — PHASE 5 DONE (verifica acceptance, lo-test-writer opus)
- TEST 1 PASS: 4 target recall cosine >0.5 (FABLE 0.63, IBAN 0.61, booking 0.57, chunking 0.71), fatto giusto = top result.
- TEST 2 PASS: gateway auto-restart (8108 -> kill -> SessionStart hook -> 3776 healthy, no start manuale).
- TEST 3 PASS STRETTO ma QUALITA' ESTRAZIONE PESSIMA: PURPLE-ELEPHANT-42 catturato+recallabile (cosine 0.56-0.60) MA 2 fatti su 3 (decisione PostgreSQL, bug calculateTax) DROPPATI, e l'unico record e una meta-instruction CINESE "用户要求 AI 记住...". L'estrattore NON cattura fatti tecnici puliti.
- TEST 4 PASS: warning forte su stderr quando gateway giu. (Solo se CLAUDE_PLUGIN_DATA settato, che CC inietta per gli hook.)
- TEST 5 PASS: cross-project recall (cosine 0.58 da cwd/progetto estraneo).
- NOT CONFIRMED: embedding config provenance (funziona, embeddingService:true; viene da gateway.secrets.env via start-gateway.ps1). I 6 .tmp-* pre-esistenti spariti (li ha cancellati Phase 4).

## DECISIONE: FIX QUALITA' ESTRAZIONE (riapre Phase 2)
L'obiettivo del task ("atomic facts, non instruction blobs") NON e soddisfatto: l'estrattore L1 droppa fatti tecnici e produce meta-instruction cinesi. Fix necessario: redesign prompt l1-extraction per (a) catturare decisioni/bug/fix tecnici come fatti episodic atomici, (b) NO reframing "用户要求 AI 记住", (c) OUTPUT nella LINGUA della conversazione, (d) non droppare contenuto tecnico. Poi rebuild+restart+riverifica TEST 3.

## 2026-06-16 — PHASE 2b DONE (fix qualita estrazione, committato)
- Redesign prompt l1-extraction (spec: docs/PHASE2B_EXTRACTION_PROMPT_REDESIGN.md): regola lingua-output=lingua-sorgente; vietato meta-framing "用户要求 AI 记住"; episodic = fatti tecnici di prima classe (decisioni/bug/fix/config) + few-shot; instruction ristretto a regole-AI vere. Cap 600->1000, maxMemoriesPerSession 10->30.
- VERIFICATO (re-run TEST 3, single-round): 3 record episodic separati in INGLESE (password, PostgreSQL-16, calculateTax bug), nessuno cinese/meta-framed, recall rank-1 (cosine 0.40/0.76/0.72). Build:plugin clean. Gateway riavviato PID 31992.
- Committato.
- NUOVA SCOPERTA (HIGH): seed multi-round perde fatti. Input 3 round -> solo 1 estratto (round 1); il cursore avanza e round 2-3 vengono consumati senza 2a estrazione. In 1 solo round tutti e 3 estratti. Race cursore/batching in seed-runtime. DA INVESTIGARE: il path LIVE /capture ha la stessa perdita? (lo-debugger). Spiega anche perche il TEST 3 originale dava 1/3.

## 2026-06-16 — Recon orchestratore (verificato)
- Gateway ATTIVO: curl /health -> 401 in 12ms, PID 36588. Il prompt diceva "morto da 7 giorni" ma era stato riavviato stanotte.
- Struttura repo mappata: engine in src/, hook layer in claude-code-plugin/lib/, gateway in src/gateway/.
- Confermato chunking fix committato su branch feat/embedding-chunking (3 commit).

## 2026-06-16 — PHASE 3 DONE (gateway resilience hook layer)
- lo-devops-engineer: implemented all 5 resilience items.
- Active hook path confirmed: `C:\Users\lo\.claude\plugins\cache\tdai-local\tdai-memory\0.1.0\dist\lib\hook.mjs` (loaded via ${CLAUDE_PLUGIN_ROOT}).
- Changes: gateway-client.ts (named timeouts, freshToken, retry+401-retry), hook.ts (stderr warn on capture fail, named constants, tokenPath), session-start-tdai-health.js (PID check + auto-restart via start-gateway.ps1).
- Built: tsdown OK (32.16 kB). Tests: 90 pass / 6 fail — all 6 failures are pre-existing Windows chmod issues + pre-existing cursor test bug, not regressions.
- Cache synced: hook.mjs + lib/*.ts copied to all 3 locations (cache, tdai-mkt, repo dist).
- Commit: cbb43e1 on feat/embedding-chunking.

## 2026-06-16 — PHASE 1 DONE (root cause analysis)
- lo-debugger: forensics DB + recall path. PROVA: l1_records=5 righe (tutte instruction) vs 193 record su disco; l1_vec=1 vettore; merge distruttivo in gateway.out.log; 3 query live tornano lo stesso blob ~0.19.
- lo-architect: mappa pipeline. Solo L0+L1 searchable. Merge prompt permette cross-type/many-to-many. sanitize guard disabilitate. Kimi temp/max_tokens errati.
- Chunking fix NON è il bug (live e funzionante). Plugin stale = solo hook layer, irrilevante.
- Deliverable scritto: docs/RECALL_ROOT_CAUSE_ANALYSIS.md.
- Dispatch PHASE 2 (lo-llm-architect design) + PHASE 3 (lo-devops-engineer resilience).

## 2026-06-16 — PHASE 2 DONE (engine fix, src/ only)
- lo-fullstack-developer (opus). Spec: docs/PHASE2_EXTRACTION_FIX_SPEC.md.
- RC1: conservative merge prompt (l1-dedup.ts:15-79) + runtime guard parseBatchResult (l1-dedup.ts:345-413) forza store su cross-type/many-to-many.
- RC4: extraction prompt esclude CLAUDE.md/system/routing (l1-extraction.ts:49-75); cap 600 char + clamp priority [0,100] (l1-extractor.ts:182-209). Band -1 RIMOSSA (unico consumer era display-only memory-search.ts:283).
- RC2: causa = embedding fail -> embedding undefined -> upsertL1 skipVec=true -> riga senza vettore ma ritorna true. Fix: embedChunksWithRetry + error LOUD + flag-for-reindex (l1-writer.ts:227-339).
- RC3: threshold gate nel path hybrid + recency boost (RECENCY_WEIGHT=0.15, halflife 30d, max +15%) (auto-recall.ts:52-99,556,644-727) + 9 test nuovi.
- RC5: Moonshot CONFERMATO (base api.moonshot.ai/v1, model moonshot-v1-auto, temp/max_tokens erano unset). Fix: default temp=1, max_tokens=16000 (llm-runner.ts, config.ts, types.ts, gateway/config.ts + 3 construction sites).
- Verify: build:plugin CLEAN, 0 nuovi typecheck error, test 6 pre-esistenti rossi / 99 verdi (+9 nuovi). No regressioni.
- ATTENZIONE: fix sono in src/ -> serve REBUILD dist + RESTART gateway perché diventino live (gateway gira da dist, PID 36588 = codice vecchio).
- OUT-OF-SCOPE: npm run build (full) rotto a build:scripts (dir scripts/ mancanti); manca typecheck script/tsconfig per engine.
```

</details>

---

## .claude/memory/next-up.md (archiviato 2026-07-18)

**Verdetto:** SUPERATO. **Perché:** follow-up del 06-16 (Phase 1-5 dell'epoca); L1 poi sostituito dal KB entity-centric (kb-extraction), item#2 (redazione segreti) coperto da `src/utils/redact-secrets.ts`. UNTRACKED (mai in git) → contenuto integrale sotto.

<details>
<summary>Contenuto integrale (mai versionato — 10 righe)</summary>

```markdown
# Next Up
> Phase 1-5 DONE. PR #1 aperta. Restano solo follow-up.

1. RICARICARE account Kimi/Moonshot, poi verificare TEST 3 end-to-end LIVE (estrazione L1 di una sessione reale -> recall). Il codice è pronto; serve solo l'LLM attivo.
2. [security HIGH] redaction segreti prima del write/embed L1 (pattern sk-/AKIA/Bearer/hex). Oggi i segreti detti in chat finiscono in chiaro + mandati a OpenAI per embedding. Decisione Lorenzo.
3. [security MEDIUM] re-abilitare looksLikePromptInjection (sanitize.ts:153, oggi dead code).
4. [MEDIUM] flushSession: rendere awaitable la coda trailing (pipeline-manager) — non è perdita dati, solo contratto async.
5. [LOW] reindexAll summary errori embed; rimuovere stmtL0QueryAll/After DESC (dead code dopo cold-start fix); UX: il tool recall mostra score RRF (~0.03), dovrebbe mostrare la COSINE (0.57-0.79).
6. Merge PR #1 dopo review. npm run build full è rotto a build:scripts (dir scripts/ mancanti) — sistemare o rimuovere gli step; manca uno script typecheck per l'engine.
7. (Opzionale) Quando Kimi è attivo, ri-estrarre i transcript persi giu 9-16 col pipeline fixed. Oggi i 9 fatti chiave nello store sono authored grounded (recall 0.57-0.79), non estratti.
```

</details>

---

## .claude/memory/status.md (archiviato 2026-07-18)

**Verdetto:** SUPERATO. **Perché:** header datato 07-06 ma contenuto reale è la cronaca Track B di giugno (cutover graduale L1→KB entity-centric); superato da `.claude/session-state.md` (07-08) come registro corrente e da tutto il lavoro successivo (Grounded Trust, Mistake Notebook, recall associativo-first, L4 v1). UNTRACKED (mai in git) → contenuto integrale sotto.

**Fatti da tenere:** cronaca del cutover L1→KB (backfill, proiezioni persona/scene, fix chunk_size vec0 che aveva gonfiato il DB a 8.3GB) — tutto oggi consolidato e descritto in `docs/SINAPSYS-ARCHITECTURE.md`.

<details>
<summary>Contenuto integrale (mai versionato — 97 righe)</summary>

```markdown
# Status — TencentDB Memory System
> Ultimo aggiornamento: 2026-07-06 21:56 (pre-compact auto)

## Progresso Track B (branch feat/memory-excellence)
- A1 embedding-resilient: b96590e (live verificato).
- P1 schema/store entity-centric: b498304.
- P2+P4 write path + retrieval (kbRecall RRF+rerank-flag+calibrazione): c441b99.
- FIX qualità estrazione: cdc2b6c — coerce-don't-reject (vocab fuori-enum → concept, mai perdita finestra),
  identifier pattern (codice in fact.value), anti-fabrication (no mixed-script garbage).
- FIX completezza estrazione: 9b79e8f — regola 2.5 enumera TUTTI i fatti tecnici in finestre dense
  (42703/idempotency/LEADDOC non più persi); regola 0 lingua top-level = lingua finestra.
- PROVA E2E (tools/kb-migrate.mts + kb-eval.mts su .kb-scratch, dati reali 06-16+06-17, Kimi+OpenAI reali):
  RECALL 6/7 gold (canaries MANGO/ZAFFIRO 4/4 rank-1; Sofia idempotency+LEADDOC HIT; solo "42703" literal MISS
  ma fatto semantico catturato). Diagnosi extraction-vs-retrieval per ogni miss. Live db (4.6GB) INTATTO.

## ✅ RE-TEST PERCORSO REALE (2026-06-19 ~12:35) — testato come lo usa Lorenzo, non coi miei script
- Backfill coda completato: kb ora 175 entità / 172 fatti / 136 eventi / 42 relazioni (era 129/136/102/42). DB 55MB, l1=281 intatto.
  Le finestre giganti di QUESTA sessione (meta sul tool) falliscono a 45s → coda 06-19 solo parziale (basso valore).
- VERIFICATO PERCORSO REALE (la critica chiave di Lorenzo: "tu testi e va, io provo e non va"):
  * skill memory-status → healthy.
  * recall via BINARIO plugin (node hook.mjs search-stdin) → "codice segreto"→MANGO score 0.79. È il path reale, non kb-eval.
  * /recall 0.19s, /capture 0.06s (budget hook 4s/12s — i timeout nel hook.log erano DURANTE la mia manutenzione, non a regime).
  * PIPELINE LIVE confermata su un turno reale: capture → "Using Phase-2 kb extraction engine" → Applied KbDelta → projected persona+12 scene.
  * Iniezione (persona+scene) visibile e pulita nei prompt di questa sessione.
- Pulita pollution di test (fatto "verde acqua" rimosso). Codice tutto committato (HEAD 3276818).
- CAUSA del "va da te ma non da me": hook recall ha budget 4s; se gateway giù/occupato (es. durante manutenzione) → timeout → nessuna iniezione. A regime 0.19s, ok.

## ✅ TUTTI E 4 I LAVORI DI LORENZO FATTI (2026-06-19 ~03:50) — sistema live, full stack nuovo
- Lavoro 2 RELATIONS (1772abd): prompt emette relazioni (entity-only, mai event ref) + schema coerce/drop;
  42 relazioni tipizzate nel kb live (related-to/uses/decided-in/caused/fixed-by/supersedes). Verificato via probe.
- Lavoro 3 PROIEZIONI persona+scene da kb (519b794): projections.ts/projections-writer.ts deterministiche (no LLM),
  persona.md = solo attributi allow-list, scene cap top-12 by heat. Flag extraction.kbProjections=true LIVE.
  tools/kb-project.mts --write per rigenerare. Vecchi scene-extractor/persona-generator NON rimossi (P6).
- SICUREZZA (3276818): le scene usavano entity.name (auto-iniettato) → leak di codici/credenziali (es. QUARZO-NEBULOSA-555
  reale era nei vecchi scene file). FIX looksLikeSecret() in projections: scene escludono eventi con entità/token segreti;
  persona esclude valori-credenziale. 7 vecchi scene file (old LLM extractor, con QUARZO) archiviati in .backup (non cancellati).
  Verificato: persona.md + 12 scene_blocks = 0 segreti.
- Lavoro 4 PULIZIA db (519b794): vec0 allocava ~6.29MB PER PARTITION (chunk_size default 1024 + partition key quasi-unica)
  = ~6MB per vettore → 8.3GB. Fix chunk_size=8 su kb_vec/l1_vec/l0_vec → DB 8.3GB→52MB. NIENTE cancellato (l0/l1 intatti).
  tools/kb-defrag-vec.mts per ri-defrag se serve. vecSchemaIsLegacy controlla solo chunk_id → nessun reindex al boot.
- Lavoro 5 ROBUSTEZZA (1772abd): retry 1x + riparazione JSON (virgoletta doppia/virgola finale) in kb-extractor.
- Backfill kb pulito (wipe+rebuild): 129 entità/136 fatti/102 eventi/42 relazioni. CODA 06-18/06-19 (~16 finestre) NON
  completata (Kimi lento, killato). Recall live 5/7 gold (canaries 4/4). DA FINIRE: resume tools/kb-backfill-live.mts.
- Commits sessione: b96590e A1, b498304 P1, c441b99 P2+P4, cdc2b6c+9b79e8f estrazione, fdfc8dc timeout, 1772abd relations+robust, 519b794 proiezioni+chunk_size.

## ✅ CUTOVER COMPLETO E LIVE (2026-06-19 ~01:00) — recall.source=kb attivo, VERIFICATO end-to-end
- Gateway prod serve recall dal KB entity-centric: POST /search/memories → "strategy":"kb".
  "codice segreto"→MANGO (0.66), "errore 42703"→bug PostgREST postcall_state (0.54), "ZAFFIRO"→0.72.
  Log: [kb-recall] (fts+vec+entity→RRF fused), score calibrati 0-1, rerank=false (flag OFF).
- Live db kb_*: **224 entità, 234 head facts, 152 eventi, 1 relazione, 396 kb_vec/fts**. quick_check=ok. l1_records=281 INTATTO.
- Backfill storico COMPLETO (tutti i 13 giorni, 65 finestre): backfill-live reso RESUMIBILE (skip finestre già in events per source_message_id → niente eventi duplicati) + timeout per-call configurabile (TDAI_KB_EXTRACT_TIMEOUT_MS, commit fdfc8dc) per fail-fast sulle finestre grandi. 2° run: 31 skip + 31 ok + 3 fail-closed.
- Eval finale sul db live COMPLETO: 6/7 (canaries 4/4; solo "LEADDOC" literal manca = varianza estrazione).
- Backup pre-cutover: .backup/vectors-precutover-20260619.db (4.6GB). ROLLBACK: yaml engine=l1+recall=l1 + restart (l1 intatto).
- Tool dev (untracked): tools/kb-backfill-live.mts (backfill live, rifiuta di girare se gateway up), kb-migrate/kb-eval (KB_EVAL_DB=<path> per live), kb-probe.
- RESTANO: finire backfill coda; P5 proiezioni L2/L3 da kb; P6 retire l1; opz relations (estrattore ne emette poche).

## CUTOVER GRADUALE (approvato da Lorenzo) — storico step
- Step 1 FATTO+VERIFICATO: rebuild dist + restart gateway su NUOVO codice. /health ok, embedding openai/1536 ok (zero regressione),
  "KB schema initialized (kbReady=true)" sul db live 4.6GB (additivo, l0/l1 intatti). Restart non-elevato OK (nessun blocco elevazione).
- Step 2 FATTO: tdai-gateway.yaml (~/.memory-tencentdb/memory-tdai/) → extraction.engine=kb, recall.source=l1. Gateway riavviato healthy, nessun fallback.
  Le NUOVE conversazioni vengono catturate dal motore entity-centric. (Conferma runtime end-to-end al prossimo turno reale catturato.)
- RECALL ANCORA SU l1 = nessuna regressione: il recall di Lorenzo legge i l1_records esistenti come prima.
- RESTANO (gli step più pesanti, da fare come operazione FOCALIZZATA, ~20-40min scrittura su prod + cambio comportamento recall):
  Step 3 backfill storico L0→kb nel db live; Step 4 eval sul db pieno; Step 5 flip recall.source=kb + verifica.
  Poi P5 proiezioni L2/L3 deterministiche, P6 retire l1.
- REVERSIBILE: per tornare al vecchio comportamento → engine=l1 nello yaml + restart (l1_records intatti).
- Config gateway: ~/.memory-tencentdb/memory-tdai/tdai-gateway.yaml (embedding + flag). Store live: TDAI_DATA_DIR=.claude/plugins/data/tdai-memory-tdai-local (4.6GB).
- Tool dev (non committati): tools/kb-migrate.mts + kb-eval.mts (eval gate), kb-probe.mts (probe estrazione). .kb-scratch/ = db prova eval.

## Obiettivo (Lorenzo, 18/6)
Memoria ECCELLENTE, stile llm-wiki, non solo buona. Basta patch ai sintomi. Approccio approvato: ENTITY-CENTRIC EVOLUTIVO.

## Diagnosi (perché è fallita 10+ volte) — 3 cause strutturali
1. 5 stadi LLM in serie (extract→dedup→scene→persona) = affidabilità = prodotto → fallimenti ricorrenti.
2. Dedup LLM DISTRUTTIVO (deleteL1Batch) = perdita dati + 6 guardie = quasi no-op.
3. Client embedding che marcisce (global fetch, 0 retry, no undici Agent) → recall morto dopo ore.
+ store fatti-piatti (no verità canonica), L2/L3 markdown non rankati, deriva linguistica, zero test e2e/osservabilità.

## Blueprint: docs/ENTITY_CORE_BLUEPRINT.md (schema, merge deterministico, retrieval, migrazione, roadmap, decisioni)

## Stato gateway
HEALTHY — PID 40524, codice embedding-resilient live. /health onesto (embed ping reale, 503 se degraded).
Kimi: NON più sospeso (ricaricato). Embedding OpenAI: testato OK; recall fresco a cosine 0.84-0.93.

## Track A (stabilizzazione)
- A1 FATTO + committato (b96590e su branch feat/memory-excellence): undici Agent + retry su socket fresco + circuit breaker; /health reale; timeout HTTP gateway. Verificato live.
- A3 (watchdog/restart-on-hang): priorità BASSA ora (il client si auto-ripara). Follow-up.
- A5 reindex vettori corrotti: assorbito dalla migrazione Track B (re-extract da L0).

## Track B (eccellenza, entity-centric) — ROADMAP (vedi blueprint)
P0 eval harness | P1 schema+store (IN CORSO, lo-database-architect) | P2 single-extraction+upsert deterministico | P3 migrazione re-extract da L0 | P4 retrieval+rerank | P5 proiezioni L2/L3 deterministiche | P6 cutover+retire L1+maintenance | P7 (opt) cross-encoder locale.

## Decisioni open-questions (prese): namespace globale + tag project; rerank flag default OFF; persona allow-list fissa; L1 read-only 1 release; L0-completeness check in P3; persist source_message_ids.

## Branch: feat/memory-excellence (A1 = b96590e). Backup .backup/vectors-20260616-0241.db INTATTO.

## Regole: backup prima di op distruttive; NON ricompilare vec0.dll; NON push su main (feature branch→PR); SOLO eccellenza.
```

</details>

---

## docs/superpowers/plans/2026-06-29-grounded-trust-phase1-provenance.md (archiviato 2026-07-18)

**Verdetto:** SUPERATO. **Perché:** piano-checklist TDD per Grounded Trust Fase 1 (provenance/trust model) — eseguito per intero (commit `b805f60`/`e036912`/`afb0c27`/`75a497d`); `provenance.ts` esiste, Fase 1 confermata IMPLEMENTED nel design doc gemello (altra voce di questo storico). Ignorato da `.gitignore` (`docs/superpowers/*`), mai stato in git → contenuto integrale sotto, in 3 parti.

**Fatti da tenere:** il piano task-by-task (checkbox) copre: modello di trust (`provenance.ts`), stamping a write-time in `applyKbDelta`, hook `confirmMemory` (upgrade a "trusted" + audit trail), e un test di regressione che blocca ogni futura modifica che faccia "trust gate injection" invece di "trust gate action" — il principio cardine del pilastro Grounded Trust.

<details>
<summary>Contenuto integrale (mai versionato, gitignored — parte 1/3, Task 1-2)</summary>

```markdown
# Grounded Trust — Phase 1: Provenance & Trust foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp every conversation-extracted memory unit (fact/event) with a provenance + trust mark (default `unverified`) at write time, and provide a `confirmMemory` upgrade hook — without changing any recall/injection behaviour.

**Architecture:** Reuse the existing "living layer" `memory_lifecycle.provenance_json` (today always `'{}'`) as the home for the stamp, and `memory_audit` for the upgrade trail. A new pure module `provenance.ts` owns the trust model. `applyKbDelta` (the single KB write path) stamps each new fact/event via a new store primitive `stampProvenance`. A `confirmMemory` primitive flips the stamp to `trusted`, raises the fact's confidence, optionally supersedes the uncertain fact, and writes one audit row. Trust gates ACTION (later phases), never INJECTION.

**Tech Stack:** TypeScript, Node `node:sqlite` (`DatabaseSync`), Zod v4, Vitest. Spec: `docs/superpowers/specs/2026-06-29-grounded-trust-phase1-provenance-design.md`.

---

## File structure

- **Create** `src/core/kb/provenance.ts` — the trust model: `ProvenanceStamp` type, Zod schema, `defaultProvenance()`, `deriveTrust()`, `parseProvenance()` (tolerant), `serializeProvenance()`. Pure, no DB.
- **Create** `src/core/kb/__tests__/provenance.test.ts` — unit tests for the model.
- **Modify** `src/core/kb/lifecycle-writer.ts` — add `confirmProvenance(db, params)` (flip stamp → trusted + audit row).
- **Modify** `src/core/store/sqlite.ts` — add two `VectorStore` methods: `stampProvenance(...)` (write-time stamp via `ensureLifecycle` with provenance) and `confirmMemory(...)` (orchestrate the upgrade across `memory_lifecycle` + `facts`).
- **Modify** `src/core/kb/kb-writer.ts` — add `stampProvenance` to the `KbWriterStore` interface and call it for every inserted event/fact inside `applyKbDelta`.
- **Create** `src/core/kb/__tests__/provenance-write-stamp.test.ts` — real-DB test: a freshly written fact/event has `trust=unverified`.
- **Create** `src/core/store/__tests__/confirm-memory.test.ts` — real-DB test: `confirmMemory` flips to trusted, writes one audit row, raises confidence, supersedes when asked.
- **Create** `src/core/kb/__tests__/provenance-injection-unchanged.test.ts` — regression: injection unchanged for an unverified memory.

---

## Task 1: The trust model (`provenance.ts`)

**Files:**
- Create: `src/core/kb/provenance.ts`
- Test: `src/core/kb/__tests__/provenance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/kb/__tests__/provenance.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  defaultProvenance,
  deriveTrust,
  parseProvenance,
  serializeProvenance,
  type ProvenanceStamp,
} from "../provenance.js";

describe("provenance model", () => {
  it("defaultProvenance is conversation/unverified and carries source ids", () => {
    const p = defaultProvenance(["l0_a", "l0_b"]);
    expect(p.origin).toBe("conversation");
    expect(p.trust).toBe("unverified");
    expect(p.confirmed_by).toBeNull();
    expect(p.source_message_ids).toEqual(["l0_a", "l0_b"]);
    expect(p.schema).toBe(1);
  });

  it("deriveTrust: only lorenzo_confirmed and authoritative_source are trusted", () => {
    expect(deriveTrust("conversation")).toBe("unverified");
    expect(deriveTrust("tool_output")).toBe("unverified");
    expect(deriveTrust("lorenzo_confirmed")).toBe("trusted");
    expect(deriveTrust("authoritative_source")).toBe("trusted");
  });

  it("parseProvenance tolerates legacy '{}' → conversation/unverified", () => {
    const p = parseProvenance("{}");
    expect(p.origin).toBe("conversation");
    expect(p.trust).toBe("unverified");
  });

  it("parseProvenance tolerates garbage → conversation/unverified (never throws)", () => {
    const p = parseProvenance("not json at all");
    expect(p.origin).toBe("conversation");
    expect(p.trust).toBe("unverified");
  });

  it("serialize → parse round-trips a trusted stamp", () => {
    const stamp: ProvenanceStamp = {
      origin: "lorenzo_confirmed",
      trust: "trusted",
      confirmed_by: "lorenzo",
      confirmed_at: "2026-06-29T10:00:00.000Z",
      source_message_ids: ["l0_x"],
      schema: 1,
    };
    const back = parseProvenance(serializeProvenance(stamp));
    expect(back).toEqual(stamp);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/kb/__tests__/provenance.test.ts`
Expected: FAIL — `Cannot find module '../provenance.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/kb/provenance.ts`:

```typescript
/**
 * provenance.ts — the trust model for Grounded Trust (Phase 1).
 *
 * Every memory unit (fact/event) carries a provenance stamp in
 * memory_lifecycle.provenance_json. Trust is DERIVED from origin and defaults to
 * "unverified" (conservative: unknown origin = untrusted). Trust gates ACTION in
 * later phases, never injection. Parsing is tolerant: a legacy "{}" or any
 * malformed value degrades to conversation/unverified and NEVER throws into a
 * turn.
 */
import { z } from "zod";

export type ProvenanceOrigin =
  | "conversation"
  | "tool_output"
  | "lorenzo_confirmed"
  | "authoritative_source";

export type TrustLevel = "unverified" | "trusted";

export interface ProvenanceStamp {
  origin: ProvenanceOrigin;
  trust: TrustLevel;
  confirmed_by: "lorenzo" | null;
  confirmed_at: string | null;
  source_message_ids: string[];
  schema: 1;
}

/** Origins that earn trust. Everything else is unverified (conservative default). */
const TRUSTED_ORIGINS: ReadonlySet<ProvenanceOrigin> = new Set([
  "lorenzo_confirmed",
  "authoritative_source",
]);

export function deriveTrust(origin: ProvenanceOrigin): TrustLevel {
  return TRUSTED_ORIGINS.has(origin) ? "trusted" : "unverified";
}

const STAMP_SCHEMA = z.object({
  origin: z.enum(["conversation", "tool_output", "lorenzo_confirmed", "authoritative_source"]),
  trust: z.enum(["unverified", "trusted"]),
  confirmed_by: z.union([z.literal("lorenzo"), z.null()]).default(null),
  confirmed_at: z.union([z.string(), z.null()]).default(null),
  source_message_ids: z.array(z.string()).default([]),
  schema: z.literal(1).default(1),
});

/** A fresh stamp for conversation-extracted memory: conversation / unverified. */
export function defaultProvenance(sourceMessageIds: string[] = []): ProvenanceStamp {
  return {
    origin: "conversation",
    trust: deriveTrust("conversation"),
    confirmed_by: null,
    confirmed_at: null,
    source_message_ids: [...sourceMessageIds],
    schema: 1,
  };
}

export function serializeProvenance(stamp: ProvenanceStamp): string {
  return JSON.stringify(stamp);
}

/**
 * Parse a provenance_json string. Tolerant by design: legacy "{}", missing
 * fields, or non-JSON all degrade to conversation/unverified. Never throws.
 */
export function parseProvenance(json: string | null | undefined): ProvenanceStamp {
  if (!json) return defaultProvenance();
  try {
    const raw = JSON.parse(json) as unknown;
    const parsed = STAMP_SCHEMA.safeParse(raw);
    if (!parsed.success) return defaultProvenance();
    // Re-derive trust from origin so a tampered/legacy trust value can't lie.
    return { ...parsed.data, trust: deriveTrust(parsed.data.origin) };
  } catch {
    return defaultProvenance();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/kb/__tests__/provenance.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/core/kb/provenance.ts src/core/kb/__tests__/provenance.test.ts
git commit -m "feat(grounded-trust): provenance trust model (Phase 1)"
```

---

## Task 2: Stamp provenance at write time

**Files:**
- Modify: `src/core/store/sqlite.ts` (add `stampProvenance` method on `VectorStore`)
- Modify: `src/core/kb/kb-writer.ts` (add `stampProvenance` to `KbWriterStore`; call it in `applyKbDelta`)
- Test: `src/core/kb/__tests__/provenance-write-stamp.test.ts`

```

</details>

<details>
<summary>Contenuto integrale (mai versionato, gitignored — parte 2/3, Task 2-3)</summary>

```markdown
## Task 2 (continua): Stamp provenance at write time

- [ ] **Step 1: Write the failing test**

Create `src/core/kb/__tests__/provenance-write-stamp.test.ts`. This drives the REAL `applyKbDelta` against a real temp `VectorStore` and asserts the lifecycle row for each new event carries `trust=unverified`.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { applyKbDelta } from "../kb-writer.js";
import { getLifecycle } from "../lifecycle-writer.js";
import { parseProvenance } from "../provenance.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("provenance is stamped at KB write time", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-prov-stamp-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("a freshly written event is stamped conversation/unverified", async () => {
    const result = await applyKbDelta(
      {
        language: "it",
        entities: [{ ref: "e1", type: "person", name: "Lorenzo" }],
        events: [{ ref: "ev1", type: "decision", ts: "2026-06-29T10:00:00.000Z",
                   text: "Decisione presa insieme.", entity_refs: ["e1"],
                   source_message_ids: ["l0_m1"] }],
        facts: [],
        relations: [],
      } as never,
      { store: store as never, namespace: "default", sessionKey: "s1",
        now: "2026-06-29T10:00:00.000Z", logger: silent },
    );

    const ev = result.events[0]!;
    const life = getLifecycle((store as never as { db: never }).db, ev.id, "event");
    expect(life, "lifecycle row must exist for the new event").not.toBeNull();
    const prov = parseProvenance(life!.provenance_json);
    expect(prov.origin).toBe("conversation");
    expect(prov.trust).toBe("unverified");
    expect(prov.source_message_ids).toEqual(["l0_m1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/kb/__tests__/provenance-write-stamp.test.ts`
Expected: FAIL — the lifecycle row is null (not created at write time) / `stampProvenance` is not a function.

- [ ] **Step 3a: Add `stampProvenance` to `VectorStore`**

In `src/core/store/sqlite.ts`, add the imports (top of file, with the other imports):

```typescript
import { ensureLifecycle } from "../kb/lifecycle-writer.js";
import { serializeProvenance, type ProvenanceStamp } from "../kb/provenance.js";
```

Add this method to the `VectorStore` class (near the other KB write methods; uses the existing `this.db`):

```typescript
  /**
   * Stamp a memory unit's provenance at write time by creating its
   * memory_lifecycle row WITH the stamp (idempotent: if the row already exists it
   * is left untouched, so consolidation's later ensureLifecycle never clobbers it).
   * Off the critical path: failures are swallowed + logged, never thrown.
   */
  stampProvenance(
    ownerId: string,
    ownerKind: "fact" | "event",
    provenance: ProvenanceStamp,
    now: string,
    namespace = "default",
  ): void {
    try {
      ensureLifecycle(this.db, {
        ownerId,
        ownerKind,
        now,
        namespace,
        provenance: JSON.parse(serializeProvenance(provenance)),
      });
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][provenance] stamp failed for ${ownerKind} ${ownerId} (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
```

- [ ] **Step 3b: Extend `KbWriterStore` and call the stamp in `applyKbDelta`**

In `src/core/kb/kb-writer.ts`:

Add the import near the top:

```typescript
import { defaultProvenance } from "./provenance.js";
```

Add to the `KbWriterStore` interface (after `upsertKbFts`):

```typescript
  stampProvenance(
    ownerId: string,
    ownerKind: "fact" | "event",
    provenance: import("./provenance.js").ProvenanceStamp,
    now: string,
    namespace?: string,
  ): void;
```

In `applyKbDelta`, after the event is inserted (right after `events.push(inserted);`, inside the events loop):

```typescript
    store.stampProvenance(
      inserted.id,
      "event",
      defaultProvenance(ev.source_message_ids ?? []),
      now,
      namespace,
    );
```

And after the fact is upserted (right after `facts.push(fact);`, inside the facts loop):

```typescript
    store.stampProvenance(fact.id, "fact", defaultProvenance(), now, namespace);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/kb/__tests__/provenance-write-stamp.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the broader store + kb suites to confirm no regression**

Run: `npx vitest run src/core/kb src/core/store`
Expected: PASS (pre-existing unrelated failures, if any, must match the baseline — do NOT fix here).

- [ ] **Step 6: Commit**

```bash
git add src/core/store/sqlite.ts src/core/kb/kb-writer.ts src/core/kb/__tests__/provenance-write-stamp.test.ts
git commit -m "feat(grounded-trust): stamp provenance at KB write time (Phase 1)"
```

---

## Task 3: The `confirmMemory` upgrade hook

**Files:**
- Modify: `src/core/kb/lifecycle-writer.ts` (add `confirmProvenance`)
- Modify: `src/core/store/sqlite.ts` (add `confirmMemory` method orchestrating lifecycle + facts)
- Test: `src/core/store/__tests__/confirm-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/store/__tests__/confirm-memory.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import { getLifecycle } from "../../kb/lifecycle-writer.js";
import { parseProvenance, defaultProvenance } from "../../kb/provenance.js";

describe("confirmMemory upgrades trust and records the trail", () => {
  let dir: string;
  let store: VectorStore;
  const now = "2026-06-29T12:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-confirm-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    // Seed: a lifecycle row for an event, stamped unverified.
    store.stampProvenance("ev-1", "event", defaultProvenance(["l0_1"]), now);
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("flips provenance to trusted and writes exactly one audit row (actor=user)", () => {
    const db = (store as never as { db: never }).db;

    store.confirmMemory({ ownerId: "ev-1", ownerKind: "event", now: "2026-06-29T13:00:00.000Z" });

    const life = getLifecycle(db, "ev-1", "event");
    const prov = parseProvenance(life!.provenance_json);
    expect(prov.origin).toBe("lorenzo_confirmed");
    expect(prov.trust).toBe("trusted");
    expect(prov.confirmed_by).toBe("lorenzo");
    expect(prov.confirmed_at).toBe("2026-06-29T13:00:00.000Z");

    const audit = (db as unknown as {
      prepare: (s: string) => { all: (...a: unknown[]) => unknown[] };
    })
      .prepare("SELECT operation, actor FROM memory_audit WHERE owner_id = ? AND owner_kind = ?")
      .all("ev-1", "event") as Array<{ operation: string; actor: string }>;
    const confirmRows = audit.filter((r) => r.operation === "confirm");
    expect(confirmRows).toHaveLength(1);
    expect(confirmRows[0]!.actor).toBe("user");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/store/__tests__/confirm-memory.test.ts`
Expected: FAIL — `store.confirmMemory is not a function`.

- [ ] **Step 3a: Add `confirmProvenance` to `lifecycle-writer.ts`**

Add to `src/core/kb/lifecycle-writer.ts` (it already imports `recordAudit`; add the provenance import at the top):

```typescript
import { parseProvenance, serializeProvenance, deriveTrust } from "./provenance.js";

export interface ConfirmProvenanceParams {
  ownerId: string;
  ownerKind: string;
  now: string;
}

/**
 * Flip a memory unit's provenance stamp to lorenzo_confirmed/trusted and write one
 * audit row (operation="confirm", actor="user"). Creates the lifecycle row first if
 * missing. Returns the updated row, or null if absent after.
 */
export function confirmProvenance(
  db: DatabaseSync,
  p: ConfirmProvenanceParams,
): LifecycleRow | null {
  const cur = ensureLifecycle(db, { ownerId: p.ownerId, ownerKind: p.ownerKind, now: p.now });
  const before = parseProvenance(cur.provenance_json);
  const after = {
    ...before,
    origin: "lorenzo_confirmed" as const,
    trust: deriveTrust("lorenzo_confirmed"),
    confirmed_by: "lorenzo" as const,
    confirmed_at: p.now,
  };
  db.prepare(
    `UPDATE memory_lifecycle SET provenance_json = ?, updated_time = ?
       WHERE owner_id = ? AND owner_kind = ?`,
  ).run(serializeProvenance(after), p.now, p.ownerId, p.ownerKind);

  recordAudit(
    db,
    {
      ownerId: p.ownerId,
      ownerKind: p.ownerKind,
      operation: "confirm",
      actor: "user",
      before: { trust: before.trust, origin: before.origin },
      after: { trust: after.trust, origin: after.origin },
      reason: "confirmed by Lorenzo",
      namespace: cur.namespace,
    },
    p.now,
  );
  return getLifecycle(db, p.ownerId, p.ownerKind);
}
```

```

</details>

<details>
<summary>Contenuto integrale (mai versionato, gitignored — parte 3/3, Task 3 fine + Task 4-5 + self-review)</summary>

```markdown
## Task 3 (continua): `confirmMemory` on `VectorStore`

- [ ] **Step 3b: Add `confirmMemory` to `VectorStore`**

In `src/core/store/sqlite.ts`, add the import:

```typescript
import { confirmProvenance } from "../kb/lifecycle-writer.js";
```

Add this method. The body MUST be wrapped in a BEGIN / COMMIT / ROLLBACK transaction using the EXACT same idiom already used by `reindexAll()` in this same file (begin a transaction on `this.db`, commit at the end, roll back inside a catch on throw), and the whole thing inside the outer try/catch shown here that swallows + warns (memory must never break a turn):

```typescript
  /**
   * Confirm a memory as ground truth (Lorenzo said so). Flips its provenance to
   * trusted + writes the audit trail. When a `factId` is given, raises that fact's
   * confidence; when a `supersededFactId` is given, closes that older uncertain
   * fact (sets superseded_by + valid_to so it leaves the HEAD set). One transaction.
   */
  confirmMemory(params: {
    ownerId: string;
    ownerKind: "fact" | "event";
    now: string;
    factId?: string;
    confidence?: number;
    supersededFactId?: string;
  }): void {
    try {
      // <begin transaction on this.db — same idiom as reindexAll()>
      confirmProvenance(this.db, {
        ownerId: params.ownerId,
        ownerKind: params.ownerKind,
        now: params.now,
      });
      if (params.factId) {
        this.db
          .prepare("UPDATE facts SET confidence = ?, updated_time = ? WHERE id = ?")
          .run(params.confidence ?? 0.99, params.now, params.factId);
      }
      if (params.supersededFactId) {
        this.db
          .prepare(
            "UPDATE facts SET superseded_by = ?, superseded_at = ?, valid_to = ? WHERE id = ?",
          )
          .run(params.factId ?? params.ownerId, params.now, params.now, params.supersededFactId);
      }
      // <commit transaction; on any throw above, roll back then rethrow into the catch>
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][provenance] confirmMemory failed for ${params.ownerKind} ${params.ownerId} ` +
          `(non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
```

> NOTE: `facts` has columns `id`, `confidence`, `superseded_by`, `superseded_at`, `valid_to`, `updated_time` (verified in the `facts` DDL in `src/core/store/sqlite.ts`). Match the real column names from that DDL; do not invent.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/store/__tests__/confirm-memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/kb/lifecycle-writer.ts src/core/store/sqlite.ts src/core/store/__tests__/confirm-memory.test.ts
git commit -m "feat(grounded-trust): confirmMemory upgrade hook + audit trail (Phase 1)"
```

---

## Task 4: Regression guard — injection is unchanged for unverified memory

**Files:**
- Test: `src/core/kb/__tests__/provenance-injection-unchanged.test.ts`

This locks the core principle: trust gates ACTION, not INJECTION. An `unverified` stamp must not alter recall output.

- [ ] **Step 1: Write the test**

Create `src/core/kb/__tests__/provenance-injection-unchanged.test.ts` (recall harness mirrors `src/core/hooks/__tests__/auto-recall-escape.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { performAutoRecall } from "../../hooks/auto-recall.js";
import { parseConfig } from "../../../config.js";
import { defaultProvenance } from "../provenance.js";
import type { EmbeddingService } from "../../store/embedding.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const vec = new Float32Array([1, 0, 0, 0]);
const emb = { embed: async () => vec, getDimensions: () => 4 } as unknown as EmbeddingService;
const cfg = parseConfig({ recall: { strategy: "embedding", maxResults: 5, scoreThreshold: 0.1 } } as never);

function seedOneL1(store: VectorStore, sessionKey: string) {
  const now = new Date().toISOString();
  store.upsertL1(
    { id: "mem-1", content: "Un ricordo qualunque.", type: "episodic", priority: 50,
      scene_name: "x", source_message_ids: ["m1"], metadata: {}, timestamps: [now],
      createdAt: now, updatedAt: now, sessionKey, sessionId: "sid" } as never,
    vec,
  );
}

async function recallText(dir: string, store: VectorStore): Promise<string> {
  const r = await performAutoRecall({
    userText: "ricordo", actorId: "a", sessionKey: "s", cfg, pluginDataDir: dir,
    logger: silent, vectorStore: store, embeddingService: emb,
  });
  return (r?.prependContext ?? "") + "\n" + (r?.appendSystemContext ?? "");
}

describe("trust gates action, not injection", () => {
  it("an unverified stamp does not change recall output", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-inj-a-"));
    const a = new VectorStore(path.join(dirA, "vectors.db"), 4);
    a.init({ provider: "openai", model: "text-embedding-3-small" });
    seedOneL1(a, "s");
    const baseline = await recallText(dirA, a);
    a.close(); fs.rmSync(dirA, { recursive: true, force: true });

    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-inj-b-"));
    const b = new VectorStore(path.join(dirB, "vectors.db"), 4);
    b.init({ provider: "openai", model: "text-embedding-3-small" });
    seedOneL1(b, "s");
    b.stampProvenance("mem-1", "fact", defaultProvenance(["m1"]), new Date().toISOString());
    const stamped = await recallText(dirB, b);
    b.close(); fs.rmSync(dirB, { recursive: true, force: true });

    expect(stamped).toBe(baseline);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/core/kb/__tests__/provenance-injection-unchanged.test.ts`
Expected: PASS. If it FAILS, the stamp leaked into recall — STOP and investigate (the principle is violated); do NOT "adjust the test".

- [ ] **Step 3: Commit**

```bash
git add src/core/kb/__tests__/provenance-injection-unchanged.test.ts
git commit -m "test(grounded-trust): lock 'trust gates action, not injection' (Phase 1)"
```

---

## Task 5: Full verification

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: `Build complete`.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all green EXCEPT the known pre-existing failures. UPDATE 2026-06-30: after this Phase 1 work the count is **7** failed (was 8) — `consolidation-wiring.test.ts` was a STALE assertion (bgTasks 1→3) and was fixed (commit 43c8f3c). The remaining 7 are `daemon.test.ts` (2) + `hook.test.ts` (5): Windows `chmod`/permission + incomplete-mock failures, unrelated to this work. Any NEW failure beyond those 7 is a regression to fix, never the test.

- [ ] **Step 3: Done**

Phase 1 is complete: new memories carry a real provenance stamp (`trust=unverified`), `confirmMemory` upgrades to `trusted` with an audit trail, and injection is provably unchanged. Phase 2 (the "consequential action" stakes policy) can begin on top. No deploy/gateway restart is required for Phase 1 (no live-path behaviour change); the gateway picks up the new code on its next restart.

---

## Self-review notes (author)

- **Spec coverage:** trust model (Task 1) ✓, conservative default via `deriveTrust` (Task 1) ✓, reuse `memory_lifecycle.provenance_json` (Task 2) ✓, `memory_audit` trail (Task 3) ✓, raise `confidence` + `superseded_by` (Task 3) ✓, "trust gates action not injection" (Task 4) ✓, tolerant parse (Task 1) ✓, out-of-scope items NOT built ✓.
- **Implementation detail to follow (not a placeholder):** the exact insertion spot for the methods in `sqlite.ts` and the transaction idiom — both copy the existing `reindexAll()` pattern in that same file. The `facts` column names come from the verified DDL in `sqlite.ts`.
- **Eager lifecycle creation:** `stampProvenance` now creates the `memory_lifecycle` row at write time (previously created lazily in consolidation). Safe (defaults match; `ensureLifecycle` is idempotent); Task 2 Step 5 + Task 5 Step 2 guard against regressions.
```

</details>

---

## docs/superpowers/plans/2026-06-29-session-continuity-dove-eravamo.md (archiviato 2026-07-18)

**Verdetto:** SUPERATO. **Perché:** piano-checklist TDD per "Dove eravamo" (session-continuity) — eseguito per intero; i moduli `src/core/continuity/recap-*.ts` esistono tutti nel repo (builder/capture/injection/retrieval/selector/types). Ignorato da `.gitignore` (`docs/superpowers/*`), mai stato in git → contenuto integrale sotto, in 4 parti.

**Fatti da tenere:** design "extractive not abstractive" — ogni riga del recap è ancorata a un `source_message_id` reale, mai una sintesi LLM (lezione da un bug di distillazione noto: date sbagliate). Iniettato SOLO al primo turno di sessione (non ad ogni turno, per non bucare la prompt-cache).

<details>
<summary>Contenuto integrale (mai versionato, gitignored — parte 1/4, header + Task 1-2)</summary>

```markdown
# "Dove eravamo" (session-continuity) — Implementation Plan — Phase 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On session open, surface a "Dove eravamo" block for the current project, reconstructed from the previous session's own anchored memory events (decisions/tasks/fixes with provenance) — not from a handoff file.

**Architecture:** Fully gateway-side. At session end (`handleSessionEnd`, AFTER the pipeline flush) a recap builder reads *this session's* events from the KB, selects the "thread" types (`decision`, `task`, `fix`, `result`, `bug`, `config_change`), and writes a first-class `session_recap` `KbEvent` (project derived from those events, `source_message_ids` unioned, anchored). At session open (first turn, gated like the banner) the recall path fetches the latest `session_recap` for the request's `project` and injects a sanitized `<session-recap>` block. Off the critical path; every step try/caught; degrades to no-op when the store lacks the new methods (TCVDB backend).

**Phase 2 (separate plan, NOT here):** enrich the recap with git facts (commits/files/branch) gathered by the cc-plugin SessionEnd hook and passed in an extended `/session/end` payload.

**Tech Stack:** TypeScript (ESM, `.js` import suffix), `node:sqlite` (`DatabaseSync`), vitest (`pool: forks`), existing `IMemoryStore` / `kb-queries` / `escapeXmlTags` patterns.

**Real-data facts (verified 2026-06-29):** events live in `vectors.db` table `events` (455 rows). Columns: `id, ts, recorded_at, session_key, session_id, namespace, project, type, text, language, entities_json, source_message_ids_json`. Type counts: observation 206, decision 82, config_change 55, task 43, fix 33, result 16, bug 16, preference_stated 4.

**Deliberate refinement vs spec §4:** the `<session-recap>` block is injected in the **first-turn (banner) branch** of `performAutoRecall` (prependContext), NOT in the per-turn `stableParts`. Rationale: it is a session-open event like the banner; putting it in stableParts would recompute/re-emit every turn and bust the prompt cache. This is strictly better than the spec and keeps it off the per-turn path.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/core/continuity/recap-types.ts` | Shared types: `ThreadItem`, `RecapInput`, `THREAD_EVENT_TYPES`. |
| `src/core/continuity/recap-builder.ts` | Pure: `buildRecapText(input): string`. Assembles anchored recap; omits unanchored lines; returns `""` when no thread. |
| `src/core/continuity/recap-selector.ts` | Pure: `selectThread(events): RecapInput` — filter session events to thread types, pick next-step, union provenance, derive project. |
| `src/core/continuity/recap-capture.ts` | Glue: `captureSessionRecap({store, sessionKey, now, logger})` — read session events, select, build, `insertEvent`. Fire-and-forget friendly, error-swallowed. |
| `src/core/continuity/recap-retrieval.ts` | `latestRecapBlock({store, project, logger}): string` — fetch latest `session_recap` for project, return injection block or `""`. |
| `src/core/continuity/recap-injection.ts` | Pure: `buildSessionRecapBlock(recapText): string` — wrap in `<session-recap>`, escape via `escapeXmlTags`. Mirror of `cornerstone-injection.ts`. |
| `src/core/store/types.ts` | Add 2 OPTIONAL `IMemoryStore` methods: `listEventsBySession?`, `latestEventByProjectType?`. |
| `src/core/kb/kb-queries.ts` | SQL impls: `listEventsBySession`, `latestEventByProjectType`. |
| `src/core/store/sqlite.ts` | Wire the two store methods to the kb-queries impls (guard `kbReady`). |
| `src/utils/sanitize.ts` | Add `session-recap` to the `escapeXmlTags` allow-list. |
| `src/core/tdai-core.ts` | Call `captureSessionRecap` in `handleSessionEnd` AFTER flush, fire-and-forget via `bgTasks`. |
| `src/core/hooks/auto-recall.ts` | Inject `latestRecapBlock` in the first-turn (banner) branch. |

Tests live in `src/core/continuity/__tests__/` and an integration test in the same folder.

---

## Task 1: Shared types + thread-type constant

**Files:**
- Create: `src/core/continuity/recap-types.ts`
- Test: `src/core/continuity/__tests__/recap-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { THREAD_EVENT_TYPES, isThreadType } from "../recap-types.js";

describe("recap thread types", () => {
  it("includes decision/task/fix/result/bug/config_change, excludes observation", () => {
    expect(isThreadType("decision")).toBe(true);
    expect(isThreadType("task")).toBe(true);
    expect(isThreadType("fix")).toBe(true);
    expect(isThreadType("observation")).toBe(false);
  });
  it("THREAD_EVENT_TYPES is frozen and non-empty", () => {
    expect(THREAD_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(THREAD_EVENT_TYPES)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/core/continuity/__tests__/recap-types.test.ts`
Expected: FAIL — cannot find module `../recap-types.js`.

- [ ] **Step 3: Implement**

```ts
/** Shared types for the "Dove eravamo" session-continuity recap. */

/** Event types that carry the session's "thread" (decisions/why/next), not routine noise. */
export const THREAD_EVENT_TYPES = Object.freeze([
  "decision",
  "task",
  "fix",
  "result",
  "bug",
  "config_change",
] as const);

export function isThreadType(type: string): boolean {
  return (THREAD_EVENT_TYPES as readonly string[]).includes(type);
}

/** A single anchored line of the recap thread. */
export interface ThreadItem {
  readonly type: string;
  readonly text: string;
  /** Provenance message ids for this item (anchor). Empty → item is dropped upstream. */
  readonly sourceMessageIds: readonly string[];
}

/** Everything the recap builder needs (Phase 1: no git facts yet). */
export interface RecapInput {
  readonly project: string;
  readonly sessionDateIso: string;
  /** The explicit next step, if one was found (anchored). */
  readonly nextStep?: ThreadItem;
  /** The thread items, most-recent-last. */
  readonly thread: readonly ThreadItem[];
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/core/continuity/__tests__/recap-types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/continuity/recap-types.ts src/core/continuity/__tests__/recap-types.test.ts
git commit -m "feat(continuity): recap shared types + thread-type filter"
```

---

## Task 2: recap-builder (pure, anchored text)

**Files:**
- Create: `src/core/continuity/recap-builder.ts`
- Test: `src/core/continuity/__tests__/recap-builder.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildRecapText } from "../recap-builder.js";
import type { RecapInput } from "../recap-types.js";

const base: RecapInput = {
  project: "tencentdb-agent-memory",
  sessionDateIso: "2026-06-29T12:00:00.000Z",
  nextStep: { type: "task", text: "Wire scorer live with per-session cache", sourceMessageIds: ["m1"] },
  thread: [
    { type: "decision", text: "Chose approach B: anchored recap", sourceMessageIds: ["m2"] },
    { type: "fix", text: "Record injection AFTER block built", sourceMessageIds: ["m3"] },
  ],
};

describe("buildRecapText", () => {
  it("emits a project+date header, next-step, and anchored thread lines", () => {
    const out = buildRecapText(base);
    expect(out).toContain("DOVE ERAVAMO — tencentdb-agent-memory");
    expect(out).toContain("Prossimo passo: Wire scorer live");
    expect(out).toContain("Chose approach B");
    expect(out).toContain("[anchor: msg m2]");
  });
  it("drops thread items with no source message ids (every line anchored)", () => {
    const out = buildRecapText({
      ...base,
      thread: [{ type: "decision", text: "unanchored", sourceMessageIds: [] }],
    });
    expect(out).not.toContain("unanchored");
  });
  it("returns empty string when there is no next-step and no thread", () => {
    expect(buildRecapText({ ...base, nextStep: undefined, thread: [] })).toBe("");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/core/continuity/__tests__/recap-builder.test.ts`
Expected: FAIL — cannot find module `../recap-builder.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * recap-builder — pure assembly of the "Dove eravamo" recap text.
 *
 * Every emitted line is anchored: thread items without provenance are dropped
 * (determinism over completeness). Returns "" when nothing anchorable remains.
 * Immutable: builds a new string, never mutates the input.
 */
import type { RecapInput, ThreadItem } from "./recap-types.js";

const MAX_THREAD = 6;
const MAX_TEXT = 240;

function anchorOf(item: ThreadItem): string | null {
  const ids = item.sourceMessageIds.filter((s) => typeof s === "string" && s.length > 0);
  return ids.length > 0 ? ids.join(",") : null;
}

function line(item: ThreadItem): string | null {
  const anchor = anchorOf(item);
  if (!anchor) return null;
  const text = item.text.trim().slice(0, MAX_TEXT);
  if (!text) return null;
  return `- (${item.type}) ${text}   [anchor: msg ${anchor}]`;
}

export function buildRecapText(input: RecapInput): string {
  const threadLines = input.thread
    .map(line)
    .filter((l): l is string => l !== null)
    .slice(-MAX_THREAD);

  const nextStepLine = input.nextStep ? line(input.nextStep) : null;

  if (!nextStepLine && threadLines.length === 0) return "";

  const date = input.sessionDateIso.slice(0, 10);
  const out: string[] = [`DOVE ERAVAMO — ${input.project} (${date})`, ""];

  if (nextStepLine) {
    out.push("PROSSIMO PASSO:");
    // Reuse the anchored formatting but with the friendlier label.
    out.push(nextStepLine.replace(/^- \([^)]*\) /, "- Prossimo passo: "));
    out.push("");
  }

  if (threadLines.length > 0) {
    out.push("FILO (ricostruito dalle nostre parole reali):");
    out.push(...threadLines);
  }

  return out.join("\n").trimEnd();
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/core/continuity/__tests__/recap-builder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/continuity/recap-builder.ts src/core/continuity/__tests__/recap-builder.test.ts
git commit -m "feat(continuity): pure anchored recap text builder"
```
```

</details>

<details>
<summary>Contenuto integrale (mai versionato, gitignored — parte 2/4, Task 3-5)</summary>

```markdown
## Task 3: recap-selector (session events → RecapInput)

**Files:**
- Create: `src/core/continuity/recap-selector.ts`
- Test: `src/core/continuity/__tests__/recap-selector.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { selectThread } from "../recap-selector.js";
import type { KbEvent } from "../../store/types.js";

function evt(p: Partial<KbEvent>): KbEvent {
  return {
    id: "evt_x", ts: "2026-06-29T10:00:00.000Z", recorded_at: "2026-06-29T10:00:00.000Z",
    session_key: "s", session_id: "sid", namespace: "default", project: "proj",
    type: "observation", text: "t", language: "it", entities: [], source_message_ids: [],
    ...p,
  };
}

describe("selectThread", () => {
  it("keeps thread types, drops observations, derives project, picks latest task/decision as next-step", () => {
    const events: KbEvent[] = [
      evt({ id: "e1", type: "observation", text: "noise", source_message_ids: ["m0"] }),
      evt({ id: "e2", type: "decision", text: "chose B", source_message_ids: ["m1"], ts: "2026-06-29T10:01:00.000Z" }),
      evt({ id: "e3", type: "task", text: "next thing", source_message_ids: ["m2"], ts: "2026-06-29T10:02:00.000Z" }),
    ];
    const input = selectThread(events, "2026-06-29T10:02:00.000Z");
    expect(input.project).toBe("proj");
    expect(input.thread.map((t) => t.text)).not.toContain("noise");
    expect(input.thread.map((t) => t.text)).toContain("chose B");
    expect(input.nextStep?.text).toBe("next thing");
  });
  it("returns empty thread when only observations exist", () => {
    const input = selectThread([evt({ type: "observation", source_message_ids: ["m0"] })], "2026-06-29T10:00:00.000Z");
    expect(input.thread).toHaveLength(0);
    expect(input.nextStep).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/core/continuity/__tests__/recap-selector.test.ts`
Expected: FAIL — cannot find module `../recap-selector.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * recap-selector — pure transform of a session's KB events into a RecapInput.
 *
 * Filters to thread-bearing types, derives the project (most common non-empty),
 * unions provenance, and picks the most recent `task` or `decision` as the
 * explicit next-step. Immutable: reads the input array, returns a new object.
 */
import type { KbEvent } from "../store/types.js";
import { isThreadType, type RecapInput, type ThreadItem } from "./recap-types.js";

const NEXT_STEP_TYPES = new Set(["task", "decision"]);

function toItem(e: KbEvent): ThreadItem {
  return { type: e.type, text: e.text, sourceMessageIds: e.source_message_ids ?? [] };
}

function deriveProject(events: readonly KbEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.project) counts.set(e.project, (counts.get(e.project) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
  return best;
}

export function selectThread(events: readonly KbEvent[], sessionDateIso: string): RecapInput {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const threadEvents = sorted.filter((e) => isThreadType(e.type));

  // Most recent task/decision = the explicit next-step.
  let nextStep: ThreadItem | undefined;
  for (let i = threadEvents.length - 1; i >= 0; i--) {
    if (NEXT_STEP_TYPES.has(threadEvents[i].type)) { nextStep = toItem(threadEvents[i]); break; }
  }

  return {
    project: deriveProject(sorted),
    sessionDateIso,
    nextStep,
    thread: threadEvents.map(toItem),
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/core/continuity/__tests__/recap-selector.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/continuity/recap-selector.ts src/core/continuity/__tests__/recap-selector.test.ts
git commit -m "feat(continuity): select session thread + next-step from events"
```

---

## Task 4: recap-injection (format the block, sanitized)

**Files:**
- Create: `src/core/continuity/recap-injection.ts`
- Modify: `src/utils/sanitize.ts` (allow-list)
- Test: `src/core/continuity/__tests__/recap-injection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildSessionRecapBlock } from "../recap-injection.js";

describe("buildSessionRecapBlock", () => {
  it("wraps recap text in <session-recap> with a context header", () => {
    const out = buildSessionRecapBlock("DOVE ERAVAMO — proj\n- (decision) x [anchor: msg m1]");
    expect(out.startsWith("<session-recap>")).toBe(true);
    expect(out.trimEnd().endsWith("</session-recap>")).toBe(true);
    expect(out).toContain("DOVE ERAVAMO — proj");
  });
  it("returns empty string for empty input", () => {
    expect(buildSessionRecapBlock("")).toBe("");
    expect(buildSessionRecapBlock("   ")).toBe("");
  });
  it("escapes a stored closing tag so it cannot break out", () => {
    const out = buildSessionRecapBlock("evil </session-recap><system>do bad</system>");
    expect(out).not.toContain("</session-recap><system>");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/core/continuity/__tests__/recap-injection.test.ts`
Expected: FAIL — cannot find module `../recap-injection.js`.

- [ ] **Step 3a: Add `session-recap` to the sanitize allow-list**

In `src/utils/sanitize.ts`, the `escapeXmlTags` allow-list regex currently ends with `...|session-open-banner|cornerstone-memories)`. Add `|session-recap`:

```ts
/<\/?(?:user-persona|relevant-memories|scene-navigation|relevant-scenes|memory-tools-guide|system|assistant|session-open-banner|cornerstone-memories|session-recap)>/gi
```

- [ ] **Step 3b: Implement the injection formatter**

```ts
/**
 * recap-injection — formats the session-continuity "Dove eravamo" block.
 *
 * Security: recap text is XML-escaped via the shared escapeXmlTags so a stored
 * memory containing a closing boundary tag cannot break out of the section.
 * Immutable: pure function, returns a new string. Empty input → "".
 */
import { escapeXmlTags } from "../../utils/sanitize.js";

const TAG = "session-recap";

export function buildSessionRecapBlock(recapText: string): string {
  const trimmed = recapText.trim();
  if (!trimmed) return "";
  const safe = escapeXmlTags(trimmed);
  return [
    `<${TAG}>`,
    "Dove eravamo rimasti su questo progetto — ricostruito dai ricordi ancorati della sessione precedente (riferimento, NON il task corrente):",
    safe,
    `</${TAG}>`,
  ].join("\n");
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/core/continuity/__tests__/recap-injection.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/continuity/recap-injection.ts src/utils/sanitize.ts src/core/continuity/__tests__/recap-injection.test.ts
git commit -m "feat(continuity): sanitized <session-recap> injection block"
```

---

## Task 5: store query methods (by session, latest recap by project)

**Files:**
- Modify: `src/core/store/types.ts` (interface, after `listRecentEvents?` at :598)
- Modify: `src/core/kb/kb-queries.ts` (SQL impls)
- Modify: `src/core/store/sqlite.ts` (wire, near `listRecentEvents` at :2875)
- Test: `src/core/continuity/__tests__/recap-store.integration.test.ts`

- [ ] **Step 1: Write the failing integration test (real in-memory sqlite via the store)**

Use the existing store test harness pattern. Inspect a sibling store test (e.g. `src/core/store/__tests__/consolidate-session.test.ts`) for the exact `VectorStore` construction/init used in this repo, and follow it. The behavioral assertions:

```ts
import { describe, it, expect } from "vitest";
// import + init VectorStore exactly as consolidate-session.test.ts does (follow that file)

describe("recap store queries", () => {
  it("listEventsBySession returns only that session's events", () => {
    // insertEvent two events with session_key 's1' and one with 's2'
    // expect store.listEventsBySession!('s1').length === 2
  });
  it("latestEventByProjectType returns the newest matching event", () => {
    // insertEvent two 'session_recap' events for project 'p' with different ts
    // expect store.latestEventByProjectType!('p','session_recap')!.id === <newest id>
  });
});
```

(Write the real construction by copying the harness from the sibling test; do not invent an API.)

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/core/continuity/__tests__/recap-store.integration.test.ts`
Expected: FAIL — `listEventsBySession is not a function`.

- [ ] **Step 3a: Add the optional methods to `IMemoryStore` in `types.ts` (right after `listRecentEvents?` at line 598)**

```ts
  /** All events for a session (chronological). Optional — backends may omit. */
  listEventsBySession?(sessionKey: string): KbEvent[];
  /** Most recent event of a given type for a project, or undefined. Optional. */
  latestEventByProjectType?(project: string, type: string): KbEvent | undefined;
```

- [ ] **Step 3b: Add SQL impls in `kb-queries.ts` (use the existing `mapEventRow` row-mapper already in this file; mirror `listRecentEvents`)**

```ts
export function listEventsBySession(db: DatabaseSync, sessionKey: string): KbEvent[] {
  const rows = db
    .prepare(`SELECT * FROM events WHERE session_key = ? ORDER BY ts ASC`)
    .all(sessionKey) as Record<string, unknown>[];
  return rows.map(mapEventRow);
}

export function latestEventByProjectType(
  db: DatabaseSync,
  project: string,
  type: string,
): KbEvent | undefined {
  const row = db
    .prepare(`SELECT * FROM events WHERE project = ? AND type = ? ORDER BY ts DESC LIMIT 1`)
    .get(project, type) as Record<string, unknown> | undefined;
  return row ? mapEventRow(row) : undefined;
}
```

(If the row-mapper is not exported, follow how `kbListRecentEvents` is imported into `sqlite.ts` — add these two to the same export surface and import them the same way.)

- [ ] **Step 3c: Wire in `sqlite.ts` (right after `listRecentEvents` at line 2878), importing the two new fns alongside `kbListRecentEvents` at the top (around line 64)**

```ts
  /** @see IMemoryStore.listEventsBySession */
  listEventsBySession(sessionKey: string): KbEvent[] {
    if (!this.kbReady) return [];
    return kbListEventsBySession(this.db, sessionKey);
  }

  /** @see IMemoryStore.latestEventByProjectType */
  latestEventByProjectType(project: string, type: string): KbEvent | undefined {
    if (!this.kbReady) return undefined;
    return kbLatestEventByProjectType(this.db, project, type);
  }
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/core/continuity/__tests__/recap-store.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/store/types.ts src/core/kb/kb-queries.ts src/core/store/sqlite.ts src/core/continuity/__tests__/recap-store.integration.test.ts
git commit -m "feat(store): listEventsBySession + latestEventByProjectType queries"
```
```

</details>

<details>
<summary>Contenuto integrale (mai versionato, gitignored — parte 3/4, Task 6-9)</summary>

```markdown
## Task 6: recap-capture (session-end glue)

**Files:**
- Create: `src/core/continuity/recap-capture.ts`
- Test: `src/core/continuity/__tests__/recap-capture.test.ts`

- [ ] **Step 1: Write the failing test (fake store, no real DB)**

```ts
import { describe, it, expect, vi } from "vitest";
import { captureSessionRecap } from "../recap-capture.js";
import type { KbEvent, KbEventInput } from "../../store/types.js";

function evt(p: Partial<KbEvent>): KbEvent {
  return { id: "e", ts: "2026-06-29T10:00:00.000Z", recorded_at: "r", session_key: "s1",
    session_id: "sid", namespace: "default", project: "proj", type: "decision",
    text: "chose B", language: "it", entities: [], source_message_ids: ["m1"], ...p };
}

describe("captureSessionRecap", () => {
  it("inserts a session_recap event built from the session's thread", () => {
    const inserted: KbEventInput[] = [];
    const store = {
      listEventsBySession: () => [evt({}), evt({ id: "e2", type: "task", text: "next", source_message_ids: ["m2"], ts: "2026-06-29T10:05:00.000Z" })],
      insertEvent: (e: KbEventInput) => { inserted.push(e); return evt({}); },
    } as any;
    captureSessionRecap({ store, sessionKey: "s1", now: "2026-06-29T11:00:00.000Z" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].type).toBe("session_recap");
    expect(inserted[0].project).toBe("proj");
    expect(inserted[0].text).toContain("chose B");
    expect(inserted[0].sourceMessageIds).toEqual(expect.arrayContaining(["m1", "m2"]));
  });
  it("does NOT insert when there is no thread (only observations)", () => {
    const insert = vi.fn();
    const store = { listEventsBySession: () => [evt({ type: "observation" })], insertEvent: insert } as any;
    captureSessionRecap({ store, sessionKey: "s1", now: "2026-06-29T11:00:00.000Z" });
    expect(insert).not.toHaveBeenCalled();
  });
  it("never throws when the store lacks listEventsBySession", () => {
    expect(() => captureSessionRecap({ store: {} as any, sessionKey: "s1", now: "n" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/core/continuity/__tests__/recap-capture.test.ts`
Expected: FAIL — cannot find module `../recap-capture.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * recap-capture — session-end glue that turns a finished session into a
 * first-class `session_recap` KbEvent. Reads the session's own events, selects
 * the anchored thread, builds the recap text, and inserts it.
 *
 * Off the critical path: every failure is swallowed (memory must never break
 * the conversation). No-ops when the store lacks the required capabilities.
 */
import type { IMemoryStore } from "../store/types.js";
import { selectThread } from "./recap-selector.js";
import { buildRecapText } from "./recap-builder.js";

const TAG = "[memory-tdai] [continuity]";
const RECAP_TYPE = "session_recap";

interface Logger { debug?: (m: string) => void; warn?: (m: string) => void; }

export function captureSessionRecap(params: {
  store: IMemoryStore;
  sessionKey: string;
  now: string;
  logger?: Logger;
}): void {
  const { store, sessionKey, now, logger } = params;
  try {
    if (!sessionKey) return;
    if (typeof store.listEventsBySession !== "function" || typeof store.insertEvent !== "function") {
      logger?.debug?.(`${TAG} store lacks recap capabilities — skipping capture`);
      return;
    }
    const events = store.listEventsBySession(sessionKey);
    if (events.length === 0) return;

    const input = selectThread(events, now);
    const text = buildRecapText(input);
    if (!text) {
      logger?.debug?.(`${TAG} no anchored thread for session=${sessionKey} — no recap`);
      return;
    }

    const provenance = new Set<string>();
    for (const item of input.thread) for (const id of item.sourceMessageIds) provenance.add(id);
    if (input.nextStep) for (const id of input.nextStep.sourceMessageIds) provenance.add(id);

    store.insertEvent({
      ts: now,
      sessionKey,
      project: input.project,
      type: RECAP_TYPE,
      text,
      sourceMessageIds: [...provenance],
    });
    logger?.debug?.(`${TAG} session_recap captured for project=${input.project} session=${sessionKey}`);
  } catch (err) {
    logger?.warn?.(`${TAG} recap capture failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/core/continuity/__tests__/recap-capture.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/continuity/recap-capture.ts src/core/continuity/__tests__/recap-capture.test.ts
git commit -m "feat(continuity): capture session_recap event at session end"
```

---

## Task 7: recap-retrieval (latest recap → block)

**Files:**
- Create: `src/core/continuity/recap-retrieval.ts`
- Test: `src/core/continuity/__tests__/recap-retrieval.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { latestRecapBlock } from "../recap-retrieval.js";
import type { KbEvent } from "../../store/types.js";

function recapEvt(text: string): KbEvent {
  return { id: "r", ts: "2026-06-29T11:00:00.000Z", recorded_at: "r", session_key: "s",
    session_id: "sid", namespace: "default", project: "proj", type: "session_recap",
    text, language: "it", entities: [], source_message_ids: [] };
}

describe("latestRecapBlock", () => {
  it("returns a <session-recap> block for the latest recap of the project", () => {
    const store = { latestEventByProjectType: (p: string, t: string) =>
      p === "proj" && t === "session_recap" ? recapEvt("DOVE ERAVAMO — proj\n- (decision) x [anchor: msg m1]") : undefined } as any;
    const out = latestRecapBlock({ store, project: "proj" });
    expect(out).toContain("<session-recap>");
    expect(out).toContain("DOVE ERAVAMO — proj");
  });
  it("returns '' when no recap exists or project is empty", () => {
    const store = { latestEventByProjectType: () => undefined } as any;
    expect(latestRecapBlock({ store, project: "proj" })).toBe("");
    expect(latestRecapBlock({ store, project: "" })).toBe("");
  });
  it("returns '' and never throws when store lacks the method", () => {
    expect(latestRecapBlock({ store: {} as any, project: "proj" })).toBe("");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/core/continuity/__tests__/recap-retrieval.test.ts`
Expected: FAIL — cannot find module `../recap-retrieval.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * recap-retrieval — fetch the latest session_recap for a project and format it
 * for injection. Off the critical path: returns "" on any failure.
 */
import type { IMemoryStore } from "../store/types.js";
import { buildSessionRecapBlock } from "./recap-injection.js";

const RECAP_TYPE = "session_recap";

interface Logger { debug?: (m: string) => void; warn?: (m: string) => void; }

export function latestRecapBlock(params: {
  store: IMemoryStore;
  project: string;
  logger?: Logger;
}): string {
  const { store, project, logger } = params;
  try {
    if (!project) return "";
    if (typeof store.latestEventByProjectType !== "function") return "";
    const recap = store.latestEventByProjectType(project, RECAP_TYPE);
    if (!recap) return "";
    return buildSessionRecapBlock(recap.text);
  } catch (err) {
    logger?.warn?.(`[memory-tdai] [continuity] recap retrieval failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/core/continuity/__tests__/recap-retrieval.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/continuity/recap-retrieval.ts src/core/continuity/__tests__/recap-retrieval.test.ts
git commit -m "feat(continuity): retrieve latest recap block for a project"
```

---

## Task 8: Wire capture into `handleSessionEnd`

**Files:**
- Modify: `src/core/tdai-core.ts` (`handleSessionEnd`, after `scheduleConsolidation` block at :439-446)

- [ ] **Step 1: Add the capture call (fire-and-forget, tracked in bgTasks, after the flush)**

In `handleSessionEnd`, AFTER the `scheduleConsolidation({...})` call and BEFORE the per-session state cleanup (`this.injectedFilesBySession.delete(...)`), add. Import `captureSessionRecap` at the top of the file.

```ts
    // "Dove eravamo" — capture this session into a first-class session_recap
    // event (Sinapsys session-continuity). Deferred to a macrotask so the
    // /session/end response flushes first; tracked in bgTasks so destroy()
    // drains it before the DB closes. Errors are swallowed inside.
    if (this.vectorStore) {
      const store = this.vectorStore;
      const task = new Promise<void>((resolve) => {
        setImmediate(() => {
          try {
            captureSessionRecap({ store, sessionKey, now: new Date().toISOString(), logger: this.logger });
          } finally {
            resolve();
          }
        });
      });
      this.bgTasks.add(task);
      void task.then(() => this.bgTasks.delete(task));
    }
```

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: "Build complete" (the pre-existing `build:scripts` tsconfig error is unrelated and may still appear AFTER "Build complete").

- [ ] **Step 3: Commit**

```bash
git add src/core/tdai-core.ts
git commit -m "feat(continuity): capture session_recap on session end (fire-and-forget)"
```

---

## Task 9: Wire injection into `performAutoRecall` (first-turn only)

**Files:**
- Modify: `src/core/hooks/auto-recall.ts` (first-turn banner branch around :368-384; params/destructure around :205-207)

- [ ] **Step 1: Ensure `vectorStore` and `projectName` are in scope (they already are — see :207) and import `latestRecapBlock`**

Add at the top with the other continuity imports:
```ts
import { latestRecapBlock } from "../continuity/recap-retrieval.js";
```

- [ ] **Step 2: Inject the recap inside the first-turn branch, right after the banner is built (after line 380 `bannerEmitted = true;`, still inside the `if (bannerTracker?.pending(bannerKey))` try block)**

```ts
      // "Dove eravamo" — on the first turn, prepend the previous session's
      // anchored recap for THIS project (reconstruction, not a doc dump).
      // Off the critical path: latestRecapBlock returns "" on any failure.
      if (projectName && vectorStore) {
        const recapBlock = latestRecapBlock({ store: vectorStore, project: projectName, logger });
        if (recapBlock) {
          prependContext = prependContext ? `${recapBlock}\n\n${prependContext}` : recapBlock;
        }
      }
```

- [ ] **Step 3: Build + run the continuity suite + the auto-recall suite**

Run: `npm run build`
Expected: "Build complete".
Run: `npx vitest run src/core/continuity src/core/hooks/__tests__/auto-recall`
Expected: all PASS, no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/core/hooks/auto-recall.ts
git commit -m "feat(continuity): inject 'Dove eravamo' recap on session open"
```
```

</details>

<details>
<summary>Contenuto integrale (mai versionato, gitignored — parte 4/4, Task 10-11 + self-review)</summary>

```markdown
## Task 10: Non-circular eval against real handoffs

**Files:**
- Create: `src/core/continuity/__tests__/recap-eval.integration.test.ts`

**Purpose:** prove the recap's extracted next-step is meaningful by comparing against the hand-written `docs/HANDOFF-*.md` next-steps (independent ground truth). This is a *measurement*, not a pass/fail gate on exact text — assert overlap, and `console.log` the comparison for human judgment.

- [ ] **Step 1: Write the eval test**

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { buildRecapText } from "../recap-builder.js";
import { selectThread } from "../recap-selector.js";
// Open the REAL vectors.db (read-only) exactly like distinctiveness-real-vectors.integration.test.ts
// (DatabaseSync with { open: true }, no extension needed for the events table).

const VECTORS_DB = "C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local/vectors.db";
const HANDOFF = "docs/HANDOFF-2026-06-26.md";

describe.runIf(existsSync(VECTORS_DB) && existsSync(HANDOFF))("recap eval vs handoff", () => {
  it("a recent session's thread overlaps the handoff's next-step vocabulary", () => {
    // 1. pick the most recent session_key from events
    // 2. selectThread(its events) → buildRecapText
    // 3. tokenize handoff 'NEXT' lines + recap; assert non-trivial token overlap
    // log both for human inspection
    expect(true).toBe(true); // replace with real overlap assertion once tokens computed
  });
});
```

- [ ] **Step 2: Flesh out the real query + overlap metric** (open db, `SELECT session_key FROM events ORDER BY ts DESC LIMIT 1`, gather that session's events, build recap, compute Jaccard overlap of lowercased word-sets vs the handoff NEXT section; assert overlap > 0.1 and log the numbers). Follow the DB-open pattern from `distinctiveness-real-vectors.integration.test.ts`.

- [ ] **Step 3: Run**

Run: `npx vitest run src/core/continuity/__tests__/recap-eval.integration.test.ts`
Expected: PASS (or SKIP if the db/handoff is absent), with the comparison logged.

- [ ] **Step 4: Commit**

```bash
git add src/core/continuity/__tests__/recap-eval.integration.test.ts
git commit -m "test(continuity): non-circular recap eval vs real handoff next-steps"
```

---

## Task 11: Full verification + live deploy

- [ ] **Step 1: Full build + full continuity suite**

Run: `npm run build && npx vitest run src/core/continuity`
Expected: Build complete; all continuity tests PASS.

- [ ] **Step 2: Regression — run the broader recall/store suites**

Run: `npx vitest run src/core/hooks src/core/store src/utils/__tests__/sanitize* `
Expected: no regressions.

- [ ] **Step 3: Deploy live** (Lorenzo authorizes gateway restart per autonomy mandate)

```bash
# stop + restart the independent gateway so the new dist is loaded
powershell.exe -ExecutionPolicy Bypass -File C:/Users/lo/tdai-gateway/stop-gateway.ps1
powershell.exe -ExecutionPolicy Bypass -File C:/Users/lo/tdai-gateway/start-gateway.ps1
```
Verify `/health` returns `status:ok`, `embedding:ok`.

- [ ] **Step 4: Live smoke test** — end a session, then open a new session in this project; confirm a `<session-recap>` "Dove eravamo" block appears on the first turn. Verify it shows anchored thread lines, not a no-op.

- [ ] **Step 5: Push**

```bash
git push fork feat/memory-excellence
```

---

## Self-Review (done at plan-write time)

- **Spec coverage:** capture (Task 6+8), injection (Task 4+9), first-class atom (Task 6), anchored/omit-unanchored (Task 2), deterministic retrieval no-embeddings (Task 5+7), off-critical-path/error-swallowed (Tasks 6,7,8,9), sanitize allow-list (Task 4), non-circular eval (Task 10). Git facts = explicitly Phase 2 (out of scope, stated). ✓
- **Refinement logged:** injection moved from `stableParts` (spec §4) to the first-turn branch — strictly better (no per-turn cost, no cache-bust). ✓
- **Type consistency:** `RecapInput`/`ThreadItem` defined Task 1, used Tasks 2/3/6; `buildRecapText` (T2), `selectThread` (T3), `buildSessionRecapBlock` (T4), `captureSessionRecap` (T6), `latestRecapBlock` (T7), store `listEventsBySession`/`latestEventByProjectType` (T5) — names consistent across tasks. ✓
- **Known soft spots (honest):** Task 5 test must copy the real `VectorStore` init harness from a sibling store test (not invented); Task 10 step 2 must be fleshed with the real overlap metric. Both flagged inline.
```

</details>

---

## docs/superpowers/plans/2026-07-07-recall-associative-first-A.md (archiviato 2026-07-18)

**Verdetto:** SUPERATO. **Perché:** piano TDD per l'Incremento A del recall associativo-first — costruito e verificato live (`situation-cue.ts` esiste, wiring in `auto-recall.ts` confermato). Ignorato da `.gitignore` (`docs/superpowers/*`), mai stato in git → contenuto integrale sotto, in 2 parti.

**Fatti da tenere:** contiene la misura read-only "Task 0" sui dati LIVE (grafo events=11.693/relations=6.054/entities=9.871) che ha confermato che il design regge sui dati reali PRIMA di costruire — metodo "verify don't assume" applicato in modo esemplare. Superato dal successivo Incremento C (indice HNSW in-house, root `HANDOFF.md` del repo, altra voce di questo storico).

<details>
<summary>Contenuto integrale (mai versionato, gitignored — parte 1/2, header + Task 0-1)</summary>

```markdown
# Recall associativo-first — Incremento A — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere la *situazione* (dove eravamo + cornerstone + fingerprint + file recenti) il cue primario che semina lo spreading activation, così il recall di System-1 (banner/auto-recall) è associativo-dalla-situazione, dal vicinato, senza scansione globale né embedding.

**Architecture:** Un solo modulo nuovo — `situation-cue.ts` (dalla situazione ai *semi* = entity ids, puro sui read dello store, best-effort) — più il wiring in `runKbRecall`. Il motore associativo NON è nuovo: si **riusa** `associativeExpand(seedEntityIds, {maxNodes})` (già fa spread→vicinato→memoria-per-entità), stavolta seminato dalla situazione invece che dai risultati della query. Il cue-da-testo (`kbRecall(userText, {skipVector})`) resta come sorgente **secondaria**; i due si fondono per owner-id.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:sqlite` (sync), tsdown build, vitest. Regole progetto: immutabile (spread), mai throw sul path recall (try/catch → degrada), niente `console.log` (usa `logger`), file piccoli/una responsabilità.

**Spec:** `docs/superpowers/specs/2026-07-07-recall-associative-first-design.md`. Deviazione DRY rispetto allo spec §4.2: il componente N2 `associative-recall.ts` NON è un file nuovo — collassa nel riuso di `associativeExpand` + un piccolo passo di ranking nel wiring.

**Firme verificate (usare queste, non inventarne altre):**
- `store.listEventsBySession(sessionKey): KbEvent[]` — `KbEvent.entities: string[]`, `KbEvent.session_id`, `KbEvent.ts`, `KbEvent.type`, `KbEvent.project`.
- `store.associativeExpand(seedEntityIds: string[], opts?: { hops?; maxNodes?; namespace? }): Array<{ owner_id; owner_kind:"fact"|"event"; text; entity_id; activation }>`.
- `store.queryContextFingerprints(namespace, limit): StoredFingerprint[]` (campo `matchedOwnerIds: string[]`).
- `store.queryEntityById(id): KbEntity | null`.
- `resolveFileOwnerId(store, filePath): string | null` (da `src/core/hooks/situation-injection.ts`).
- `kbRecall(query, { store, embeddingService, maxResults, skipVector:true, logger }): Promise<KbRecallResult[]>` — `KbRecallResult { owner_id, owner_kind, score, text, entity_id? }`.
- Cornerstone: gli eventi cornerstone provengono da `events` (`cornerstone-runner.ts:134`), quindi un cornerstone→entità = `entities_json` del suo evento.

---

## Task 0 — Misura read-only su dati LIVE (discharge §7, NIENTE modifiche)

Deve rispondere a due domande PRIMA di costruire, sui dati reali (regola "read-only prima, verify don't assume"): (a) gli eventi della sessione precedente espongono `entities_json` non vuoto? (b) quelle entità hanno abbastanza `relations` perché lo spread renda?

**Files:** nessuno (solo lettura DB live via gateway/CLI o `sqlite3`).

- [ ] **Step 1: Trova il path del DB live**

Run: `grep -rn "pluginDataDir\|\.db\b\|foundations.db\|memory.db" src/core/store/factory.ts src/config.ts | head -20`
Poi conferma il file reale sotto la data dir del gateway (es. `C:/Users/lo/tdai-gateway/data` o la `pluginDataDir` configurata). Annota il path assoluto.

- [ ] **Step 2: Misura entità della sessione precedente (dove eravamo)**

Con un `session_key` reale (es. Sofia), esegui read-only:
```sql
-- eventi della sessione più recente per quel session_key, con conteggio entità
SELECT session_id, type, ts, json_array_length(entities_json) AS n_ent
FROM events WHERE session_key = :sk ORDER BY ts DESC LIMIT 30;
```
Expected: molte righe con `n_ent > 0`. Se quasi tutte `0` → il seme "dove eravamo" da eventi non regge, e Task 1 deve usare il fallback entity-name-match sul testo recap (annota la decisione).

- [ ] **Step 3: Misura densità del grafo attorno a quelle entità**

Prendi 5–10 entity id dallo step 2 ed esegui:
```sql
SELECT :eid AS entity, COUNT(*) AS deg FROM relations
WHERE src_entity_id = :eid OR dst_entity_id = :eid;
```
Expected: grado medio ≳ 2 (post-digest relations=6.026/entities=9.843). Se molte entità hanno grado 0 → lo spread non espande; annota che i pesi devono privilegiare le entità con grado>0 e che il fallback text-cue è essenziale.

- [ ] **Step 4: Registra i numeri nel plan**

Scrivi in fondo a questo file una riga "## Task 0 — risultati" con: % eventi con entità, grado medio campione, decisione (procedi come progettato / abilita fallback). NON procedere a Task 1 se entrambe le misure sono degeneri (in quel caso torna allo spec).

---

## Task 1 — `situation-cue.ts`: dalla situazione ai semi (modulo puro, TDD)

Responsabilità unica: raccogliere entity-id-semi pesati dalle sorgenti-situazione, best-effort, mai throw.

**Files:**
- Create: `src/core/kb/situation-cue.ts`
- Test: `src/core/kb/__tests__/situation-cue.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce (estrazione + merge + dedup)**

```typescript
import { describe, it, expect } from "vitest";
import { buildSituationSeeds } from "../situation-cue.js";
import type { IMemoryStore, KbEvent } from "../../store/types.js";

const evt = (o: Partial<KbEvent>): KbEvent => ({
  id: "e", ts: "2026-07-06T10:00:00Z", recorded_at: "", session_key: "sk",
  session_id: "prev", namespace: "default", project: "p", type: "decision",
  text: "", language: "und", entities: [], source_message_ids: [], ...o,
});

function fakeStore(over: Partial<IMemoryStore>): IMemoryStore {
  return {
    listEventsBySession: () => [
      evt({ id: "e1", ts: "2026-07-06T10:00:00Z", entities: ["ent_a", "ent_b"] }),
      evt({ id: "e2", ts: "2026-07-06T10:01:00Z", entities: ["ent_b"] }),  // ent_b twice → dedup
    ],
    queryContextFingerprints: () => [
      { matchedOwnerIds: ["ent_c"] } as any,
    ],
    queryEntityById: (id: string) => ({ id, name: id, type: "concept" } as any),
    ...over,
  } as unknown as IMemoryStore;
}

describe("buildSituationSeeds", () => {
  it("unions entities of recent events + fingerprint owners, deduped", () => {
    const seeds = buildSituationSeeds(fakeStore({}), {
      sessionKey: "sk", namespace: "default",
    });
    const ids = seeds.map((s) => s.id).sort();
    expect(ids).toContain("ent_a");
    expect(ids).toContain("ent_b");
    expect(ids).toContain("ent_c");   // from fingerprint
    // dedup: ent_b appears once, with the MAX weight seen
    expect(ids.filter((x) => x === "ent_b")).toHaveLength(1);
  });

  it("returns [] and never throws when every source fails", () => {
    const store = {
      listEventsBySession: () => { throw new Error("boom"); },
    } as unknown as IMemoryStore;
    expect(buildSituationSeeds(store, { sessionKey: "sk", namespace: "default" })).toEqual([]);
  });

  it("caps total seeds to MAX_SEEDS, strongest first", () => {
    const many = Array.from({ length: 100 }, (_, i) => evt({ id: `e${i}`, entities: [`ent_${i}`] }));
    const store = { listEventsBySession: () => many } as unknown as IMemoryStore;
    const seeds = buildSituationSeeds(store, { sessionKey: "sk", namespace: "default" });
    expect(seeds.length).toBeLessThanOrEqual(24);
  });
});
```

- [ ] **Step 2: Esegui il test — deve fallire**

Run: `npx vitest run src/core/kb/__tests__/situation-cue.test.ts`
Expected: FAIL — `buildSituationSeeds` non esiste.

- [ ] **Step 3: Implementa il modulo minimo**

```typescript
/**
 * situation-cue.ts — dalla SITUAZIONE ai semi dello spreading activation.
 *
 * Il recall associativo-first parte dalla situazione (dove eravamo + cornerstone
 * + fingerprint + file recenti), NON dal testo della query. Questo modulo traduce
 * quella situazione in entity-id-semi pesati. Puro sui read dello store, immutabile,
 * best-effort: ogni sorgente in try/catch → una che fallisce non azzera le altre;
 * tutto vuoto → []. Mai throw (il recall non rompe MAI la conversazione).
 */
import type { IMemoryStore, KbEvent } from "../store/types.js";
import type { Logger } from "../types.js";
import type { SessionSituation } from "../hooks/session-situation.js";
import { resolveFileOwnerId } from "../hooks/situation-injection.js";

const TAG = "[memory-tdai][situation-cue]";
const MAX_SEEDS = 24;
const RECENT_EVENTS = 30;

/** Un seme pesato per lo spreading activation. */
export interface SituationSeed {
  readonly id: string;        // entity id
  readonly weight: number;    // (0,1] — quanto la sorgente descrive "dove siamo ORA"
  readonly source: "recap" | "cornerstone" | "fingerprint" | "recent-file";
}

export interface SituationCueContext {
  readonly sessionKey: string;
  readonly namespace: string;
  /** Rolling situation (mid-session). Vuota all'apertura sessione — lì contano recap+fingerprint. */
  readonly situation?: SessionSituation;
  readonly logger?: Logger;
}

/** Peso base per sorgente (tarabile — vedi Task 0). */
const WEIGHT = { recap: 1.0, cornerstone: 0.7, fingerprint: 0.7, "recent-file": 0.4 } as const;

/**
 * I K eventi più recenti (per ts) sotto il session_key — la "coda" di ciò che stavamo
 * facendo, ATTRAVERSO il confine di sessione. Misurato live (Task 0): all'apertura la
 * sessione corrente è quasi vuota (2 eventi), quindi filtrare per session_id perderebbe
 * "dove eravamo"; i K-più-recenti-per-ts prendono la coda della sessione precedente.
 * Sui dati reali 26-27/30 eventi recenti portano entità → semi ricchi.
 */
function recentEventsByTs(events: readonly KbEvent[]): readonly KbEvent[] {
  return [...events].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, RECENT_EVENTS);
}

/** Aggiunge/aggiorna un seme tenendo il peso MASSIMO per entità. */
function addSeed(map: Map<string, SituationSeed>, id: string, weight: number, source: SituationSeed["source"]): void {
  if (!id) return;
  const cur = map.get(id);
  if (!cur || weight > cur.weight) map.set(id, { id, weight, source });
}

export function buildSituationSeeds(store: IMemoryStore, ctx: SituationCueContext): SituationSeed[] {
  const seeds = new Map<string, SituationSeed>();

  // (1) "Dove eravamo" + lavoro recente: entità dei K eventi più recenti sotto il session_key.
  try {
    if (typeof store.listEventsBySession === "function") {
      const recent = recentEventsByTs(store.listEventsBySession(ctx.sessionKey));
      for (const e of recent) for (const eid of e.entities ?? []) addSeed(seeds, eid, WEIGHT.recap, "recap");
    }
  } catch (err) { ctx.logger?.warn?.(`${TAG} recap seeds failed (non-fatal): ${msg(err)}`); }

  // (2) Context Fingerprint: owner risolti a entità.
  try {
    const fps = store.queryContextFingerprints?.(ctx.namespace, 5) ?? [];
    for (const fp of fps) for (const ownerId of fp.matchedOwnerIds ?? []) {
      const ent = store.queryEntityById?.(ownerId);
      if (ent) addSeed(seeds, ent.id, WEIGHT.fingerprint, "fingerprint");
    }
  } catch (err) { ctx.logger?.warn?.(`${TAG} fingerprint seeds failed (non-fatal): ${msg(err)}`); }

  // (3) File recenti (mid-session): fileKey → entity.
  try {
    for (const fileKey of ctx.situation?.fileKeys ?? []) {
      const id = resolveFileOwnerId(store, fileKey);
      if (id) addSeed(seeds, id, WEIGHT["recent-file"], "recent-file");
    }
  } catch (err) { ctx.logger?.warn?.(`${TAG} recent-file seeds failed (non-fatal): ${msg(err)}`); }

  return [...seeds.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_SEEDS);
}

function msg(err: unknown): string { return err instanceof Error ? err.message : String(err); }
```

> Nota cornerstone (sorgente 4 dello spec): al momento NON è inclusa qui perché al session-open il blocco cornerstone è costruito off-path (`cornerstoneCache`) e non sempre disponibile in `runKbRecall`. Aggiunta rimandata a Task 3 se Task 0 mostra che recap+fingerprint non bastano. Documentato, non silenzioso.

- [ ] **Step 4: Esegui i test — devono passare**

Run: `npx vitest run src/core/kb/__tests__/situation-cue.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: (NIENTE commit ancora — attende semaforo Lorenzo per toccare i servizi vivi; vedi §"Gate live")**
```

</details>

<details>
<summary>Contenuto integrale (mai versionato, gitignored — parte 2/2, Task 2-3 + gate live + risultati Task 0)</summary>

```markdown
## Task 2 — Wiring: la situazione semina il recall primario (TDD sull'integrazione)

Responsabilità: in `runKbRecall`, costruire i semi-situazione, farne il recall associativo **primario** via `associativeExpand`, e fonderlo col cue-da-testo — **senza** scansione globale.

**Files:**
- Modify: `src/core/hooks/auto-recall.ts` — `runKbRecall` (righe ~628–730) + il chiamante `performAutoRecallInner` (~256) che deve passare `sessionKey`, `namespace`, `situation`.
- Test: `src/core/hooks/__tests__/auto-recall-situation-seed.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce (il ribaltamento: nessun vettore, il ricordo non-nominato emerge dalla situazione)**

```typescript
import { describe, it, expect, vi } from "vitest";
// Costruisci uno store fake in cui:
//  - listEventsBySession ritorna eventi della sessione precedente con entities=["ent_sit"]
//  - associativeExpand, dato ["ent_sit"], ritorna una memoria owner "fact_assoc" che il
//    saluto NON nomina mai
//  - searchKbVector è una spy che DEVE restare a 0 chiamate
// Poi invoca il path System-1 (runKbRecall via performAutoRecall con userText="Ciao Socio")
// ATTESO: i risultati contengono "fact_assoc"; searchKbVector NON chiamato (vec=0).
```
(Il test concreto seguirà la forma dei fake già usati in `auto-recall-recent-event.test.ts` e `retrieval.test.ts`; asserisce: `expect(vectorSpy).not.toHaveBeenCalled()` e `expect(ids).toContain("fact_assoc")`.)

- [ ] **Step 2: Esegui — deve fallire**

Run: `npx vitest run src/core/hooks/__tests__/auto-recall-situation-seed.test.ts`
Expected: FAIL — oggi i semi vengono da `visible` (query), non dalla situazione; `fact_assoc` non emerge dal saluto.

- [ ] **Step 3: Implementa il wiring in `runKbRecall`**

Estendi la firma con il contesto-situazione e semina l'associativo dalla situazione PRIMA (primario), poi fondi col cue-da-testo:
```typescript
// firma: aggiungi ctx situazione
async function runKbRecall(
  userText: string, cfg: MemoryTdaiConfig, logger: Logger | undefined,
  vectorStore?: IMemoryStore, embeddingService?: EmbeddingService, projectName?: string,
  sit?: { sessionKey: string; namespace: string; situation?: SessionSituation },
): Promise<KbRecallResult[]> {
  if (!vectorStore) return [];
  try {
    // Cue-da-testo (SECONDARIO), invariato: FTS + entity-match, niente scansione globale.
    let results = await kbRecall(redactSecrets(userText), {
      store: vectorStore, embeddingService,
      maxResults: cfg.recall.maxResults ?? 5, rerank: cfg.recall.rerank ?? false,
      embeddingTimeoutMs: cfg.embedding?.recallTimeoutMs ?? cfg.embedding?.timeoutMs,
      skipVector: true, logger,
    });
    let visible = /* ...mapping esistente in KbRecallResult[]... */ results;

    const expand = (vectorStore as { associativeExpand?: Function }).associativeExpand;
    const seenKeys = new Set(visible.map((r) => `${r.owner_kind}:${r.owner_id}`));

    // ── PRIMARIO: la SITUAZIONE è l'indirizzo ──────────────────────────────
    if (typeof expand === "function" && sit?.sessionKey) {
      const seeds = buildSituationSeeds(vectorStore, {
        sessionKey: sit.sessionKey, namespace: sit.namespace, situation: sit.situation, logger,
      });
      if (seeds.length > 0) {
        const assoc = expand.call(vectorStore, seeds.map((s) => s.id), { maxNodes: 8 }) as
          Array<{ owner_id: string; owner_kind: "fact"|"event"; text: string; entity_id: string; activation: number }>;
        for (const a of assoc) {
          const key = `${a.owner_kind}:${a.owner_id}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          visible = visible.concat({
            owner_id: a.owner_id, owner_kind: a.owner_kind, score: a.activation,
            text: a.text, entity_id: a.entity_id, associative: true,
          } as KbRecallResult);
        }
        logger?.debug?.(`${TAG} [kb] situation-seeded associative: seeds=${seeds.length} added=${assoc.length}`);
      }
    }

    // ── SECONDARIO (invariato): espandi anche dai match della query ─────────
    if (typeof expand === "function") {
      const querySeeds = [...new Set(visible.filter((r) => !r.associative).map((r) => r.entity_id).filter(Boolean))];
      if (querySeeds.length > 0) {
        const assoc2 = expand.call(vectorStore, querySeeds, { maxNodes: 6 }) as any[];
        for (const a of assoc2) {
          const key = `${a.owner_kind}:${a.owner_id}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          visible = visible.concat({ owner_id: a.owner_id, owner_kind: a.owner_kind, score: a.activation, text: a.text, entity_id: a.entity_id, associative: true } as KbRecallResult);
        }
      }
    }

    // Riordino locale: attivazione/score decrescente, poi top-K.
    visible.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
    return visible.slice(0, (cfg.recall.maxResults ?? 5) + 4);
  } catch (err) {
    logger?.warn?.(`${TAG} [kb] KB recall failed (non-fatal): ${msg(err)}`);
    return [];
  }
}
```
E nel chiamante (`performAutoRecallInner`, dentro `runSearch`), passa il contesto:
```typescript
const sit = { sessionKey: params.sessionKey, namespace: "default",
              situation: params.sessionKey ? sessionSituationByKey?.get(params.sessionKey) : undefined };
const kbResults = await runKbRecall(userText, cfg, logger, vectorStore, embeddingService, projectName, sit);
```
> Verifica al primo step: `performAutoRecallInner` ha accesso alla rolling `SessionSituation`? Oggi vive in `tdai-core` (`sessionSituationByKey`). Se NON è passata all'hook, per l'incremento A si passa `situation: undefined` (i semi vengono da recap+fingerprint, corretto al session-open) e il threading della situation si rimanda a Task 3. Confermare con: `grep -n "sessionSituationByKey\|performAutoRecall(" src/core/tdai-core.ts`.

- [ ] **Step 4: Esegui il test — deve passare, con `searchKbVector` a 0 chiamate**

Run: `npx vitest run src/core/hooks/__tests__/auto-recall-situation-seed.test.ts`
Expected: PASS; asserzione `vectorSpy` non chiamata verde.

- [ ] **Step 5: Regressione — nessun test rotto**

Run: `npx vitest run src/core/kb src/core/hooks`
Expected: verdi (inclusi i 7 `retrieval` + i ~113 hook). Se il cue-da-testo cambia forma output, adegua i test esistenti SOLO se la forma è legittima; in dubbio, FERMATI e chiedi a Lorenzo (regola: si fixa il codice, non i test).

---

## Task 3 — (condizionale) Cornerstone come 4ª sorgente + threading della rolling situation

Solo se Task 0 mostra che recap+fingerprint non bastano a far emergere ricordi buoni. Aggiunge: (a) la 4ª sorgente cornerstone in `situation-cue.ts` (dai cornerstone-event → `entities_json`), (b) il passaggio della rolling `SessionSituation` da `tdai-core` all'hook. TDD come Task 1/2. Dettaglio rimandato all'esito di Task 0 per non speculare.

---

## Gate live (porta a senso unico — richiede semaforo di Lorenzo)

Costruzione documenti/test = autonoma. **Toccare i servizi vivi NO senza ok di Lorenzo:**
1. `npm run build` (tsdown) → verde.
2. Gateway: `C:\Users\lo\tdai-gateway\stop-gateway.ps1` poi `start-gateway.ps1`.
3. Verifica live: `/recall` su una sessione reale (Sofia `session_key`) → banner **completo** + **<4s**, log `[kb-recall] … vec=0` + `situation-seeded associative: seeds=N added=M` con M>0, ≥1 ricordo associativo non nominato dal saluto.
4. Solo allora: commit sul branch `feat/memory-excellence` (MAI main) + aggiorna scheda memoria `sinapsys-recall-redesign`.

## Definition of done (Incremento A)
Test verdi (situation-cue unit + integrazione anti-scan + regressione) **e** verifica live (banner<4s, vec=0, seeds=situazione, ≥1 ricordo associativo). Poi si progetta B (due marce + Hebbian).

## Self-review (fatto)
- **Copertura spec:** §4.2 N1 → Task 1; N2 (collassato in riuso `associativeExpand`) → Task 2; M1 wiring → Task 2; §6 test → Task 1/2; §7 → Task 0; cornerstone (4ª sorgente) → Task 3 condizionale (deviazione documentata, non silenziosa).
- **Placeholder:** nessun TBD; il codice-integrazione di Task 2 riusa il mapping esistente (indicato con commento `/* ...mapping esistente... */` perché è codice GIÀ presente da preservare, non da inventare).
- **Coerenza tipi:** `SituationSeed`, `buildSituationSeeds`, `associativeExpand`, `KbRecallResult` usati coerenti tra i task; firme allineate alle "Firme verificate".

---

## Task 0 — risultati (ESEGUITO read-only, 2026-07-07, DB live `tdai-memory-tdai-local/vectors.db` 1,8 GB)

Totali grafo: **events=11.693, relations=6.054, entities=9.871** (coerente col digest ×14).

| Misura | Sofia (`3e78aebfa57691fb`) | Sinapsys (`cd28f537622ba8f8`) |
|---|---|---|
| Eventi recenti (30) con `entities_json` non vuoto | **27/30** | **26/30** |
| Semi-entità distinti dai 30 eventi recenti | 26 | 53 |
| Grado medio del campione semi | 43,25 (hub `Sofia AI`=218) | 4,20 |
| Entità nuove raggiunte a **1 hop** da ~20 semi | **728** | **39** |
| `session_recap` con entità | — | **0 / 41 (tutti vuoti)** |

**Decisioni ancorate ai dati (non ipotesi):**
1. **§7 #1 confermato:** i 41 `session_recap` hanno 0 entità → seminare dagli **eventi recenti**, non dal recap. (Riflesso in Task 1: `recentEventsByTs`.)
2. **§7 #2 confermato:** semi ricchi (26-53) e raggiungibilità reale (39-728 a 1 hop) → il recall associativo-dalla-situazione **funziona sui dati veri**. Procedi come progettato.
3. **Hub fan-out reale** (nodi progetto grado 44-218): i cap esistenti `topKPerNode:8`/`maxNodes` lo controllano. Tuning futuro (Incremento B): down-weight dei semi ad altissimo grado (nodi globali = cue poco specifici). NON in A.
4. **Fallback text-cue essenziale** per le entità isolate (grado 0, ~8/20 in Sofia): già previsto come sorgente secondaria. Confermato necessario.
5. **`session_key` = questo progetto (`cd28f537622ba8f8`)** ha `session_id` corrente `add6f9a2-…` con soli 2 eventi all'apertura → conferma perché NON filtrare per `session_id`.

Script di misura (read-only, gitignored): `b3-backfill-copy/_recall_measure.cjs`, `_recall_measure2.cjs`.
```

</details>

---

# Sezione C — repo tencentdb-agent-memory, file TRACKED (summary + `git rm`)
