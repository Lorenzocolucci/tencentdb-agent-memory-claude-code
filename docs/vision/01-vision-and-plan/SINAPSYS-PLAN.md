# 🧠 SINAPSYS — Piano Tecnico di Costruzione
> v1 — 23 giugno 2026 — Lorenzo + Claude
> Companion di MEMORIA-BLUEPRINT.md (16/06). Il blueprint è il "cosa/perché"; questo è il "come/quanto/quando", aggiornato con ricerca web di giugno 2026.

---

## Stato implementativo (aggiornato 2026-07-18 — nota conservativa, il PIANO sotto resta invariato e vincolante)

Tutte e **5 le fasi che mancavano** (Parte 4: A Consolidation Engine, B Mistake Notebook, C Proactive Injection+Idee 1&5, D Implicit Priming) sono **costruite e live**, più il pilastro **Grounded Trust** (non previsto in questo piano originale, aggiunto 2026-06-29) e un **L4 v1 contradiction-detector** in più rispetto al design qui sotto:

- **Fase A** (Consolidation Engine) → `src/core/kb/{consolidation-runner,consolidation-scheduler,lifecycle-writer,lifecycle-decay,contradiction-detector}.ts`.
- **Fase B** (Mistake Notebook) → `src/core/kb/{bug-clusters,lessons-writer,lessons-distiller,lessons-runner,lesson-reinforcement}.ts` (arco B1+B2+B3).
- **Fase C** (Proactive Injection + Idee 1&5) → `src/core/hooks/{situation,situation-injection,session-situation,fingerprint-*}.ts` + `src/core/distinctiveness/*`.
- **Fase D** (Implicit Priming, via SYNAPSE/spreading-activation) → `src/core/kb/{implicit-priming,spreading-activation}.ts`.
- **Fase E** (embeddings + reranker locali) → **NON costruita**: resta l'unico pezzo aperto (embedding provider ancora remoto — `src/config.ts`; reranker stub no-op — `src/core/kb/retrieval.ts`).
- **Oltre il piano:** Grounded Trust (Idea 6, 4 fasi) + un `contradiction-detector.ts` per il Consolidation Engine (L4 v1, commit `44a1625`).

Stato dettagliato per-modulo: `docs/SINAPSYS-ARCHITECTURE.md` + `docs/SINAPSYS_FOUNDATIONS.md` (nel repo, accanto al codice). Storico dei design/piani di ogni fase: `docs/archive/SINAPSYS-STORICO-DOCS-20260718.md`.

**Il testo sottostante è il piano tecnico originale del 23/06/2026 — NON riscritto, resta vincolante. Fase E è l'unico item ancora davvero aperto.**

---

## PARTE 0 — Per Lorenzo (1 minuto, da mortale)

**Cos'è:** una memoria per agenti AI a 5 livelli, tutta in locale sul tuo PC (niente cloud), che non solo *cerca* i ricordi ma li *ricostruisce* e te li *porta davanti* al momento giusto — e impara dai propri errori.

**Quanto è già fatto:** circa **metà**. Le fondamenta (archivio entità+fatti+relazioni, ricerca ibrida, riassunto a inizio sessione) le abbiamo costruite su TencentDB in queste sessioni. Funzionano e sono live.

**Cosa manca:** i 4 pezzi "intelligenti" — il motore di consolidamento notturno, il quaderno degli errori, l'iniezione proattiva, e il priming associativo.

**Quanto lavoro:** ~**5-7 sessioni focalizzate** per il cuore. Bounded, non infinito.

**Quanto costa di tool esterni:** **quasi zero** — stimato **0-5 €/mese**. È quasi tutto locale e gratis; l'unica spesa sono le chiamate a Kimi per estrarre/consolidare (centesimi a sessione). Embeddings ~gratis. Reranker e embeddings locali = gratis (girano sul tuo PC).

**Notizia onesta:** 2 delle nostre "5 idee originali" nel frattempo le hanno pubblicate altri (con codice). Brutto per l'orgoglio, **ottimo per noi**: invece di inventarle da zero, copiamo il loro design collaudato. Meno lavoro, meno rischio.

---

## PARTE 1 — Stato reale: cosa è GIÀ costruito (su TencentDB)

| Livello Sinapsys | Stato | Dove |
|---|---|---|
| **L0** Working memory (file .md) | ✅ fatto | status.md / done-log / scene_blocks |
| **L1** Episodica (eventi) | 🟡 parziale | tabella `events` (manca formato narrativo Situazione→Azioni→Risultati→Lezioni + Context Fingerprint) |
| **L2** Semantica (knowledge graph) | ✅ in gran parte | `entities` + `facts` (bi-temporali, supersession) + **`relations`** tipizzate |
| Ricerca ibrida FTS5+vettori (RRF) | ✅ fatto | `kbRecall` (FTS + vec + entity-match → RRF → score calibrato) |
| **L4** Consolidamento | 🟡 minimo | supersession + proiezioni deterministiche (manca clustering→lezioni, staleness, contraddizioni) |
| **L5** Iniezione | 🟡 parziale | iniezione a inizio sessione (persona+scene). Manca quella PROATTIVA per-tool |
| Anti-segreti nelle proiezioni | ✅ fatto | `looksLikeSecret()` |
| DB compatto + stabile | ✅ fatto | 52MB, chunk_size=8, gateway 15h+ stabile |

**Tradotto:** L0 ✅, L2 ✅, ricerca ✅. Mancano L3, il vero L4, e il vero L5 — più le 5 idee.

---

## PARTE 2 — Ricerca giugno 2026: cosa è cambiato (con fonti)

1. **Embeddings locali maturi (per togliere la dipendenza OpenAI).** Oggi i migliori on-device, gratis, via ONNX su Windows ARM64:
   - **EmbeddingGemma-300M** (Google, fatto apposta per edge, ONNX nativo, dimensioni troncabili 768→128). [HF](https://huggingface.co/blog/embeddinggemma)
   - **Qwen3-Embedding-0.6B** (miglior qualità/peso, dim 32-1024). [paper](https://arxiv.org/pdf/2506.05176)
   - **BGE-small-v1.5** (23M, leggerissimo, 384 dim). [guida](https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models)
   - ⚠️ Cambiare embedder = re-index totale (30-90 min). [test 2026](https://www.promptquorum.com/power-local-llm/best-embedding-models-local-rag-2026)
2. **Idea 2 (Implicit Priming) NON è più solo nostra:** pubblicata come **SYNAPSE** — "Episodic-Semantic Memory via Spreading Activation" ([arXiv 2601.02744](https://arxiv.org/pdf/2601.02744)), fondata su Anderson 1983. → La **adottiamo** (design di riferimento), non la inventiamo.
3. **Idea 3 (Mistake Notebook) NON è più solo nostra:** pubblicata come **MNL** (ACL 2026) **con codice GitHub** ([repo](https://github.com/Bairong-Xdynamics/MistakeNotebookLearning), [paper](https://arxiv.org/html/2512.11485)) + **ReasoningBank** (Google, ICLR 2026). → Copiamo MNL (batch-cluster errori → note distillate, "accept-if-improves").
4. **Knowledge graph:** **KùzuDB ARCHIVIATO ott-2025** (team mollato; fork community esistono). Conferma del blueprint: per il nostro caso **SQLite con tabella relazioni è la scelta giusta** — il graph DB serve solo per traversal pesanti che noi non abbiamo. [fonte](https://thedataquarry.com/blog/embedded-db-2/)
5. **Consolidamento "sleep-time" è ora standard:** Letta sleep-time agents + **MemOS 2.0** (open-source gen-2026). Pattern: write veloce + consolidamento lento in background, supersession per timestamp (già lo facciamo). [Letta](https://docs.letta.com/guides/agents/architectures/sleeptime/) · [MemOS](https://github.com/MemTensor/MemOS)
6. **Reranker locale gratis:** **bge-reranker-v2-m3** (278M, gira su CPU, qualità ~Cohere a costo 0, ottimo anche per il cinese). [guida](https://localaimaster.com/blog/reranking-cross-encoders-guide)
7. **Iniezione proattiva fattibile in Claude Code:** hook **PostToolUse** → `hookSpecificOutput.additionalContext` (silenzioso da CC 2.1.0). Pattern: hook veloce in coda + worker async (come claude-mem). [docs hooks](https://code.claude.com/docs/en/hooks)
8. **Costi (per million token):** Kimi K2.5 $0.60/$3.00 · K2.6 $0.95/$4.00 · caching -80/85% · OpenAI embed-3-small **$0.02** (input-only). ⚠️ I modelli `kimi-k2-*` legacy sono **EOL 25 maggio 2026** → da verificare quale modello usa il gateway oggi. [Kimi](https://costgoat.com/pricing/kimi-api) · [OpenAI](https://tokenmix.ai/blog/openai-embedding-pricing)

---

## PARTE 3 — Decisioni: ADOTTARE vs COSTRUIRE

| Pezzo | Scelta | Tecnologia | Perché |
|---|---|---|---|
| Storage fatti+grafo | ✅ già fatto | SQLite + tabella `relations` | KùzuDB archiviato; relazionale basta |
| Vettori | ✅ già fatto | sqlite-vec (vec0) | gira su ARM64 |
| Embeddings | tenere OpenAI ora, **opz. locale dopo** | OpenAI 3-small (≈gratis) → EmbeddingGemma/BGE-small se vuoi privacy 100% | costo trascurabile; locale = re-index |
| Reranker | BUILD (plug) | **bge-reranker-v2-m3** locale | gratis, qualità alta, abbiamo già lo stub |
| Mistake Notebook (L3) | **ADOTTARE** | design **MNL** (codice esiste) | non reinventare |
| Implicit Priming | **ADOTTARE** | design **SYNAPSE** (spreading activation sul grafo) | paper di riferimento |
| Consolidation (L4) | BUILD | processo fire-and-forget (stile Letta sleep-time) | è il nostro "cervello notturno" |
| Proactive Injection (L5) | BUILD | hook PostToolUse + additionalContext | meccanismo CC documentato |
| Context Fingerprint (Idea 1) | BUILD | impronta sessione (file/errori/tool/tipo) → match | ancora poco diffuso |
| Distinctive Terms (Idea 5) | BUILD | peso 3x ai termini di progetto in FTS | semplice, alto valore |
| LLM estrazione/consolidamento | tenere Kimi | Kimi K2.x (verificare modello) | già configurato, economico |

---

## PARTE 4 — Le 4 fasi che mancano (cuore di Sinapsys)

### Fase A — Consolidation Engine (L4) — "il cervello notturno"
- **Cosa:** dopo ogni sessione, un processo staccato (fire-and-forget) che: episodio→fatti (già), **clustering fallimenti→lezioni** (alimenta L3), **staleness** (abbassa priorità fatti vecchi non rinforzati), **reinforcement** (fatti visti in N sessioni salgono), **contradiction check**.
- **Come:** processo node staccato lanciato a fine sessione (stesso pattern fire-and-forget del backfill), una chiamata Kimi per consolidare. Riusa supersession già fatta.
- **Effort:** 1-2 sessioni · **Costo:** ~1 chiamata Kimi/sessione (centesimi) · **Test:** un fatto citato in 3 sessioni ha priorità > di uno citato in 1.

### Fase B — Mistake Notebook (L3) — "impara dagli errori"
- **Cosa:** tabella `lessons` (domain, pattern, lesson, evidence_count). Raggruppa fallimenti per dominio, distilla lezioni generalizzate.
- **Come:** **adotta MNL** (Tuner model → Correct Approach / Mistake Summary / Strategy / Anti-Patterns; "accept-if-improves"). Gira dentro la Fase A.
- **Effort:** 1 sessione · **Costo:** incluso in A · **Test:** dopo 3 fallimenti simili emerge 1 lezione.

### Fase C — Proactive Injection (L5) + Idee 1 & 5 — "i ricordi vengono a te"
- **Cosa:** quando apri un file / vedi un errore → il sistema inietta da solo i ricordi/lezioni rilevanti (max ~500 token). + Context Fingerprint (match per situazione) + Distinctive Terms (peso 3x ai termini-progetto).
- **Come:** hook **PostToolUse** (matcher su Read/Edit/Bash + `mcp__...__.*`), veloce + coda async; iniezione via `additionalContext`. Recupero locale (sotto i 200ms).
- **Effort:** 2 sessioni · **Costo:** 0 (locale) · **Test:** apri un file già toccato → ricevi le decisioni prese su quel file senza cercare.

### Fase D — Implicit Priming (su L2) — "un ricordo ne tira un altro"
- **Cosa:** un match debole su un fatto amplifica (+peso) i fatti collegati nel grafo, facendoli superare la soglia.
- **Come:** **adotta SYNAPSE** (spreading activation: dopo RRF, propaga attivazione lungo le `relations` per 1-2 hop). Si innesta in `kbRecall`.
- **Effort:** 1-2 sessioni · **Costo:** 0 (locale) · **Test:** cerca "IBAN" e trova "lead perso" via relazione, anche se "IBAN" non matcha direttamente.

### Fase E (opzionale) — Embeddings + Reranker locali — "zero dipendenze + qualità"
- **Cosa:** migra embeddings a EmbeddingGemma/BGE-small (privacy 100%, zero API) + attiva bge-reranker-v2-m3 sullo stub esistente.
- **Come:** ONNX Runtime locale. Richiede re-index una tantum.
- **Effort:** 1 sessione + re-index · **Costo:** 0 (gira sul PC) · **Test:** recall ≥ attuale senza chiamare OpenAI.

---

## PARTE 5 — Costi reali (tool esterni)

| Voce | Costo | Note |
|---|---|---|
| LLM estrazione+consolidamento (Kimi) | **~0-5 €/mese** | centesimi a sessione; caching -80% |
| Embeddings | **~0 €** | OpenAI 3-small $0.02/M (trascurabile) o locale = gratis |
| Reranker | **0 €** | bge-reranker-v2-m3 locale |
| Knowledge graph / vettori / FTS / hook | **0 €** | tutto SQLite/locale |
| **Totale stimato** | **≈ 0-5 €/mese** | è un sistema locale: la spesa è solo qualche chiamata Kimi |

⚠️ **Azione preliminare:** verificare quale modello Kimi usa il gateway (`TDAI_LLM_MODEL`) — i `kimi-k2-*` legacy sono EOL 25/05/2026; eventualmente passare a K2.5/K2.6.

---

## PARTE 6 — Ordine consigliato + totale

1. **Fase A + B insieme** (Consolidation + Mistake Notebook) — il salto di valore più grande. ~2 sessioni.
2. **Fase C** (Proactive Injection + Context Fingerprint + Distinctive Terms) — l'effetto "magico" che vedi tu. ~2 sessioni.
3. **Fase D** (Implicit Priming) — raffinatezza sul recall. ~1-2 sessioni.
4. **Fase E** (locale, opzionale) — quando vuoi privacy 100% / zero dipendenze. ~1 sessione.

**Totale cuore (A-D): ~5-7 sessioni focalizzate. Costo a regime: ~0-5 €/mese.**

> Prerequisito già soddisfatto: TencentDB stabile + L0/L2/ricerca fatti. Si parte da Fase A.
> Regola: questo file + il blueprint vivono su Notion (fonte di verità) + ingeriti nella memoria, così non si perdono più.

---

## PARTE 7 — Ricerca cross-disciplinare VERIFICATA (24 giugno 2026)
> Due round di deep-research, 222 agenti totali, ogni claim verificato con voto avversariale 3 giudici (48/50 confermati). Fonti primarie peer-reviewed. NON è opinione: è ciò che è sopravvissuto alla verifica.

### 7.1 — Neuroscienze della memoria umana (round 1)
| Principio verificato | Fonte | → Feature Sinapsys |
|---|---|---|
| **Promozione a 2 condizioni** (Synaptic Tagging & Capture): un ricordo diventa durevole solo se "taggato" E confermato da un evento successivo | Nature s42003-021-01778-y, nrn2963 | Promuovi short→long con regola a 2 cancelli (tag al write + conferma su ripetizione), non con un solo punteggio |
| **La salienza salva i vicini, ma solo se semanticamente simili** (gate per cosine similarity); solo ricordi DEBOLI, effetto ritardato, finestra ~30min-3h | Science Advances ady1704 (2025), PMC9378568, eLife 72519 | Quando accade un evento saliente, rinforza i ricordi correlati vicini nel tempo filtrati per similarità embedding |
| **L'importanza si CONTA, non si vota**: priorità = numero cumulativo di replay, guidato da novità + durata, NON da reward esplicito | PMC10710481 | Driver di promozione = conteggio riapparizioni/accessi + novità contesto (già abbiamo il `support` count) |
| **La memoria migliora offline da sola** (consolidamento rafforza, non solo preserva) | s42003-021-01778-y (modello computazionale — caveat) | Il motore notturno deve RIELABORARE i ricordi, non solo indicizzarli |

### 7.2 — Stato dell'arte sistemi AI (round 1)
- **ReasoningBank** (Google, arXiv:2509.25140, set 2025): distillare lezioni da successi **E fallimenti** = +3-34% success rate vs salvare solo successi/tracce grezze. → conferma diretta del Mistake Notebook (Fase B). I numeri sono benchmark auto-riportati, non replica terza.
- **A-MEM** (arXiv:2502.12110, NeurIPS 2025): note Zettelkasten a 7 componenti + linking LLM + "memory evolution" (riscrittura) — MA senza audit trail → rischio compounding allucinazioni.
- **MemOS** (arXiv:2507.03724): MemCube con **provenienza + versioning** — ma senza evoluzione.
- **Gap centrale** (survey arXiv:2509.18868): gli LLM mancano di un vero sistema di gestione memoria con lifecycle. È il buco che Sinapsys colma.

### 7.3 — I 5 ambiti cross-disciplinari (round 2)
| Ambito | Esito | Principio verificato | → Feature Sinapsys |
|---|---|---|---|
| **📚 Archivistica** | ✅ forte, **originale** | Retention decisa dalla IMPORTANZA DELLA FUNZIONE che ha creato il ricordo, non dal contenuto. Policy per CATEGORIA, predefinita. Dedup per PROVENIENZA (tieni la fonte autorevole) | Retention-score per funzione+categoria (decisione architetturale=permanente, log build=7gg); provenienza su ogni ricordo; dedup per origine non solo per similarità. Fonte: bac-lac.gc.ca Macroappraisal (Terry Cook) |
| **🩺 Medicina / illness scripts** | ✅ forte, **originale** | L'esperto attiva lo "script" giusto dai primi indizi situazionali, SOTTO la coscienza, SENZA cercare, quando c'è un "fit" stretto. Vince per ORGANIZZAZIONE, non quantità | **Context Fingerprint** (file aperti + tipo errore + tipo task) → iniezione proattiva su match forte, **fallback a ricerca esplicita su contesto ambiguo** (rischio falso match). Investi nella struttura del grafo. Fonte: PMC4795084, PMC3060310 |
| **🕵️ Intelligence** | 🟡 metà | Spreading activation trova "nodi ponte" che la similarità non vede, MA va sempre VINCOLATO (limiti hop/fan-out/soglia) o accende tutta la rete. ACH (matrice) è una TRAPPOLA: può aumentare l'errore (N=50) | Spreading activation **constrained** in Fase D; per fatti in conflitto: mostrarli, non forzare un'ipotesi rigida. Fonte: Crestani 1997, Cohen & Kjeldsen 1987. ⚠️ i numeri 87%/48% del paper KG-RAG sono REFUTATI |
| **🍷 Sommelier / Distinctive Terms** | 🟡 confermato ma ridotto | Termini rari/distintivi ricordati meglio, MA **non monotonico**: banda di rarità ottimale, escludere token ultra-rari (hash/ID); applicare all'INDICIZZAZIONE | Peso ai termini rari di dominio nell'FTS con CAP (escludi hash-like). ⚠️ si sovrappone molto a BM25/IDF standard → **poco originale**. Fonte: PMC2387211 |
| **🎷 Jazz** | ❌ a vuoto | Nessuna fonte sopravvissuta. Il principio (richiamo veloce automatico) è già coperto dalla medicina | **Tagliato dal piano.** sub-200ms resta un obiettivo ingegneristico, non un dato |

## PARTE 8 — I 3 angoli di originalità VENDIBILI
> Incrociando i due round con i gap dello stato dell'arte. Questo è dove non esiste nulla di equivalente sul mercato (giudizio di design ragionato, non verificato avversarialmente).

1. **Memoria che si auto-migliora SENZA corrompersi.** A-MEM evolve i ricordi ma senza tracciabilità; MemOS ha versioning ma non evoluzione. **Nessuno combina i due.** = evoluzione + audit trail verificabile.
2. **Cosa tenere/buttare deciso per FUNZIONE + PROVENIENZA** (dall'archivistica). Tutti gli altri usano regole ad-hoc (recency/importance). Un criterio principiato e difendibile è differenziante.
3. **Iniezione PROATTIVA dall'impronta della situazione, senza query** (dalla medicina). Mem0/Letta sono query-driven: aspettano che tu chieda. Sinapsys ti mette davanti il ricordo giusto perché riconosce la situazione.

## PARTE 9 — Revisioni al piano originale (oneste)
- **Fase D (Implicit Priming) si sposta in CODA.** Verifica sul DB live: grafo sparso (77 relazioni / 273 entità = 0.28 rel/entità, gran parte isolate). Lo spreading activation non ha archi su cui propagare. Va costruita DOPO che la Fase A (Consolidation) densifica il grafo.
- **Il "tiering perché il cervello ha tempi ore/giorni" è REFUTATO** (voto 1-2). Teniamo i tier, ma giustificati da logica di sistema (caching/eviction), NON da falsa biologia.
- **L'analogia dichiarativo-vs-procedurale è una BUSSOLA di design, non un dogma biologico.** Separare lezioni/errori dai fatti è utile in ingegneria; i paper AI avvertono di non equipararla 1:1 ai substrati cognitivi.
- **Modello LLM:** verificato `moonshot-v1-auto` (NON kimi-k2 legacy EOL). Azione preliminare CHIUSA, niente da migrare.
- **Embeddings:** verificato OpenAI text-embedding-3-small 1536-dim (NON locale). Fase E (migrazione locale) è tutta da fare, non metà.
- **Mistake Notebook (Fase B): materia prima già presente.** Gli `events` hanno la tassonomia `type` (bug/fix/decision/result): un `bug`→`fix` = un fallimento risolto da distillare. Nessuna modifica schema.
- **"accept-if-improves" (Fase B): l'eval set lo costruiamo NOI dai dati KB reali**, non lo chiediamo a Lorenzo.

> Stato ricerca: 7/7 ambiti chiusi. Prossimo passo costruttivo = Fase A (Consolidation Engine) + Fase B (Mistake Notebook), con D spostata in coda.
