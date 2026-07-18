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
