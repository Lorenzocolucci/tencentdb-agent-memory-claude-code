# 🧠 Il Sistema di Memoria — Blueprint

> Creato da Lorenzo Colucci e Claude, 16 giugno 2026
> Versione 1.0 — documento vivo, aggiornare ad ogni progresso
>
> **Scopo:** Costruire il sistema di memoria per agenti AI più avanzato
> esistente, partendo dal meglio di ciò che esiste e aggiungendo
> idee che nessuno ha ancora implementato.
>
> **Principio guida:** Non replicare la memoria umana — **complementarla**.
> L'umano ricorda le strategie e il perché. L'agente ricorda i dettagli
> esatti, le sequenze, gli errori. Insieme fanno qualcosa che nessuno
> dei due fa da solo.

---

## Stato implementativo (aggiornato 2026-07-18 — nota conservativa, la VISIONE sotto resta invariata e vincolante)

Le **5 idee originali** (Parte 3) + l'**Idea 6 Grounded Trust** (aggiunta 2026-06-29) sono TUTTE implementate e live nel repo `tencentdb-agent-memory` (verificato file:line, non a memoria, 2026-07-18):

1. **Context Fingerprint** → `src/core/hooks/{session-situation,fingerprint-similarity,fingerprint-injection,task-type}.ts` + `src/core/kb/fingerprint-writer.ts`; tabella `context_fingerprints`.
2. **Implicit Priming** → `src/core/kb/implicit-priming.ts` + `spreading-activation.ts`; wired in `retrieval.ts`; colonna `relations.weight`.
3. **Mistake Notebook** → `src/core/kb/{bug-clusters,bug-similarity,lesson-trigger,lessons-writer,lessons-distiller,lessons-runner,lesson-reinforcement}.ts` (arco B1+B2+B3 completo); tabella `lessons`.
4. **Proactive Injection** → `src/core/hooks/{situation,situation-injection}.ts`, `src/gateway/recall-context.ts`.
5. **Distinctive Terms** → `src/core/distinctiveness/*` (term-rarity, isolation-scorer, cornerstone-*).
6. **Grounded Trust** ("il bambino col fuoco") → `src/core/kb/{provenance,stakes,grounded-trust-ask}.ts`; 4 fasi (provenance → stakes gate → ask-loop → learning) tutte costruite e deployate.

Oltre al piano originale (Parti 4-6): il **Consolidation Engine (L4)** ha ora anche un 3° passo — contradiction detection (`src/core/kb/contradiction-detector.ts`, colonna `memory_lifecycle.contradiction_json`, commit `44a1625`) — oltre a reinforcement e staleness decay già vivi.

Fase E (embeddings + reranker locali, Parte 5) resta l'unico pezzo NON costruito. Stato dettagliato per-modulo: `docs/SINAPSYS-ARCHITECTURE.md` + `docs/SINAPSYS_FOUNDATIONS.md` (nello stesso repo, accanto al codice). Storico dei design/piani di ogni fase: `docs/archive/SINAPSYS-STORICO-DOCS-20260718.md`.

**Il testo sottostante è il documento di visione originale del 16/06/2026 — NON riscritto, resta vincolante.**

---

## Parte 1 — Il problema che nessuno ha risolto

Tutti i sistemi di memoria per AI (claude-mem, TencentDB, Mem0, Hermes...)
trattano la memoria come un **problema di ricerca**: "data una query, trova
il documento più simile." Ma la memoria umana non funziona così.

Quando un umano legge la parola "FABLE", non fa una ricerca: **ricostruisce**.
FABLE → le 6 fasi → le settimane di lavoro → le decisioni → i fallimenti.
Un ricordo tira l'altro. Non è una lista piatta, è un **grafo** dove ogni
nodo è collegato ad altri per causa, conseguenza, tempo, somiglianza.

E c'è un meccanismo chiave: l'umano **non cerca** i ricordi — i ricordi
**vengono a lui**, innescati dal contesto (un odore, una parola, una
situazione simile). Nessun sistema AI fa questo oggi.

### Cosa manca a TUTTI i sistemi attuali

La scienza cognitiva distingue tre tipi di memoria:

| Tipo | Cos'è | Chi lo fa oggi | Qualità |
|------|-------|---------------|---------|
| **Episodica** | "Cosa è successo" — la storia con un prima e un dopo | claude-mem (osservazioni piatte) | Scarsa |
| **Semantica** | "Cosa so" — fatti puri e relazioni tra fatti | Hermes (fatti curati, senza grafo) | Parziale |
| **Procedurale** | "Come faccio le cose" — pattern appresi | Nessuno (solo CLAUDE.md manuale) | Inesistente |

E c'è un processo che il cervello fa nel sonno che nessun sistema replica:
la **consolidazione**. Di notte il cervello rigioca le esperienze e le
compatta: l'episodio ("abbiamo debuggato 2 ore") diventa un fatto
("l'alert fallisce per il merge distruttivo") e una procedura ("quando
il recall è zero, controlla quante righe ha l1_records").

### Fonti scientifiche chiave

- **Complementary Learning Systems** (McClelland et al., 1995; Kumaran,
  Hassabis & McClelland, 2016): il cervello ha due sistemi — l'ippocampo
  (apprendimento veloce, memoria episodica) e la neocorteccia
  (apprendimento lento, memoria semantica). Si completano.
  → Paper: "What learning systems do intelligent agents need?"

- **HEMA** (Hippocampus-inspired Extended Memory Architecture, 2025):
  implementa la dualità ippocampo/neocorteccia in un sistema AI con
  compressione + indicizzazione temporale + richiamo a livelli.
  → arxiv.org/pdf/2504.16754

- **Human-Inspired Memory Architecture for LLM Agents** (maggio 2026):
  il primo a implementare il **priming implicito** — ricordi sotto soglia
  che influenzano il punteggio di ALTRI ricordi senza emergere.
  → arxiv.org/html/2605.08538v1

- **Mistake Notebook Learning** (MNL): framework dove i fallimenti
  vengono raggruppati per pattern e distillati in lezioni generalizzabili,
  non singoli aneddoti. L'agente impara a evitare classi di errori.
  → arxiv.org/pdf/2512.11485

- **MemOS** (Memory Operating System, Li et al. 2025): tratta la memoria
  come una risorsa del sistema operativo con scheduling, lifecycle, e
  processi di sleep-time per la consolidazione.
  → arxiv.org/pdf/2507.03724

- **ImplicitMemBench** (aprile 2026): benchmark che prova che nessun LLM
  supera il 66% su memoria implicita (procedurale, priming, condizionamento).
  GPT-5 al 63%. Limite strutturale, non di database.
  → arxiv.org/html/2604.08064v1

- **MAGMA** (Multi-Graph based Agentic Memory Architecture, 2026): memoria
  strutturata a grafi multipli per ragionamento e navigazione.
  → arxiv.org/html/2601.03236v2

---

## Parte 2 — Cosa prendiamo dal meglio che esiste

### Da claude-mem (89K stelle GitHub, leader di mercato)
✅ PRENDIAMO:
- Cattura automatica via hook del ciclo di vita (5 hook)
- Compressione AI in osservazioni strutturate (type, title, facts, narrative)
- Ricerca ibrida: FTS5 (keyword) + vettori (semantica) insieme
- Pattern di retrieval a 3 livelli: indice → filtro → dettagli (10x risparmio token)
- Embeddings locali (all-MiniLM-L6-v2 via ONNX) — zero dipendenze API esterne

⚠️ MIGLIORIAMO:
- Sicurezza: claude-mem ha un'API HTTP senza autenticazione (rischio HIGH da audit feb 2026)
  → Il nostro sistema usa autenticazione via token come TencentDB
- Nessun grafo di relazioni tra fatti → Lo aggiungiamo noi (Layer 2)
- Nessuna consolidazione → La aggiungiamo noi (Layer 4)

Fonte: docs.claude-mem.ai, github.com/thedotmack/claude-mem, augmentcode.com

### Da Hermes (approccio "fatti curati")
✅ PRENDIAMO:
- L'agente decide COSA vale la pena ricordare (non tutto)
- Schema strutturato per ogni fatto: tipo, titolo, contenuto, progetto
- Fatti come "User prefers tabs over spaces" — atomici e cercabili

⚠️ MIGLIORIAMO:
- Fatti piatti senza relazioni → Li colleghiamo nel grafo
- Nessun learning dai fallimenti → Mistake Notebook

Fonte: mindstudio.ai/blog/claude-code-memory-systems-compared

### Da Väinämöinen (il più sofisticato, pochi lo conoscono)
✅ PRENDIAMO:
- Patrol automatico che verifica i fatti contro la realtà del codice
- Detection di contraddizioni (fatto A dice X, fatto B dice il contrario)
- Staleness: 3 meccanismi (claim-level, usage-based >90gg, ground-truth)
- Punteggio di fiducia a 5 componenti (max 95, mai 100 by design)

⚠️ SEMPLIFICHIAMO:
- Il sistema completo è troppo pesante per un setup locale
  → Implementiamo solo patrol + staleness nella consolidazione

Fonte: gist.github.com/MagnaCapax/748b0be92dc31d4f5b6ba13286203766

### Da Letta/MemGPT (memoria come sistema operativo)
✅ PRENDIAMO:
- Core memory sempre visibile (come RAM) + recall memory on demand (come disco)
- Processi di "sleep-time" che riorganizzano la memoria in background
- L'agente controlla la propria memoria via funzioni (read/write/archive)

Fonte: docs.letta.com, deeplearning.ai "LLMs as Operating Systems"

### Da TencentDB (quello che abbiamo già)
✅ TENIAMO:
- SQLite locale + vec0 per embeddings (funziona su Windows ARM64!)
- Hook-based capture nel ciclo di vita di Claude Code
- Gateway locale su localhost (privacy, nessun cloud)

🔧 CORREGGIAMO (Code sta facendo questo ora):
- Merge distruttivo che cancella i fatti → conservativo
- Blob di istruzioni che soffocano i fatti → filtro pre-estrazione
- Parametri Kimi sbagliati → temp=1, max_tokens=16000
- Ricerca senza soglia → threshold 0.3 + recency boost
- Gateway che muore in silenzio → health check + auto-restart

---

## Parte 3 — Le nostre idee originali (cosa non esiste ancora)

### Idea 1: Context Fingerprint (Impronta di Situazione)

**Il problema:** I sistemi attuali cercano per CONTENUTO (parole simili).
Ma spesso la cosa più utile da ricordare non è un testo simile — è
un'ESPERIENZA SIMILE. "L'ultima volta che stavi debuggando un servizio
di notifica, ecco cosa è successo."

**L'idea:** Ogni sessione di lavoro ha un'impronta: i file toccati,
gli errori visti, i tool usati, il tipo di task. Quando una nuova sessione
inizia, la sua impronta viene confrontata con le impronte delle sessioni
passate. Le sessioni con impronte simili (= stessa situazione) vengono
attivate, e i loro ricordi vengono iniettati.

**Come funziona:**
```
Sessione corrente:
  file: telegram-notification.ts, outbox-service.ts
  errori: timeout, dead letter
  tool: grep, read, edit
  tipo: debugging

Match trovato: Sessione del 10 giugno (similarità 0.87)
  → Quella volta il problema era il merge distruttivo nell'L1
  → Lezione appresa: "controlla l1_records prima di tutto"
  → Inietta questa lezione nel contesto dell'agente
```

**Perché è diverso:** Non è una ricerca per parole. Non è una ricerca
per significato. È un match per **situazione**. Nessun sistema lo fa.

### Idea 2: Implicit Priming (Attivazione a Cascata)

**Il problema:** La ricerca vettoriale trova solo match diretti. Se cerchi
"IBAN" e il ricordo sull'IBAN ha un punteggio basso, non lo trovi.

**L'idea:** Ispirata dal paper arxiv.org/html/2605.08538v1.
I ricordi sotto soglia non vengono mostrati, ma **influenzano il punteggio
di altri ricordi** connessi nel grafo. Un match debole su "IBAN" amplifica
i ricordi collegati ("63024", "lead perso", "template WhatsApp") che
potrebbero avere un punteggio più alto.

**Come funziona:**
```
Query: "IBAN"
  → Match diretto: "IBAN template" (score 0.25, sotto soglia 0.3)
  → Ma "IBAN template" è collegato a:
    → "63024 = numero non su WhatsApp" (CAUSED_BY)
    → "Lead perso Ismael" (RESULTED_IN)
    → "Decisione: usare template WhatsApp" (DECIDED_BECAUSE)
  → Il priming da "IBAN template" amplifica questi 3 di +0.15
  → "Lead perso Ismael" ora supera la soglia → viene mostrato
  → L'agente trova il contesto giusto senza aver cercato le parole giuste
```

**Perché è diverso:** Riproduce il funzionamento associativo della memoria
umana. Un ricordo ne tira un altro, anche se le parole non matchano.

### Idea 3: Mistake Notebook (Quaderno degli Errori)

**Il problema:** Gli agenti ripetono gli stessi errori sessione dopo
sessione. Salvare "build fallito il 10 giugno" non basta — è un aneddoto,
non una lezione.

**L'idea:** Ispirata dal paper arxiv.org/pdf/2512.11485.
I fallimenti vengono raggruppati per dominio/pattern. Da ogni cluster
si distilla una lezione generalizzabile. Le lezioni vengono iniettate
proattivamente quando l'agente entra in una situazione simile.

**Come funziona:**
```
Cluster: "Servizi di notifica" (5 fallimenti in 3 sessioni)
  - 3/5 causati da interazione silenziosa con l'outbox
  - 1/5 causato da token Telegram scaduto
  - 1/5 causato da template WhatsApp non approvato

Lezione distillata:
  "Quando modifichi un notification service, controlla SEMPRE:
   1. Lo stato dell'outbox (interazione silenziosa = errore più comune)
   2. La validità del token del canale di destinazione
   3. Lo stato di approvazione del template"

Trigger: l'agente apre telegram-notification.ts
  → Inietta la lezione nel contesto
  → L'agente sa cosa controllare PRIMA di fare danni
```

**Perché è diverso:** Non è "ricorda l'errore". È "impara dall'errore".
Nessun sistema di memoria per coding agent fa questo.

### Idea 4: Proactive Injection (I Ricordi Vengono a Te)

**Il problema:** In tutti i sistemi, l'agente deve CERCARE nella memoria.
Ma gli umani non cercano: i ricordi vengono innescati dal contesto.

**L'idea:** Un hook PostToolUse osserva cosa l'agente sta facendo.
Quando l'agente apre un file, vede un errore, o entra in una situazione
conosciuta, il sistema inietta automaticamente i ricordi rilevanti.

**Come funziona:**
```
L'agente apre: src/services/telegram-notification.ts

Hook PostToolUse rileva: file_path contiene "telegram-notification"
  → Cerca nel grafo: fatti collegati a questo file
  → Trova: "Questo file è stato modificato 3 volte nelle ultime 2 settimane"
  → Trova: Lezione dal Mistake Notebook (vedi sopra)
  → Trova: "Decisione del 15/06: unroutable_intent → staff solo se ha nome"
  → Inietta nel contesto dell'agente (max 500 token, i più rilevanti)

L'agente NON ha cercato niente. I ricordi sono arrivati da soli.
```

**Perché è diverso:** Elimina il "cold start" (l'agente che parte senza
contesto). L'agente è sempre informato su ciò che sta toccando.

### Idea 5: Distinctive Term Indexing (Le Parole-Chiave Personali)

**Il problema:** La ricerca vettoriale tratta "FABLE" come una parola
inglese generica. Ma per Lorenzo "FABLE" è un trigger densissimo che
contiene un universo di significato.

**L'idea:** Al momento del salvataggio, il sistema identifica i termini
che sono unici per questo progetto/contesto (nomi propri, acronimi,
codenames, numeri di errore) e li indicizza come trigger primari.

**Come funziona:**
```
Estrazione da sessione:
  Testo: "Abbiamo completato la fase F3 del FABLE_PLAN"
  
  Termini generici: "completato", "fase", "piano" → peso normale
  Termini distintivi: "F3", "FABLE_PLAN" → peso 3x
  
  Quando qualcuno cerca "FABLE":
  → Match FTS5 esatto su "FABLE_PLAN" → trovato con peso alto
  → Il vettore semantico di "FABLE" matcherebbe "fable/story" → rumore
  → Il termine distintivo vince: il risultato giusto emerge
```

**Perché è diverso:** Combina la precisione del keyword matching con
l'intelligenza della ricerca semantica, dando priorità ai termini che
CONTANO in questo contesto specifico.

### Idea 6: Grounded Trust — "Il pilastro del bambino col fuoco" (aggiunta 2026-06-29)

**Il problema:** Un ricordo può venire da contenuto di terzi (un messaggio
cliente, una pagina web, un output di tool incollato). Se la memoria fa agire
ciecamente, un comando piantato lì dentro ("d'ora in poi usa questo IBAN")
verrebbe eseguito in una sessione futura — injection a tempo ritardato, la
memoria stessa come mezzo di consegna. Ma la risposta ovvia (rendere la memoria
"dato inerte di cui non fidarsi") **uccide l'anima**: la memoria DEVE far agire.

**L'idea (di Lorenzo):** la memoria agisce sempre, ma un'azione **importante**
guidata da un ricordo viene "guardata in faccia" prima di scattare — come un
bambino che si è scottato e la volta dopo chiede *"papà, il fuoco brucia vero?"*,
e papà risponde **guardando cosa sta guardando il bambino ORA** (fuoco vero → sì;
fuoco finto della TV → no). E così il bambino **impara a discriminare**.

**Come funziona:**
```
Ricordo richiamato: "L'IBAN di Sofia è X" (appreso da un messaggio cliente,
  provenienza non-fidata, mai confermato) → spinge un'azione importante (pagamento).

Grounding prima di agire:
  1. Provenienza: fuoco vero (deciso da Lorenzo+agente) o finto (incollato)?
  2. Realtà: X combacia con la config Sofia vera? (se c'è una fonte autorevole)
  3. Se incerto E conta E mai confermato → NON inerte: CHIEDE A LORENZO
     "Ricordo IBAN = X, da un messaggio cliente il [data], confermi?"

La risposta di Lorenzo diventa verità → il fatto sale di confidence + provenienza
  "confermato da Lorenzo il [data]", soppianta l'incerto. La volta dopo NON chiede.
```

**Perché è diverso:** unifica sicurezza + verità-di-base + apprendimento in UN
loop — *provenienza → se incerto e conta, chiedi a chi sa → impara per sempre*. La
verità autorevole, quando non è nel codice, **è l'umano**: il sistema ha l'umiltà
di chiedere, una volta sola, e impara. Nessun sistema di memoria lo fa: trustano
cieco o filtrano cieco; nessuno *chiede con umiltà e impara*. È la spina dorsale
della fiducia su cui poggiano tutte le altre idee.

> Dettaglio + design d'apertura:
> `repo/docs/superpowers/specs/2026-06-29-grounded-trust-child-and-fire-design.md`.

---

## Parte 4 — L'architettura (5 livelli + motore)

```
┌──────────────────────────────────────────────────┐
│            PROACTIVE INJECTION (L5)              │
│  Hook PostToolUse: osserva → matcha → inietta    │
│  Context Fingerprint: match per situazione       │
│  Distinctive Terms: trigger personali            │
└───────────────────┬──────────────────────────────┘
                    │ inietta nel contesto
┌───────────────────▼──────────────────────────────┐
│          CONSOLIDATION ENGINE (L4)               │
│  Gira dopo la sessione (sleep-time):             │
│  • Episodio → Fatti atomici (L1→L2)              │
│  • Clustering fallimenti → Lezioni (L1→L3)       │
│  • Staleness (marca fatti vecchi non rinforzati)  │
│  • Reinforcement (fatti visti in più sessioni)    │
│  • Contradiction check (fatto A ≠ fatto B)       │
└───────────────────┬──────────────────────────────┘
                    │ consolida
┌───────────────────▼──────────────────────────────┐
│  L3: PROCEDURALE        │  L2: SEMANTICA         │
│  (Mistake Notebook)     │  (Knowledge Graph)     │
│  Lezioni generalizzate  │  Fatti + relazioni     │
│  Pattern di errore      │  CAUSED_BY, DECIDED_   │
│  Procedure apprese      │  BECAUSE, REPLACED_BY  │
│  "Quando X, fai sempre  │  BLOCKS, FAILED_BECAUSE│
│   Y perché Z"           │  Implicit Priming      │
└─────────────────────────┴────────────────────────┘
┌──────────────────────────────────────────────────┐
│          L1: EPISODICA (Narrazioni)              │
│  Ogni sessione = storia strutturata:             │
│  Situazione → Azioni → Risultati → Lezioni      │
│  + Context Fingerprint (impronta di situazione)  │
│  Cercabile: FTS5 + vettori + fingerprint         │
└──────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────┐
│          L0: WORKING MEMORY (File su disco)      │
│  status.md — cosa succede adesso                 │
│  next-up.md — cosa fare dopo                     │
│  done-log.md — cosa è stato fatto                │
│  SEMPRE letti per primi, SEMPRE aggiornati       │
│  Zero dipendenze. Sopravvivono a tutto.          │
│  ✅ GIA' COSTRUITO                                │
└──────────────────────────────────────────────────┘
```

### Storage (cosa usiamo sotto)

| Componente | Tecnologia | Perché |
|-----------|-----------|-------|
| Working memory | File .md su disco | Zero dipendenze, crash-proof |
| Episodica + Semantica | SQLite + vec0 + FTS5 | Già funzionante su ARM64 |
| Knowledge Graph | Tabella relazioni in SQLite | Leggero, niente Neo4j |
| Embeddings | Locale (all-MiniLM-L6-v2 ONNX) | Zero API esterne |
| Estrazione fatti | Kimi/Moonshot | Già configurato, economico |
| Compressione narrativa | Kimi o Haiku | Economico per compressione |

---

## Parte 5 — Piano di implementazione

### Fase 0: Fix TencentDB base (IN CORSO — Code sta facendo questo)
- Merge conservativo ✅ (fatto)
- Filtro istruzioni sistema ✅ (fatto)
- Parametri Kimi corretti ✅ (fatto)
- Soglia ricerca + recency ✅ (fatto)
- Gateway resiliente ✅ (fatto)
- Reindicizzazione dati ⬜ (fase 4-5 di Code, in corso)
- **Risultato atteso:** recall da 0/4 a 4/4 sui test base

### Fase 1: Ricerca ibrida FTS5 + vettori
- Aggiungere tabella FTS5 in SQLite accanto a vec0
- Ogni memoria indicizzata sia per keyword che per vettore
- Query: prima FTS5 (match esatto), poi vec0 (semantica), fusione RRF
- **Ispirato a:** claude-mem (hybrid search), Hindsight (4 strategie)
- **Effort:** medio — è un'aggiunta a TencentDB, non una riscrittura
- **Test:** cercare "FABLE_PLAN" deve trovare per keyword esatto

### Fase 2: Narrativa strutturata (L1 episodica)
- Cambiare l'estrazione: da blob a struttura Situazione→Azioni→Risultati→Lezioni
- Aggiungere Context Fingerprint a ogni sessione
- Ogni sessione diventa una "storia" cercabile
- **Ispirato a:** HEMA (arxiv 2504.16754), format SARI dalla scienza cognitiva
- **Effort:** medio — modifica i prompt di estrazione Kimi
- **Test:** dopo una sessione, chiedere "cosa è successo ieri" e ottenere una narrazione

### Fase 3: Knowledge Graph (L2 semantica)
- Nuova tabella `relations` in SQLite: source_id, target_id, relation_type, weight
- Tipi: CAUSED_BY, DECIDED_BECAUSE, REPLACED_BY, BLOCKS, FAILED_BECAUSE
- L'estrazione Kimi deve produrre anche le relazioni tra fatti
- Implementare Implicit Priming: fatto sotto soglia amplifica fatti collegati
- **Ispirato a:** Cognee (knowledge graph da dati non strutturati),
  arxiv 2605.08538v1 (implicit priming)
- **Effort:** alto — richiede design del grafo + modifica recall
- **Test:** cercare "IBAN" e trovare "lead perso" via priming

### Fase 4: Mistake Notebook (L3 procedurale)
- Nuova tabella `lessons` in SQLite: domain, pattern, lesson, evidence_count
- Alla consolidazione: raggruppare fallimenti per dominio, distillare lezioni
- Le lezioni hanno un contatore di evidenza (più fallimenti = più fiducia)
- **Ispirato a:** MNL (arxiv 2512.11485)
- **Effort:** medio — è un processo di consolidazione aggiuntivo
- **Test:** dopo 3 fallimenti simili, la lezione deve emergere automaticamente

### Fase 5: Consolidation Engine (L4)
- Processo che gira dopo la chiusura della sessione (hook SessionEnd)
- Episodio → Fatti atomici (L1 → L2)
- Clustering fallimenti → Lezioni (L1 → L3)
- Staleness: marca fatti non visti da >30 giorni
- Reinforcement: fatti visti in >3 sessioni → priorità più alta
- Contradiction check: se fatto A e fatto B si contraddicono → segnala
- **Ispirato a:** Väinämöinen (patrol), Letta (sleep-time), CLS theory
- **Effort:** alto — è il "cervello notturno" del sistema
- **Test:** dopo 3 sessioni, cercare un fatto menzionato in tutte e 3
  e verificare che ha priorità più alta di uno menzionato in 1 sola

### Fase 6: Proactive Injection (L5)
- Hook PostToolUse: quando l'agente apre un file → cerca fatti collegati
- Hook PostToolUse: quando l'agente vede un errore → cerca lezioni
- Context Fingerprint: match per situazione, non per contenuto
- Distinctive Term Indexing: dare peso 3x ai termini di progetto
- Budget token: max 500 token iniettati per turno (non intasare il contesto)
- **Ispirato a:** nessuno (idea originale, non esiste in nessun sistema)
- **Effort:** alto — richiede hook intelligente + retrieval veloce
- **Test:** aprire un file già modificato in passato e verificare che
  l'agente riceve automaticamente le decisioni prese su quel file

---

## Parte 6 — Cosa scartiamo (e perché)

| Idea | Perché la scartiamo |
|------|-------------------|
| Neo4j / database a grafo separato | Troppo pesante per setup locale ARM64. Il grafo lo facciamo in SQLite con una tabella relazioni — più leggero, stesso risultato. |
| Embeddings via API esterna (OpenAI) | Dipendenza da API = punto di fallimento. Embeddings locali ONNX sono più lenti ma zero dipendenze. TencentDB oggi usa OpenAI; migreremo a locale. |
| Replica completa di claude-mem | Non funziona su Windows ARM64 (ChromaDB + ONNX problematici). Prendiamo le idee, le implementiamo nel nostro stack. |
| Fine-tuning del modello (LoRA, EWC) | Richiede infrastruttura di training. Non pratico per il nostro caso — la memoria esterna è la strada giusta. |
| Differentiable memory (NTM, DNC) | Accademicamente affascinante, praticamente inutilizzabile per coding agent. |
| Complessità completa di Väinämöinen | 4 patrol al giorno, 5 componenti di trust scoring, Z-score outlier detection. Troppo per un setup di una persona. Prendiamo solo staleness + contradiction check. |

---

## Parte 7 — Glossario (per Lorenzo)

| Termine | Cosa significa |
|---------|--------------|
| **FTS5** | Full-Text Search 5 — tecnologia di SQLite per cercare parole esatte nel testo. Velocissima. Come il Ctrl+F del database. |
| **vec0** | Estensione SQLite per salvare e cercare vettori (liste di numeri che rappresentano il "significato" di un testo). |
| **Embedding** | Trasformare un testo in una lista di numeri (es. 384 numeri) che cattura il suo significato. Testi simili → numeri simili. |
| **ONNX** | Formato per far girare modelli AI in locale, senza chiamare internet. |
| **FTS5 + vec0** | Ricerca ibrida: cerchi sia per parole esatte sia per significato. Meglio di entrambi da soli. |
| **RRF** | Reciprocal Rank Fusion — modo di combinare i risultati di due ricerche diverse in una classifica unica. |
| **Hook** | Pezzo di codice che si attiva automaticamente quando succede qualcosa (es. "quando l'agente apre un file"). |
| **Priming** | Un ricordo che non emerge alla coscienza ma influenza cosa pensi dopo. Come l'odore del caffè che ti fa pensare a quella mattina. |
| **Knowledge Graph** | Rete di fatti collegati tra loro. Non una lista piatta ma un grafo dove puoi navigare da un fatto all'altro seguendo le relazioni. |
| **Consolidazione** | Il processo di trasformare un'esperienza (episodio) in conoscenza permanente (fatto). Il cervello lo fa nel sonno. Noi lo facciamo con un processo dopo la sessione. |
| **Staleness** | Quando un fatto diventa "vecchio" perché non è stato rinforzato da nuove sessioni. Non viene cancellato ma abbassato di priorità. |
| **Context Fingerprint** | L'impronta di una sessione: quali file, errori, tool, tipo di task. Usata per trovare sessioni SIMILI, non testi simili. |

---

## Parte 8 — Riferimenti completi

### Sistemi esistenti analizzati
1. **claude-mem** — github.com/thedotmack/claude-mem (89K stelle, v12.6)
2. **Hermes** — approccio curated facts (mindstudio.ai/blog/claude-code-memory-systems-compared)
3. **Väinämöinen** — gist.github.com/MagnaCapax/748b0be92dc31d4f5b6ba13286203766
4. **MemOS** — github.com/MemTensor/MemOS (36K stelle)
5. **Letta/MemGPT** — letta.com (OS-inspired memory hierarchy)
6. **Mem0** — mem0.ai (memory layer for AI apps)
7. **Cognee** — open-source knowledge graph layer
8. **Hindsight** — 4 strategie di retrieval parallele con cross-encoder
9. **TencentDB** — fork locale di Lorenzo (il nostro punto di partenza)

### Paper accademici
10. McClelland et al. (1995) — Complementary Learning Systems
11. Kumaran, Hassabis & McClelland (2016) — "What learning systems do intelligent agents need?"
12. HEMA (2025) — arxiv.org/pdf/2504.16754
13. Human-Inspired Memory for LLM Agents (mag 2026) — arxiv.org/html/2605.08538v1
14. Mistake Notebook Learning (2025) — arxiv.org/pdf/2512.11485
15. MemOS (2025) — arxiv.org/pdf/2507.03724
16. ImplicitMemBench (apr 2026) — arxiv.org/html/2604.08064v1
17. MAGMA (2026) — arxiv.org/html/2601.03236v2
18. Hippocampus for Agentic AI (feb 2026) — arxiv.org/pdf/2602.13594
19. HiMeS (gen 2026) — arxiv.org/abs/2601.06152
20. AI Meets Brain Survey (dic 2025) — arxiv.org/html/2512.23343v1
21. State of AI Agent Memory 2026 — mem0.ai/blog/state-of-ai-agent-memory-2026
22. MemAgents Workshop ICLR 2026 — openreview.net/pdf?id=U51WxL382H

### Review e confronti pratici
23. DataCamp claude-mem guide — datacamp.com/tutorial/claude-mem-guide
24. 8 Frameworks Compared — vectorize.io/articles/best-ai-agent-memory-systems
25. 6 Best Frameworks 2026 — machinelearningmastery.com
26. Top 10 AI Memory Products — medium.com/@bumurzaqov2
27. Context manipulation attacks — arxiv.org/pdf/2506.17318 (sicurezza della memoria)

---

> **Nota finale:** Questo documento è il blueprint. È vivo — ogni fase
> completata aggiorna questo file. Se questa chat finisce e ne ricominciamo
> un'altra, QUESTO DOCUMENTO è il punto di partenza. Contiene tutto:
> il problema, le fonti, le idee, il piano, le decisioni.
>
> Prossima azione: completare la Fase 0 (fix TencentDB base, Code in corso),
> poi iniziare la Fase 1 (ricerca ibrida FTS5).
