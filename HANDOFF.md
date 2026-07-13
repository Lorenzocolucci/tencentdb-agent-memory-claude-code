# HANDOFF — Incremento C (indice navigabile) — 2026-07-08

> Leggi QUESTO per primo, poi `sinapsys-banner-eventloop-starvation`, poi `docs/SINAPSYS-RECALL-REDESIGN-HANDOFF.md`.
> Branch: `feat/memory-excellence` (MAI main). Servizio live: Sofia. Verifica live prima di "fatto".

## ✅ C-1a FATTO + COMMITTATO (`b07ecf1`, 2026-07-08) — modulo isolato, ZERO impatto live
`src/core/kb/navigable-index.ts` — grafo navigabile HNSW in TS puro (add/remove/upsert/search/serialize+deserialize). Ricerca = traversata greedy vicino-a-vicino (spreading activation navigabile). Distanza coseno interna (`1−dot` di vettori normalizzati, come sqlite-vec), `score = 1−dist` = similarità coseno **clampata [-1,1]**. Tombstone-delete: i nodi restano waypoint di routing ma FUORI dai risultati (niente starvation quando i tombstone si accumulano vicino alla query); entry point mantenuto vivo; snapshot JSON validato al load.
- **Revisionato** da lo-code-reviewer: 1 CRITICAL (tombstone beam-starvation) + 2 HIGH (deserialize validation, score>1) + 3 MEDIUM/3 LOW — ognuno chiuso con test-che-fallisce-prima (TDD).
- **Verificato:** 28 unit test verdi (recall@10 ≥ 0.9 vs brute-force a dim 48 e 256; recall ≥ 0.9 dopo 40% tombstone; determinismo; round-trip serialize). Suite `src/` 784/784. Build tsdown verde.
- **NON ancora integrato:** `searchKbVector` è ancora brute-force. L'integrazione (sotto, C-1b) è il prossimo passo e tocca il path live.

## Goal
Eliminare alla radice lo scan a forza bruta che starva il banner → recall O(log N) via **indice navigabile in-house**. Decisione di Lorenzo: "vai diretto a C (HNSW) ora" (scartati sia il fix interim throttle/cache sia il solo gate).

## Cosa è STATO FATTO + committato questa sessione
- **Telecamera event-loop starvation** — commit `09bfb15`. `src/core/diagnostics/`: `inflight-registry.ts` (chi occupa il loop: active + recent ring), `event-loop-monitor.ts` (`perf_hooks.monitorEventLoopDelay`), `slow-recall.ts` (breadcrumb, `SLOW_RECALL_MS=1500`). Marcatori `beginHeavyTask/endHeavyTask` su **consolidation** (`consolidation-scheduler.ts`), **l0-index** (`auto-capture.ts` ciclo upsertL0), **cornerstone-build** (`cornerstone-runner.ts`). Breadcrumb in `server.ts handleRecall` + `startEventLoopMonitor()` al boot. 16 test, suite `src/` 756/756 verde.
- **Gate globale cornerstone** — commit `afefe99`. `tdai-core.ts buildCornerstoneInBackground`: `if (this.cornerstoneInFlight.size>0) return` (prima era per-key). Uccide il PILE-UP. NECESSARIO ma NON sufficiente.

## Il finding PROVATO LIVE (la telecamera ha nominato il colpevole)
- Colpevole = **`cornerstone-build`**: 50 scansioni KNN brute-force su ~25k vettori `kb_vec` = **35-95s** di lavoro sul loop unico. Breadcrumb reali in `C:/Users/lo/tdai-backups/culprit-captured-*/gateway.err.log`.
- **Una SINGOLA build starva i ~60s di recall successivi** (non è artefatto della raffica): recall #1=1,37s (precede la build) → #2,#3=7s (build di #1 in volo). Cronico per uso multi-progetto.
- `lag_max` fino a 2445ms = un singolo scan blocca il loop ~2,4s di fila. Il gate riduce a 1 build attiva ma il singolo scan resta il problema → serve C.

## Vincolo ARM64 — ricerca+test empirici (fatti)
Lorenzo è su **Windows 11 ARM64 (Snapdragon X Elite)**. Verdetto su librerie ANN pronte:
- **hnswlib-node** (native): nessun prebuilt, compila da sorgente con VS2022 + toolchain ARM64 + Python; fragile/lento. ❌
- **usearch** (native): prebuilt per piattaforme comuni, **win32-arm64 non confermato**. ⚠️
- **hnswlib-wasm**: TESTATO — **NON gira in Node** ("not compiled for this environment", è build browser-only Emscripten). ❌
- **deepfates/hnsw** (pure JS): non testato, piccolo/non mantenuto.
→ **Conclusione: nessuna libreria pronta è un buon fit. La strada pulita è un indice navigabile IN-HOUSE in TypeScript.** (Nostro, bundle tsdown pulito, zero nativo/wasm, ARM64-safe, Sinapsys-faithful.)

## Piano C
**C-1 (banner-first, il vero fix):** `src/core/kb/navigable-index.ts` — HNSW/NSW small-world in TS puro. API: `add(id,vec)`, `remove(id)`, `search(query,k)→[{id,score}]`, persistenza serialize/deserialize su disco (non ricostruire ogni boot). Distanza cosine (come sqlite-vec). Build al boot da `kb_vec` (bounded + **yield** `await setImmediate` a chunk così non starva lui stesso), sync su `upsertKbVector`/delete. Poi **route `searchKbVector` (sqlite.ts) attraverso l'indice**, con fallback brute-force se degradato. Verifica: rieseguire la raffica → recall veloci anche durante le cornerstone-build.
  - Integration points: `sqlite.ts searchKbVector` (il KNN brute-force da sostituire/wrappare); `cornerstone-runner.ts buildNeighborMap` (consumatore); `upsertKbVector` (sync su write); boot in `server.ts start()` o `tdai-core initialize()`.
  - VERIFICARE le dimensioni reali di `kb_vec` (OpenAI 1536 vs migrazione locale 768) — l'indice è dim-agnostico ma va confermato.
**C-2 (dopo, separato):** embedding LOCALE Ollama `nomic-embed-text` (768) — verificato presente e Ollama up. Toglie la latenza embedding remoto; richiede RE-INDEX di tutti i vettori a 768. Grande, indipendente da C-1.

## Stato operativo (live)
- Gateway VIVO e sano ora: PID 60532, `/health`=ok, `embedding`=ok. Gira il build con camera+gate (dist ribuiltato). Le mie prove hanno lasciato cornerstone-cache junk per session-key throwaway (`camera-probe*`, `drain-check*`, `status-check*`) — innocue.
- **NON committato:** niente altro. Working tree pulito a parte scratch pre-esistenti (TASKS.md, b3-backfill-copy/, dashboard.html).
- Log gateway: `C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local/gateway.{out,err}.log`. **Copiali PRIMA di ogni restart** (Start-Process li tronca). Restart: `C:/Users/lo/tdai-gateway/{stop,start}-gateway.ps1`. Entry: `dist/src/gateway/cli.mjs`.
- Token: `C:/Users/lo/.claude/plugins/data/tdai-memory-tdai-local/token`. Raffica di prova: POST `/recall` con session_id freschi → innesca cornerstone-build → misura latenza + `grep "SLOW RECALL" gateway.err.log`.

## ✅ C-1b FATTO — INTEGRAZIONE cablata + testata (2026-07-08). RESTA SOLO la verifica live (porta di Lorenzo).
`sqlite.ts` instrada ora `searchKbVector` sull'indice navigabile con fallback brute-force; build-al-boot in background (yield ~12ms) fired fire-and-forget da `tdai-core.initStores`; sync su `upsertKbVector`; **GC dei tombstone via rebuild a soglia** (>50% tombstone su >200 nodi → compattazione in background); fallback-su-vuoto (indice non-vuoto che ritorna 0 → brute); guard drop-rate (>1% righe non-decodificate → abort, resta su brute); indice pubblicato non annullato su throw tardivo; statement cache; `close()` azzera l'indice.
- **Revisionato** da lo-code-reviewer + lo-security-auditor in parallelo: 0 CRITICAL. Tutte le HIGH/MEDIUM convergenti (tombstone-GC, fallback-su-vuoto, published-flag, drop-guard, statement-cache) CHIUSE in questo commit. SQL injection: nessuna (SQL statico/parametrizzato). Segreti: nessuno loggato.
- **Verificato:** 12 test integrazione su DB temp con **sqlite-vec reale** (round-trip vettori grezzi; parità vs brute-force top-owner + recall@5 ≥ 0.9 su 300; routing provato discriminante; sync new/replace; kind-filter; fallback; GC tombstone; auto-rebuild). Suite `src/` 797/797 (14+ run full-suite verdi, flake iniziale chiuso col closed-guard). Build tsdown verde.
- **PROSSIMO = VERIFICA LIVE (porta di Lorenzo):** deploy = restart gateway (tocca Sofia). Copiare i log PRIMA. Raffica `/recall` a sessioni fresche → recall veloci ANCHE durante le cornerstone-build; `grep "SLOW RECALL"` e `kb-nav index built` nei log. Entry: `dist/src/gateway/cli.mjs` (ribuiltato). Restart: `C:/Users/lo/tdai-gateway/{stop,start}-gateway.ps1`.
- **Residui noti (non gating, accettati/deferiti):** (a) yield del build per-insert non per-operazione — sicuro fino a ~1M nodi (entrambi i reviewer d'accordo); (b) persistenza snapshot su disco NON cablata (il build-al-boot con yield è già non-bloccante — opzionale dopo); (c) `Buffer.from(queryEmbedding.buffer)` nel path brute-force pre-esistente ignora byteOffset (fuori scope, nessun caller passa subarray oggi).

---
### (Storico) piano C-1b — com'era prima di realizzarlo:
Il modulo C-1a è pronto e committato. Ora cablarlo in `sqlite.ts` (contesto FRESCO e lucido — è la parte delicata su servizio live):
1. **Lettura vettori grezzi da kb_vec** per il build-al-boot: serve un metodo tipo `getAllKbVectors(): {chunk_id, owner_id, owner_kind, vec:Float32Array}[]` (oggi c'è solo `getAllKbTexts`, che ri-embedderebbe — NO). sqlite-vec: `SELECT chunk_id, owner_id, owner_kind, vec_to_json(embedding) FROM kb_vec` o leggere il blob raw. VERIFICARE come estrarre l'embedding da vec0.
2. **Costruire l'indice al boot**: nuovo campo su `VectorStore` (es. `kbNavIndex: NavigableIndex|null`), popolato dopo che `kbVecReady=true`, in un loop **con yield** (`await setImmediate` a chunk) così il build non starva lui stesso. Dim = `this.dimensions`. Marcare `beginHeavyTask('kb-nav-build')`/`endHeavyTask` (telecamera). Hook: `server.ts start()` o `tdai-core initialize()`.
3. **Route `searchKbVector`** attraverso l'indice: `this.kbNavIndex.search(query, retrieveCount)` → mappare chunk_id→owner, de-dup best-per-owner + ownerKindFilter (logica GIÀ presente in searchKbVector, riusarla). **Fallback brute-force** se `kbNavIndex==null` o degradato.
4. **Sync su write**: in `upsertKbVector` → `kbNavIndex.add(chunkId, vec)` per ogni chunk; in `stmtKbVecDelete`/delete owner → `kbNavIndex.remove(chunkId)` per ogni chunk index. (chunk_id = `kbChunkId(ownerKind, ownerId, i)`.)
5. **(Opzionale, dopo)** persistenza snapshot su disco per saltare il rebuild-al-boot (il modulo ha già serialize/deserialize validati). Prima versione può ricostruire-al-boot con yield (non-bloccante) e basta.
6. **TDD**: test integrazione su DB temp — parità `searchKbVector` (nav vs brute) su vettori reali; fallback quando index assente; sync add/remove riflesso nella ricerca.
7. **Verifica live (porta di Lorenzo):** deploy = restart gateway (tocca Sofia). Raffica `/recall` a sessioni fresche → recall veloci ANCHE durante le cornerstone-build; `grep "SLOW RECALL"`. Copiare i log PRIMA del restart.

Integration points confermati (letti questa sessione): `sqlite.ts` `searchKbVector` (~riga 3858), `upsertKbVector` (~3785, usa `kbChunkId`), `stmtKbVecDelete` (~3283), schema kb_vec (~3268, `chunk_size=8`, dim=`this.dimensions`), `getAllKbTexts` (~2037, NON riusare per i vettori), `KbVectorSearchResult` (`types.ts:277`). Consumatore: `cornerstone-runner.ts buildNeighborMap` (~208) chiama `searchKbVector` — beneficia in automatico.
