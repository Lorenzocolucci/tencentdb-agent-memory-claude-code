# Piano — Attaccare il filo staccato: consolidamento → recall

> ## ✅ FATTO — questo piano è stato eseguito
> Design-first 2026-08-07, **applicato e ACCESO lo stesso giorno**
> (`recall.consolidationBoost: true` nella config del gateway).
> Misura A/B sulla memoria vera: **9 query su 20 cambiano la top-8**, 2 su 20 cambiano il
> primo risultato. Codice: `candidateLifecycle` + `consolidationScore` in
> `src/core/kb/retrieval.ts`. Puramente additivo: un ricordo con 0 rinforzi si posiziona
> esattamente come prima.
>
> ⚠️ **Da leggere insieme al seguito:** il consolidamento rinforza ciò che *ricorre*, non ciò
> che *serve*. La misura di utilità è arrivata dopo — vedi [../STATO-REALE.md](../STATO-REALE.md)
> §4-ter (verdetto di utilità, 2026-08-23).
>
> Il testo sotto è il **piano originale**, tenuto come traccia del ragionamento.

> Design-first, 2026-08-07. Autore: Socio.
> Regola: nessuna modifica al path di recall live senza flag + fail-open + misura.

## 1. Il problema, in una riga

Il "sonno" di Sinapsys (consolidamento) lavora e produce segnale — **ma chi decide cosa
ricordare non lo guarda**. Fatica reale buttata via.

**Prove raccolte sul DB live (2026-08-07, sola lettura):**
- `memory_lifecycle`: **33.311 righe** (copre 97% dei fatti, 98% degli eventi).
- **835** ricordi promossi a `tier='long'` (hanno superato la soglia di permanenza).
- Rinforzi fino a **332** su un singolo fatto.
- Il ranking del recall (`src/core/kb/retrieval.ts`) **non legge NULLA di tutto questo**:
  - `factImportance()` (retrieval.ts:413) = media di `entity.importance`, `fact.confidence`, `fact.support`.
  - `eventImportance()` (retrieval.ts:423) = **costante 0.5** → tutti i 14.186 episodi valgono uguale,
    anche quello rinforzato 62 volte.

## 2. La verità scomoda (da dire PRIMA di costruire)

**Il segnale è SPARSO: il 95,5% dei ricordi ha `reinforcement_count = 0`.**
Solo ~1.500 su 33.311 (4,5%) sono differenziati.

Conseguenza onesta: **questo fix NON ribalta il recall in generale.** Agirà su ~4,5% dei ricordi.

Ma dove agisce, agisce **giusto**. I 5 fatti più rinforzati oggi sono:

| rinforzi | tier | fatto |
|---|---|---|
| 332 | long | `autoavvia: no` |
| 288 | long | `active_branch: fix/get-practice-status-clientid` |
| 265 | long | `monthly_cost_usd: 299` |
| 225 | long | `branch: v5-two-subagents` |
| 216 | long | `backup_llm: GPT-5.4` |

Sono **esattamente** le verità durature del mondo di Lorenzo. Il segnale è **raro ma affilato**:
è un booster di PRECISIONE sui ricordi già dimostrati durevoli, non un riordino di massa.

**Altri due buchi scoperti nella stessa ispezione** (fuori scope, da registrare):
- `state` = `active` per **33.311 su 33.311**: il decadimento non declassa MAI nulla.
- `salience` = 0 per il 98,9%: l'Idea 5 (Distinctive Terms) quasi non timbra.

## 3. Il fix (COSA / DOVE / PERCHÉ)

### 3a. Lettura in blocco del lifecycle (nuovo)
- **DOVE:** `src/core/store/sqlite.ts` — nuovo metodo `candidateLifecycle(ownerIds, namespace)`.
- **COSA:** UNA query con `IN (...)` che torna `Map<owner_id, {reinforcement_count, tier, permanence_score, state}>`.
- **PERCHÉ:** il recall è sul path critico; `getLifecycle()` esistente legge una riga alla volta
  (decine di query per recall = inaccettabile). Batch = 1 query.
- **Template già collaudato:** identico a `candidateAdjacency()` (sqlite.ts:2551) introdotto per
  l'Implicit Priming — metodo opzionale, duck-typed, fail-open.

### 3b. Il boost nel ranking
- **DOVE:** `src/core/kb/retrieval.ts` — `factImportance()`, `eventImportance()`, e il punto
  di reweight (retrieval.ts:552).
- **COSA:** un termine `consolidation` in [0,1], bounded, a rendimenti decrescenti:
  ```
  rinforzo   = log(1 + reinforcement_count) / log(1 + 10)      // 0→0, 3→0.60, 10→1, cap 1
  durata     = tier === 'long' ? 1 : 0
  consolidation = clamp01(0.7 * rinforzo + 0.3 * durata)
  ```
  - `factImportance` → media a 4 segnali (entità, confidenza, supporto, **consolidation**).
  - `eventImportance` → **smette di essere 0.5 fisso**: diventa `0.35 + 0.3 * consolidation`
    (un episodio rinforzato pesa più di uno mai riconfermato). **Questo è il guadagno maggiore.**
- **PERCHÉ:** rispetta la regola esistente — l'importanza resta un BOOST bounded
  (`IMPORTANCE_WEIGHT = 0.15`), la rilevanza resta primaria. Non può dirottare il recall.

### 3c. Gate + sicurezza
- Flag opt-in `consolidationBoost` in `KbRecallOptions` (**default OFF** → live invariato bit-per-bit).
- Fail-open totale: metodo assente / query fallita / riga mancante → `consolidation = 0` = comportamento di oggi.
- Zero migrazioni DB: **si legge soltanto**, nessuna scrittura, nessuna colonna nuova.

## 4. Come lo misuriamo (il punto più importante)

**LongMemEval NON può misurare questo — e ora so perché.**
Ogni domanda del benchmark semina una memoria vergine: lì i rinforzi valgono ~1 per tutti,
quindi il consolidamento non ha nulla da differenziare. **Ecco perché l'arm `kb_consol`
diede esattamente 0 di differenza.** Non era un fallimento del consolidamento: era il
banco di prova sbagliato.

Il valore del consolidamento esiste **solo su una memoria vissuta a lungo** — cioè i 2,5 GB veri di Lorenzo.

**Misura proposta (A/B sulla memoria REALE, sola lettura):**
1. Prendo ~20 query realistiche del lavoro vero (Sofia, Argus, branch, costi, decisioni).
2. Per ognuna: `kbRecall` con boost **OFF** vs **ON** sullo stesso DB (copia read-only).
3. Confronto: quante query cambiano la top-5, e **in che direzione**.
4. Verdetto onesto: se i ricordi che salgono sono quelli giusti (verità durevoli) → il filo serve.
   Se non cambia quasi nulla → lo dico e non lo accendiamo. **Nessun numero gonfiato.**

## 5. Rischi e ritorno indietro
- **Rischio prestazioni:** +1 query SQL per recall. Mitigato: batch singolo, indice PK già presente
  (`PRIMARY KEY (owner_id, owner_kind)`). Misuro il tempo prima/dopo.
- **Rischio regressione:** nullo a flag OFF (default). Si accende solo dopo la misura.
- **Rollback:** spegnere il flag. Nessun dato toccato.
- **Il DB live non viene MAI scritto** in tutta l'operazione.

## 6. Passi
1. `candidateLifecycle()` nello store + test (DB usa-e-getta).
2. Boost in `retrieval.ts` dietro flag + test che provi: a parità di rilevanza, il ricordo
   rinforzato/`long` sale sopra quello mai riconfermato; a flag OFF ordine identico a oggi.
3. Suite dei test toccati verde.
4. A/B su copia read-only della memoria vera → **report onesto a Lorenzo**.
5. Solo con OK di Lorenzo: accendere il flag nel gateway live + verifica live.

## 7. Cosa cambia per Lorenzo, in parole semplici
Oggi Sinapsys tratta allo stesso modo una cosa detta **una volta per sbaglio** e una cosa
confermata **332 volte**. Dopo il fix, quello che si ripete nel tempo pesa di più quando lei
sceglie cosa ricordarti — che è esattamente come funziona la memoria umana, ed è la stella
polare: *memoria che cresce con l'uso*, non un archivio piatto.
