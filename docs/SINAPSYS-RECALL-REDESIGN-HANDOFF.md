# Sinapsys — Recall Redesign & Vision Handoff (2026-07-06)

> **LEGGI QUESTO PER PRIMO nella nuova sessione.** Cattura la visione, la ricerca, lo stato reale e i prossimi passi. Nessun contesto va perso.

---

## 0. Dove siamo (stato reale, verificato)

- **Digest chat claude.ai = COMPLETATO** (17,8h, in autonomia con un guardiano scheduled-task auto-guaritore che si è auto-rimosso a fine). 664/664 sessioni, **624 con eventi** (40 vuote/saluti = 0 corretto), **10.720 eventi chat** nel grafo.
- **Il grafo è cresciuto ×~14**: events ~800→**11.661**, facts ~1.200→**15.232**, entities ~1.000→**9.843**, **relations 436→6.026**.
- **PROBLEMA APERTO CRITICO — Sinapsys non è funzionante dal vivo:** il banner "sul pezzo" NON arriva più. Causa **verificata deterministicamente**: il `/recall` impiega **~11s** (misurato) perché la ricerca vettoriale è **brute-force globale O(N) su ~27k vettori** (il gateway logga `vec=2000-10000ms`, tutto il resto ~0ms: persona 2ms, scene 1ms, fts 0ms). Il timeout lato cc-plugin è **4s** → l'intero recall supera i 4s → **il banner (presente e corretto nella risposta) viene scartato**. Il digest ha *rivelato* il difetto: più Sinapsys ricorda, più il recall lineare rallenta.
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

## 4. Fix intermedio "torna funzionante" (north-star, NON la toppa mmap)

Il banner (persona+recap+recent+cornerstone+spreading dal contesto corrente) è **veloce**. L'UNICA cosa lenta è la **scansione vettoriale globale** — che è proprio il pezzo estraneo da rimuovere. **Interim = System 1 fast path:** sul percorso auto-recall (apertura sessione/banner) la scansione vettoriale globale NON deve bloccare la risposta (demota/gate → diventa la marcia lenta "a richiesta"). Così il banner torna <4s SUBITO, ed è il **primo passo corretto** del redesign, non una patch da DB.
File probabili: `src/core/kb/retrieval.ts` (candidate source vettoriale), `src/core/hooks/auto-recall.ts` (compose), il timing è loggato dal gateway (`[recall] ⏱`). Prova = `/recall` con session_id nuovo su Sofia (`session_key=3e78aebfa57691fb`) < 4s + banner presente.

## 5. Lasciato indietro / TODO nuova sessione

- **VERIFICA CRONOLOGIA MESSAGGI (Lorenzo l'ha chiesta):** l'import chat ha dato a TUTTI i messaggi di una conversazione lo **stesso `recorded_at`** (un timestamp per conversazione). Abbiamo fixato la PAGINAZIONE del cursore (composito recorded_at+rowid), ma i timestamp degli eventi digeriti possono risultare **appiattiti** → verificare che l'ordine cronologico/temporale nel grafo sia corretto (impatta il recall temporale).
- **Fase 2 — sessioni Code sul disco (~1.513 mai ingerite in L0):** ingester per i transcript `.jsonl` + poi `/digest` (riusa tutta l'infrastruttura). ~1.646 file in `~/.claude/projects/*/`.
- **Pulizia scratch** (chiedere OK a Lorenzo): `b3-backfill-copy/_digest_*`, `_digest_supervisor.ps1`, `_kimi_probe*`, `_ollama*`, `_sids*`, `_l0*`, `_disk*` (gitignored, non più attivi).
- **Automatico + memoria dentro le chat** (l'altra metà del piano): auto-ingest nuove chat claude.ai + Sinapsys-in-chat (PULL via MCP + PUSH via estensione).
- **Il redesign vero del recall** (§3) — è il progetto principale.

## 6. Prima mossa nuova sessione
Leggi questo doc + la scheda memoria `sinapsys-recall-redesign`. Poi: (a) fix intermedio banner<4s se non già fatto, (b) progetta il recall associativo-first (§3), (c) build+verifica live (banner<4s per il motivo giusto).
