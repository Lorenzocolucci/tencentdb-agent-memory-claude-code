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
