# Sinapsys — Recall associativo-first (la situazione è l'indirizzo)

> Design doc. Data: 2026-07-07. Branch: `feat/memory-excellence`.
> Scheda memoria: `sinapsys-recall-redesign`. Handoff: `docs/SINAPSYS-RECALL-REDESIGN-HANDOFF.md`.
> Fonda su: `2026-06-30-spreading-activation-associative-recall-design.md`,
> `2026-06-24-context-fingerprint-design.md`, `2026-06-29-session-continuity-dove-eravamo-design.md`.

> **📌 NOTA IMPLEMENTAZIONE (2026-07-07, aggiornata post-build).** A/B1/B2a sono COSTRUITI, verificati live e pushati
> (`abf1cd5`/`b1223d5`/`5a33488`). L'implementazione reale è più DRY del §4.2: il modulo previsto **`associative-recall.ts` (N2)
> NON è stato creato** — si riusa direttamente `store.associativeExpand()` (che già fa spread→vicinato→memoria) dentro
> `runKbRecall`, seminato dalla situazione via `situation-cue.ts` (N1, costruito com'era). B1 ha aggiunto `recall-confidence.ts`
> + il gate "due marce"; B2a ha aggiunto `reinforceRecalledOwners()`. Stato vivo autoritativo:
> `docs/SINAPSYS-RECALL-REDESIGN-HANDOFF.md` + scheda `sinapsys-recall-redesign`. Questo spec resta valido come VISIONE
> dell'arco A→B→C; per il "cosa è a terra" leggi l'handoff. (Il piano `plans/2026-07-07-recall-associative-first-A.md` copre A.)

## 0. La frase che tiene tutto

Sinapsys deve smettere di **cercare per parole** e cominciare a **ricordare per situazione**:
la situazione in cui ci troviamo (quale progetto, cosa stavamo facendo, "dove eravamo") è
l'**indirizzo**; da lì l'attivazione si propaga sul grafo e i ricordi connessi **vengono
all'agente**, fermandosi a un vicinato limitato. Ricostruzione dal contesto, non lookup globale.
Più Sinapsys ricorda → rete più densa → recall **più preciso, non più lento**.

Non è la versione ordinaria (RAG / scansione vettoriale). È il cuore che tutti i sistemi
*non* hanno: la memoria che ti torna in mente da sola perché sei tornato nel posto giusto.

## 1. Il problema, verificato nel codice (non a memoria)

Anche dopo i fix del banner (`05bd183` skipVector, `6bb70c8` cornerstone-yield), il baricentro
del recall è ancora **query-testo-centrico**:

| Organo | Dov'è | Cosa fa oggi | Il difetto |
| :-- | :-- | :-- | :-- |
| `kbRecall` | `src/core/kb/retrieval.ts` | 3 sorgenti (FTS · vettoriale · entity-match) su `userText` → RRF → reweight → priming → calibrazione | **L'indirizzo è il testo della query.** |
| `searchKbVector` | `src/core/store/sqlite.ts:3829` | `vec0 … MATCH k` = KNN **esatto** su tutti i ~25k vettori | O(N) lineare, nessun HNSW; + embedding remoto ~2s |
| `spreadActivation` / `associativeExpand` | `src/core/kb/spreading-activation.ts`, `sqlite.ts:2392` | attivazione pesata/decadente/convergente sul grafo `relations` | **Ottimo, ma cablato come espansione *additiva DOPO* la query** (`auto-recall.ts:695`) — è il contorno |
| Semi dello spreading | `auto-recall.ts:706` | `seedEntityIds = visible.map(r => r.entity_id)` | **I semi nascono dal testo della query.** All'apertura sessione la query è il saluto → cue debole → associazione da quasi nulla |
| Situazione (Context Fingerprint) | `tdai-core.ts:879`, `hooks/session-situation.ts`, `hooks/fingerprint-injection.ts` | `{fileKeys, errorSignatures, toolNames, taskType}` → owner match → injection separata | **Non semina il recall.** Vive in un percorso di injection a parte |
| "Dove eravamo" | `continuity/recap-capture.ts`, `recap-rollover.ts` | evento `session_recap` con `text` + `source_message_ids` + `entities` | Alimenta il banner, **non** semina il recall |
| Cornerstone | `distinctiveness/cornerstone-selector.ts` | top-K memorie distintive | Alimenta il banner, **non** semina il recall |

**Diagnosi in una riga:** gli organi della "situazione" esistono tutti, ma **nessuno semina lo
spreading activation**. Il recall parte dal testo. Il lavoro non è inventare: è **collegare la
situazione ai semi** e rendere l'attivazione associativa il **recall principale** di System 1.

## 2. I 5 principi (north-star) e come questo doc li serve

1. **La situazione è l'indirizzo** → seeds dalla situazione → spreading activation → vicinato
   limitato. *(Incremento A — costruito ora.)*
2. **Due marce (S1/S2)**: veloce-associativa di default; "a sforzo" su richiesta solo se serve.
   *(A pone S1; B aggiunge il quality-gate e S2 deliberato.)*
3. **Non dimentica**: velocità dalla struttura (grafo denso), non dall'oblio. *(A: O(vicinato).)*
4. **Ogni richiamo rinforza** (Hebbian): l'uso consolida le "autostrade". *(Incremento B.)*
5. **Proattivo / grounded-trust**: chiede conferma quando incerto+importante. *(Già progettato;
   B lo aggancia al nuovo recall.)*

## 3. L'arco completo (A → B → C) — così non perdiamo un grammo di visione

- **A — Il cuore associativo-first (QUESTO doc costruisce A).** La situazione semina lo spreading
  activation; l'attivazione dal vicinato è il recall **primario** di System 1; il testo della
  query è un cue **secondario**. Zero scansione globale, zero embedding sul path veloce.
- **B — Le due marce + rinforzo.** Quality-gate `needsDeliberation()` che escala a System 2
  (Full Deliberation) solo quando il vicinato di S1 è magro/basso; write-back Hebbian che alza
  `relations.support` sui percorsi effettivamente usati/confermati.
- **C — L'infrastruttura sublineare.** Embedding **locale** (Ollama `nomic-embed-text` 768,
  vedi `sinapsys-local-llm-stack`) per azzerare i ~2s di rete + indice **navigabile (HNSW)** così
  anche System 2 è O(log N) a qualsiasi scala. Richiede reindex ~25k vettori a 768 dim.

A stabilisce le interfacce (situazione→seeds→spread→vicinato→rank) che B e C **estendono**, non
riscrivono.

## 4. Incremento A — architettura (cosa costruiamo ORA)

### 4.1 Principio di isolamento
File piccoli, una responsabilità ciascuno, funzioni pure dove possibile, immutabili, mai
un'eccezione che rompe la conversazione (tutto best-effort → degrada al comportamento attuale).

### 4.2 Componenti

**(N1) `src/core/kb/situation-cue.ts`** — *nuovo, ~150 righe, puro rispetto allo store (nessun
side effect, mai throw).*
La responsabilità unica: **dalla situazione ai semi pesati**.
```
buildSituationSeeds(store, ctx): ActivationSeed[]   // { id: entityId, activation: weight }
```
`ctx = { sessionKey, currentSessionId, project, situation?: SessionSituation, namespace }`.
Assembla seed entity-ids da 4 sorgenti, ognuna best-effort e pesata (peso = quanto quella
sorgente descrive "dove siamo ORA"):

| Sorgente | Da dove | Peso indicativo | Perché |
| :-- | :-- | :-- | :-- |
| **"Dove eravamo"** | `session_recap` più recente per `sessionKey` → entità del thread ancorato (via `source_message_ids` → eventi → `entities`) | **1.0** | è letteralmente dove eravamo |
| **Cornerstone** | `selectCornerstones` → entità proprietarie | 0.7 | i pilastri distintivi del progetto |
| **Context-fingerprint** | `queryContextFingerprints` → `matchedOwnerIds` risolti a entità | 0.7 | situazione (file/errori/task) che in passato ha fatto emergere memoria |
| **Lavoro recente** | `situation.fileKeys` → `resolveFileOwnerId` → entità; + eventi recenti del progetto | 0.4 | il "posto" fisico in cui stiamo lavorando |

Regole: dedup per `entityId` (tieni il peso massimo); cap totale (es. 24 semi) ordinati per peso;
se una sorgente fallisce, si salta (non blocca le altre); se **tutte** vuote → `[]` (cold start).

> Nota timing (verificata): all'**apertura sessione** la `SessionSituation` è vuota (nessun tool
> ancora osservato), quindi i semi vengono da recap + cornerstone + fingerprint — che è
> esattamente corretto. **Mid-sessione** i `fileKeys` correnti aggiungono i semi del "posto".

**(N2) `src/core/kb/associative-recall.ts`** — *nuovo, ~150 righe.*
La responsabilità unica: **dai semi al recall dal vicinato**.
```
associativeRecall(store, seeds: ActivationSeed[], opts): KbRecallResult[]
```
Passi: `spreadActivation(seeds, neighborsOf, params)` (riusa l'organo esistente; `neighborsOf`
costruito da `queryRelationsForEntity` pesato su `support`, memoizzato per chiamata come già fa
`associativeExpand`) → per ogni entità attivata risolvi **una** memoria rappresentativa (HEAD
fact, else evento più recente) → **riordino locale** (attivazione × recency × salience) → top-K.
Bounded (`maxNodes`, `topKPerNode`, `threshold` dai default già tarati: hops 2, decay 0.5,
maxNodes 50, topK 8). Mai throw → `[]` su qualunque errore. **Nessun embedding, nessuna
scansione globale.**

> Rapporto con `associativeExpand` esistente: `associativeRecall` è il fratello "primario" —
> stessa meccanica di spread, ma (a) seminato dalla **situazione** non dalla query, (b) ritorna
> risultati **rankati** (non solo additivi). Fattorizzeremo la logica condivisa
> (`neighborsOf` + risoluzione entità→memoria) in un helper riusato da entrambi per non duplicare.

**(M1) `src/core/hooks/auto-recall.ts` → `runKbRecall`** — *wiring, diff mirato.*
Sul path System 1 (`skipVector` già attivo):
1. costruisci `seeds = buildSituationSeeds(store, ctx)`;
2. `assoc = associativeRecall(store, seeds, …)` = sorgente **primaria**;
3. mantieni `kbRecall(userText, { skipVector:true })` (FTS + entity-match) come cue **secondario**
   sul testo dell'utente;
4. **fondi** primario + secondario per owner-id (dedup; l'attivazione-da-situazione e il match-da-
   testo si sommano, come già fa il priming), calibra, top-K.
La firma di `runKbRecall` acquisisce il contesto-situazione necessario (`sessionKey`,
`currentSessionId`, `project`, `situation`) — già disponibili nel chiamante `performAutoRecall`.

### 4.3 Data flow — apertura sessione (il caso del banner)
```
session-open, 1° turno
  └─ performAutoRecall
       ├─ buildSituationSeeds ──► recap("dove eravamo") + cornerstone + fingerprint + file recenti
       │                          → semi pesati (entity ids), ZERO embedding
       ├─ associativeRecall ────► spread sul grafo relations → vicinato limitato
       │                          → memoria rappresentativa/entità → riordino locale → top-K
       ├─ (secondario) kbRecall(saluto, skipVector) ──► FTS/entity-match sul testo (poco, sul saluto)
       ├─ fusione + calibrazione ──► ricordi finali
       └─ compose banner + ricordi   ► completo, <4s, per il MOTIVO GIUSTO (vec=0, no scan globale)
```

### 4.4 Gestione errori (la memoria non rompe MAI la conversazione)
Ogni sorgente di `buildSituationSeeds` e ogni passo di `associativeRecall` è in `try/catch` →
degrada. Se i semi-situazione sono vuoti o l'associativo fallisce, il path **cade sul comportamento
attuale** (cue-da-testo). Nessun percorso nuovo è sul path critico oltre il budget già esistente
(`searchTimeoutMs`). Tutto loggato con `${TAG}`.

## 5. Cosa NON fa l'incremento A (YAGNI / confine netto)
- **No** embedding locale, **no** HNSW, **no** reindex → Incremento C.
- **No** quality-gate S1→S2, **no** write-back Hebbian → Incremento B.
- **No** modifica al tool esplicito `memory-search.ts` (resta System 2, tiene il vettoriale).
- **No** refactor non necessari degli organi esistenti (spreadActivation, cornerstone, recap
  restano invariati; li *chiamiamo*, non li riscriviamo).

## 6. Test (non circolari — lezione `agent-features-circular-tests`: verificare sulla forma dati REALE)

- **Unit `situation-cue`:** store seminato con un `session_recap` reale + cornerstone + fingerprint
  + file → `buildSituationSeeds` ritorna gli entity-id attesi con i pesi attesi; dedup tiene il
  peso massimo; una sorgente in errore non azzera le altre; tutto vuoto → `[]`.
- **Integrazione (la prova del ribaltamento):** grafo dove le entità-situazione sono connesse a
  una memoria che il **saluto non nomina mai** → `associativeRecall` la fa emergere **con
  `searchKbVector` NON chiamato** (spy/assert `vec=0`). Prova che l'associazione dalla situazione,
  non il testo, guida il recall.
- **Regressione:** i 7 test `retrieval` + i 113 hook restano verdi; il path cue-da-testo invariato
  quando i semi-situazione sono vuoti (cold start / nessun regresso).
- **Live (verifica vera, non "compila"):** build tsdown → gateway stop/start → `/recall` su una
  sessione reale (Sofia `session_key`): banner **completo** + **<4s**, log mostra le sorgenti dei
  semi e **`vec=0`**; il recall porta almeno un ricordo connesso-ma-non-nominato.

## 7. Rischi / da verificare in fase di piano (onestà: NON confermato ora)
- **Entità del recap:** confermare che l'evento `session_recap` esponga entity-id risolvibili da
  seminare; se `entities` porta solo tag (es. `branch:`), risolvere via `source_message_ids` →
  eventi → loro `entities`. *(Verifica al piano.)*
- **Densità del grafo:** i semi-situazione devono avere `relations` sufficienti perché lo spread
  renda. Post-digest `relations` = 6.026 su 9.843 entità → plausibile, **da misurare** sul vicinato
  reale (non assumere).
- **Cold start** (progetto nuovo, nessun recap/cornerstone): semi vuoti → fallback pulito al
  cue-da-testo. Nessun regresso, ma da testare esplicitamente.
- **Peso relativo delle sorgenti:** i pesi in §4.2 sono un punto di partenza; da tarare sulla
  verifica live (quali semi fanno emergere i ricordi giusti).

## 8. Definizione di "fatto" per l'incremento A
Verde sui test (unit + integrazione anti-scan + regressione) **e** verifica **live**: banner
completo <4s con `vec=0` e semi=situazione su sessione reale, ≥1 ricordo associativo non-nominato.
Solo allora: commit sul branch (mai main) + aggiornamento scheda memoria. Poi si progetta B.
