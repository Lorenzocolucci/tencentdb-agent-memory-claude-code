# HANDOFF — Incremento C (indice navigabile) — 2026-07-07 notte

> Leggi QUESTO per primo, poi `sinapsys-banner-eventloop-starvation`, poi `docs/SINAPSYS-RECALL-REDESIGN-HANDOFF.md`.
> Branch: `feat/memory-excellence` (MAI main). Servizio live: Sofia. Verifica live prima di "fatto".

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

## Prossimo passo ESATTO
Costruire `navigable-index.ts` (TS puro, HNSW/NSW cosine, persistenza, unit test TDD) come modulo isolato + testato PRIMA di integrarlo (basso rischio, nessun impatto live). Poi integrare in `searchKbVector` con fallback, build al boot con yield, verifica live (raffica → recall veloci). È un build multi-file grande su servizio live → farlo a contesto fresco e lucido.
