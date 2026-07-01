# Design — Il taccuino dei modi d'uso (behavioral/usage learning)

**Date:** 2026-07-01
**Status:** DESIGN (verifica radice FATTA + provata). Build a slice.
**Mandato Lorenzo:** completare Pilastro B "davvero bene" PRIMA dell'idea chat. Scelte: (1) imparare TUTTO IN PIENO — sia "come lavorare con te" sia "cosa fai"; (2) minare ANCHE lo storico (29.548 msg chat) oltre al going-forward.
**Radice provata:** vedi memoria `sinapsys-behavioral-learning-gap`. Riassunto: il solo distiller di lessons filtra `type='bug'` (`bug-clusters.ts:98`); il distiller di principi (`principle-clusters.ts`) esiste ma `DEFAULT_ELIGIBLE_TYPES=["decision"]` → ignora preference/observation; il corpus chat è in silo L0 mai letto.

---

## 0. REVISIONE 2026-07-01 (dopo la sfida di Lorenzo "è la strada giusta o un ripiego?")
Verifica sui dati veri: gli 8 `preference_stated` live NON condividono alcuna entità tra loro (0 coppie) → il clustering per-entità di `selectPrincipleClusters` ne raggrupperebbe ZERO. Inoltre 6/8 non sono preferenze ma note di stato (l'estrattore misclassifica). **Conclusione: "allargare eligibleTypes" era un ripiego — non funziona.** Architettura corretta = DUE percorsi distinti (sotto). Il §1 originale (estendere principle-clusters) resta valido SOLO per il percorso impliciti/tendenze, NON per le leggi esplicite.

## 0b. Architettura corretta — due percorsi (Complementary Learning Systems fatto bene)
**Percorso A — LEGGI ESPLICITE ("come lavorare con te"): IL CUORE.**
Direttive/correzioni dette da Lorenzo ("aspetta la mia risposta", "non compiacere", "battere i sistemi esistenti"). Proprietà: dette UNA volta, autorevoli SUBITO (il guard ≥2 sessioni è SBAGLIATO qui), spesso senza entità (il clustering non le prende mai). → Macchina = **cattura-nel-momento** + atomo "legge" ad alta fiducia (come una memoria confermata) + injection proattiva + tempra/rinforzo dalle PAROLE di Lorenzo (ponte willingness Pilastro B). NIENTE clustering. Richiede un **rilevatore di direttive affidabile** (3ª radice: l'estrattore oggi le perde — vedi §0).

**Percorso B — TENDENZE IMPLICITE ("cosa fai" + abitudini).**
Pattern che emergono su molte sessioni (dominî, forme di task, tendenze). Qui il guard anti-aneddoto è GIUSTO. Macchina = clustering **semantico** (embeddings, come bug-clusters) — QUI l'estensione di `principle-clusters`/clustering è legittima. Il corpus chat (Slice 3) alimenta QUESTO percorso.

Il prodotto = un **contratto comportamentale** (leggi dette + tendenze osservate) che viene all'agente e si auto-corregge. Fuori dall'ordinario (ambition bar).

## 1. [SUPERATO dal §0b per il percorso A] Principio originale: ESTENDERE, non rifare
La macchina cross-sessione anti-aneddoto **esiste già**: `selectPrincipleClusters` (Pilastro C Fase 2) — deterministica, clustering per entità condivisa, guard ≥2 eventi su ≥2 `session_id`, scrive atomi `principle`. Vale per il Percorso B (tendenze), NON per il Percorso A (leggi).

## 2. Il segnale che scatta DAVVERO per un non-coder
Lorenzo non valida codice → il segnale willingness di Pilastro B (bottoni su interrupt di CODICE) per lui è quasi morto. Il segnale vivo per lui è il suo **linguaggio naturale**: le sue correzioni ("non partire prima della mia risposta", "troppo lungo", "non compiacere"), le preferenze, i modi d'uso. Questi sono GIÀ catturati come eventi (`preference_stated`=8, `observation`=234, `decision`=110) — ma inerti. Il taccuino li rende durevoli + iniettabili + soggetti a rinforzo/correzione dalle sue PAROLE.

## 3. Le due facce (scelta "tutto in pieno")
- **COME lavorare con te** (process/preferenze/tono/do-&-don't): pattern comportamentali → regola come mi comporto. Fonte: preference_stated, observation con correzione, le sue direttive.
- **COSA fai** (progetti, task ricorrenti, domini, bisogni tipici): pattern d'uso → arricchisce il contesto/persona. Fonte: decision, task, observation, il corpus chat.

## 4. Il nodo tecnico vero (dove il design deve essere bravo)
`selectPrincipleClusters` raggruppa per **entità KB condivisa**. Molti pattern comportamentali NON ancorano a un'entità ("aspetta la mia risposta" non ha un file/persona come domain). Serve un secondo asse di clustering **per tema/semantica** (embeddings, come bug-clusters) accanto a quello per-entità. Questo è il lavoro di design centrale — NON banale, va fatto bene.

## 5. Slice (rivisto §0b — due percorsi)
**Percorso A — LEGGI ESPLICITE (il cuore, si costruisce per primo):**
- **Slice A1 — cervello puro (no LLM, no live):** rilevatore deterministico di direttive (marker imperativi/negazione/"sempre|mai|d'ora in poi"|cue di correzione) → decisione "questa è una legge?"; modello dell'atomo "legge" (testo regola, scope, trust=alta perché detta da Lorenzo, stato attivo/superato); NIENTE guard ≥2 sessioni (autorevole subito). Testabile su frasi reali.
- **Slice A2 — wiring LIVE:** cattura la legge quando Lorenzo la pronuncia (going-forward), la scrive come atomo ad alta salience, la inietta proattivamente (come la persona), e la TEMPRA/rinforza dalle sue parole successive (ponte willingness Pilastro B: legge ribadita→sale, ritirata→lapide).
- **Slice A3 — raffinamento LLM del rilevatore** (opzionale, dopo A1/A2 verdi): l'LLM conferma/estrae la regola pulita dai candidati del cervello deterministico. Costo LLM piccolo (solo sui candidati), non un batch.

**Percorso B — TENDENZE IMPLICITE:**
- **Slice B1 — cervello:** clustering semantico (embeddings) dei comportamenti/tendenze che NON hanno entità, accanto al per-entità esistente; categoria `usage`. Guard anti-aneddoto ≥2 sessioni.
- **Slice B2 — wiring LIVE going-forward.**
- **Slice B3 — BACKFILL storico (GATED, costo LLM reale):** de-siloizzare L0 (29.548 msg) → estrarre eventi comportamentali → distiller Percorso B. Batch grosso ($ + tempo) → **OK esplicito di Lorenzo prima di lanciare** (porta a senso unico: spesa). Lorenzo ha confermato le 3 fette; il gate resta solo sul MOMENTO del lancio del batch.

Ordine: A1 → A2 (valore subito, il pezzo che serve a un non-coder) → B1 → B2 → (A3) → B3.

## 6. Invarianti
- Deterministico nel cervello; LLM solo dove serve (distillazione testo), errori ingoiati, off critical path.
- Anti-aneddoto: ≥2 sessioni sempre. Additivo: nessuna colonna/atomo rimosso.
- Non duplicare la persona deterministica (`projections.ts`): il taccuino ALIMENTA la persona/injection, non la reimplementa.
- La memoria non rompe MAI la conversazione.

## 7. Verifica (definizione di "fatto bene")
- Un pattern comportamentale ricorrente su ≥2 sessioni (es. "aspetta risposta") diventa un atomo e mi VIENE incontro senza cercarlo.
- Una tua correzione in parole tempra/rinforza il pattern giusto.
- Il backfill (se autorizzato) produce N pattern d'uso reali dai tuoi 2 anni di chat, non aneddoti.
