# Sinapsys — Recall Redesign & Vision Handoff (2026-07-06)

> **LEGGI QUESTO PER PRIMO nella nuova sessione.** Cattura la visione, la ricerca, lo stato reale e i prossimi passi. Nessun contesto va perso.

---

## 0-bis. ⚠️ VERA ROOT CAUSE DEL BANNER — TROVATA+FIXATA (2026-07-07, `6bb70c8`)

Anche dopo `skipVector`, il banner "sul pezzo" NON arrivava in una sessione nuova. Causa reale (profilata/misurata, non ipotizzata): sul **cornerstone-cache MISS = primo turno di OGNI sessione**, `buildNeighborMap` (`src/core/distinctiveness/cornerstone-runner.ts`) faceva un loop su ~200 candidati, ognuno con una `searchKbVector` (KNN **brute-force SINCRONA** su ~25k vettori kb_vec), **senza mai cedere l'event-loop**. Post-digest (2k→25k vettori) ogni scan è passato da ~40ms a ~0,7–1,9s → 200× = **minuti di event-loop bloccato** → `/health` e il `/recall` del banner in timeout (cc 4s) → banner scartato. `node:sqlite` è **sincrono**: una funzione `async` che gira un loop sincrono blocca tutto lo stesso — "fire-and-forget" non salva. **FIX** = `await setImmediate` dopo OGNI scan (max ~1 scan ~1s in volo) + `eventLimit` 200→50. **Verifica live**: cornerstone build completa (3 cornerstones), **0 timeout** su 230 probe `/health` durante la build (prima: 30+ consecutivi), banner recall **1,5–1,9s <4s**, banner completo ("Sul pezzo"+"Dove eravamo"+relevant-memories) presente. Gemello fixato: usage-clusters O(N²) cappato a 300 (`be5e5b1`). **Lezione durevole**: qualsiasi lavoro pesante (scan vettoriali, O(N²)) su un loop non-yielding affama il turno — il redesign associativo-first deve eliminare gli scan globali, non solo spostarli.

## 0. Dove siamo (stato reale, verificato)

- **Digest chat claude.ai = COMPLETATO** (17,8h, in autonomia con un guardiano scheduled-task auto-guaritore che si è auto-rimosso a fine). 664/664 sessioni, **624 con eventi** (40 vuote/saluti = 0 corretto), **10.720 eventi chat** nel grafo.
- **Il grafo è cresciuto ×~14**: events ~800→**11.661**, facts ~1.200→**15.232**, entities ~1.000→**9.843**, **relations 436→6.026**.
- **~~PROBLEMA CRITICO~~ → FIX INTERMEDIO FATTO+VERIFICATO LIVE (2026-07-06, commit `05bd183`):** il banner "sul pezzo" non arrivava perché il `/recall` impiegava **~11s** (ricerca vettoriale brute-force globale O(N) su ~27k vettori) > timeout cc **4s** → banner scartato. **FIX** = `skipVector` sul percorso auto-recall (System 1): la scansione vettoriale globale è saltata sul path banner; FTS + entity-match seminano lo spreading activation (recall associativo intatto). La ricerca esplicita (memory-search tool, System 2) tiene il vettoriale. **Verifica live: recall 11s → 2,6–2,9s (3/3 sotto i 4s), `vec=0` sul path auto, 7 test retrieval + 113 hook verdi.** Gateway ribuildato+riavviato (PID nuovo). NB: restano ~2s di embedding remoto della query nel path searchMemories (System 2 legacy) — non sul path banner; il redesign vero (embedding locale + O(vicinato)) lo assorbe.
- Commit di sessione (fork `feat/memory-excellence`, mai main): sistema immunitario (`c9e92e7`,`06aa41c`), fallback gpt-5.4-mini (`6f99e91`,`96f49be`), endpoint `/digest` (`e8faaa4`), cursore composito recorded_at+rowid (`2f0a475`), requestTimeout 60min (`b1e4c18`). Tutto pushato.

## 1. La sfida (parole di Lorenzo + sintesi)

Sinapsys deve essere **come un umano con memoria fotografica che non dimentica MAI nulla, ma con gli steroidi**: (a) ricorda tutto, (b) richiama in un lampo per associazione, (c) recupero "a sforzo su richiesta" per cose precise di anni fa, (d) **interagisce proattivamente** — "rompe le scatole" per conferme, per auto-apprendere, affinare i percorsi del codice e il metodo.
Il freno di Lorenzo (giustissimo): NON ricadere sulla versione ordinaria (patch da database: mmap/cache/ANN/quantizzazione buttati sul problema). Prima chiedersi sempre: **cos'è Sinapsys? cosa cerchiamo?** → memoria ASSOCIATIVA, ricostruzione non lookup, che diventa più ricca crescendo.

## 2. Q&A + ricerca (verificata sul web, 2026)

**D: Gli umani con memoria totale (HSAM/ipertimesia) — cos'hanno verificato?**
R: Non "ricordano di più" → **dimenticano di meno** + **recuperano più veloce**. Meccanismo: nucleo **caudato** ingrossato (circuito associativo) + **rievocazione ossessiva** che **incastona ogni ricordo in una rete associativa densa** ("embed information within a larger memory network"). Recupero per associazione, selettivo (auto-referenziale). Il cervello normale dimentica APPOSTA per efficienza; loro hanno quel filtro rotto. → **La velocità viene dalla STRUTTURA densa, non da un archivio più grande.**

**D: Come fa un LLM a ricordare tutto e associare veloce — solo potenza?**
R: **No, architettura.** Gli strati FFN sono **memoria associativa key-value content-addressable**: la query È l'indirizzo, **nessuna scansione** (accesso associativo diretto, ~O(1)). Modern Hopfield / dense associative memory = capacità enorme + retrieval content-addressable.

**D: Qualcuno l'ha già fatto?**
R: Sì, 2026, converge su di noi: **SYNAPSE** (episodico-semantico via *spreading activation*, fondamenta Anderson 1983 / Collins&Loftus 1975); **Continuum Memory (CMA)**: "retrieval per **associative routing**, l'attivazione si propaga lungo i legami, multi-hop anche se i termini non sono nella query, **ogni accesso rafforza** ciò che si usa"; Microsoft Human-Inspired (vector+graph+sleep-consolidation+Ebbinghaus decay+reconsolidation); ACT-R; HeLa-Mem (Hebbian).

**D (intuizione di Lorenzo): il recupero "a sforzo su richiesta"?**
R: È il **doppio processo (Sistema 1/2)**. S1 = veloce/associativo/parallelo (~decine ms, pattern-completion da un cue). S2 = lento/deliberato/seriale (secondi, ricerca esaustiva) quando il cue non basta. **D-Mem (2026)** fa proprio così: recupero associativo veloce di default + *quality-gate* che attiva la "Full Deliberation" esaustiva solo se serve. E con l'esperienza S2→S1 migra (i percorsi si automatizzano = "affinare i percorsi").

**Tecnica del "non dimentica MA veloce a scala":** **HNSW/NSW** = memoria content-addressable **sublineare (logaritmica)** su grafo "small-world" cervello-like (nodi distanti in pochi salti, niente confronto uno-a-uno) + quantizzazione a scala miliardi. → **Non serve dimenticare per essere veloci; serve la struttura giusta.** Puoi tenere TUTTO ed essere logaritmico.

## 3. La direzione (north-star) — i 5 principi del nuovo recall

1. **La situazione è l'indirizzo**: il Context Fingerprint (progetto, lavoro recente, "dove eravamo", cornerstone) è il cue → l'attivazione si propaga sul grafo (spreading activation — **organo già esistente**) verso un **vicinato limitato**. **O(vicinato)/O(log N), non O(tutto)** → veloce per sempre, più ricco crescendo.
2. **Due marce (S1/S2)**: veloce-associativa di default (il banner, <4s); **a sforzo** su richiesta (Full Deliberation) solo quando un quality-gate dice che la veloce non basta.
3. **Non dimentica**: teniamo tutto (Pilastro C: distilla non cancella). La velocità viene dalla struttura (grafo denso + densificazione co-occorrenza = Idea 2), non dall'oblio.
4. **Ogni richiamo rinforza** (Hebbian / CMA): l'uso/conferma rafforza il ricordo e consolida le "autostrade" → i percorsi si auto-affinano.
5. **Proattivo/grounded-trust**: self-questioning + chiede conferma a Lorenzo quando incerto+importante (il "bambino col fuoco", già progettato) → auto-apprende.

**Gli organi ci sono già** (spreading-activation.ts, context fingerprint, implicit-priming/co-occorrenza, cornerstone, decadimento-protetto, grounded-trust). Il lavoro NON è inventare: è **spostare il baricentro del recall da "scansione vettoriale globale" a "attivazione associativa dalla situazione + due marce"**, e usare il vettoriale solo come **indice navigabile (HNSW) o re-rank locale** sul vicinato attivato.

## 4. Fix intermedio "torna funzionante" — ✅ FATTO+VERIFICATO (commit `05bd183`)

**Fatto.** `skipVector` in `KbRecallOptions` (`src/core/kb/retrieval.ts`) gate della Source B; `runKbRecall` (`src/core/hooks/auto-recall.ts:644`) passa `skipVector:true` (System 1). La ricerca esplicita `memory-search.ts` NON cambia (System 2, tiene il vettoriale). Test dedicato in `retrieval.test.ts` (match solo-vettoriale sparisce con skipVector). Build tsdown → gateway stop/start (`C:\Users\lo\tdai-gateway\{stop,start}-gateway.ps1`). **Verifica live:** `/recall` su Sofia (`session_key=3e78aebfa57691fb`) = 2,6–2,9s (3/3 <4s), log `[kb-recall] ... vec=0`. NB: la prima richiesta dopo un restart può essere lenta (contesa da `resumeExtraction` al boot) — è transitorio, a regime è ~2,7s.
**Residuo per il redesign vero (§3):** i ~2s restanti sono l'embedding remoto della query nel path `searchMemories` (System 2, non il banner). Assorbiti da: embedding locale (Ollama, vedi [[sinapsys-local-llm-stack]]) + recall O(vicinato) ancorato alla situazione.

## 5. Lasciato indietro / TODO nuova sessione

- **VERIFICA CRONOLOGIA MESSAGGI (Lorenzo l'ha chiesta):** l'import chat ha dato a TUTTI i messaggi di una conversazione lo **stesso `recorded_at`** (un timestamp per conversazione). Abbiamo fixato la PAGINAZIONE del cursore (composito recorded_at+rowid), ma i timestamp degli eventi digeriti possono risultare **appiattiti** → verificare che l'ordine cronologico/temporale nel grafo sia corretto (impatta il recall temporale).
- **Fase 2 — sessioni Code sul disco (~1.513 mai ingerite in L0):** ingester per i transcript `.jsonl` + poi `/digest` (riusa tutta l'infrastruttura). ~1.646 file in `~/.claude/projects/*/`.
- **Pulizia scratch** (chiedere OK a Lorenzo): `b3-backfill-copy/_digest_*`, `_digest_supervisor.ps1`, `_kimi_probe*`, `_ollama*`, `_sids*`, `_l0*`, `_disk*` (gitignored, non più attivi).
- **Automatico + memoria dentro le chat** (l'altra metà del piano): auto-ingest nuove chat claude.ai + Sinapsys-in-chat (PULL via MCP + PUSH via estensione).
- **Il redesign vero del recall** (§3) — è il progetto principale.

## 6. Prima mossa nuova sessione
Leggi questo doc + la scheda memoria `sinapsys-recall-redesign`. Poi: (a) fix intermedio banner<4s se non già fatto, (b) progetta il recall associativo-first (§3), (c) build+verifica live (banner<4s per il motivo giusto).
