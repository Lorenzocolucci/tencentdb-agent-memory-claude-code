# Design — Pilastro C Fase 2: Distillazione ("dimenticare con gusto")

**Date:** 2026-07-01
**Status:** ✅ COSTRUITO + DEPLOYATO 2026-07-01 (gateway PID 51356). 21 test verdi, 0 regressioni. Prova su dati vivi: 7 cluster qualificanti reali.
**Decisione di visione (Lorenzo, 2026-07-01):** **CONSERVATIVO — distilla, non cancella.**
**Blueprint:** `docs/SINAPSYS-NEXT-BLUEPRINT.md` Parte 2 Pilastro C + Parte 5 punto 2.

## ESITO BUILD (2026-07-01)
4 file nuovi + wiring, tutti a livello `IMemoryStore` (testabili su store reale):
- `src/core/kb/principle-clusters.ts` — clustering deterministico per entità; guard cross-sessione su **session_id** (NON session_key: stabile per progetto — stessa trappola del rollover). Soglia evidence≥2 / sessioni≥2.
- `src/core/kb/principle-distiller.ts` — mirror di lessons-distiller; prompt inglese STRICT-JSON; never-throws.
- `src/core/kb/principle-writer.ts` — atomo `events` type=`principle`, alta salience (0.8 ≥ soglia protetta 0.7 di Fase 1) → recall+decay-protetto senza codice nuovo; idempotente per domainEntity; provenienza.
- `src/core/kb/principle-runner.ts` — `distillPrinciples(store, runner, …)`: fetch→cluster→skip-già-distillati→distill→write. CHEAP: no cluster→no LLM.
- Wiring: `src/core/tdai-core.ts` handleSessionEnd (5° bgTask, off critical path, fire-and-forget).
Verifica G5: dopo consolidation reale un `principle` con `evidence:N` in `vectors.db`. Recall lo pesca via kb_fts/kb_vec (atomo events). MVP: clustering per entità (upgrade futuro = similarità semantica come i bug).

---

## 1. Cosa (in una frase)
Da un cluster maturo di ricordi **non-fallimento** (decisioni, preferenze, pattern ricorrenti) distillare **un principio guadagnato** ("hard-won principle") — non un mucchio cercabile. Il rumore diventa intuito. Le sorgenti **NON si cancellano**: decadono via Fase 1 (già live), i picchi distintivi (cornerstone) restano protetti.

## 2. Perché conservativo cambia lo scope (in meglio)
La scelta di Lorenzo rende Fase 2 **puramente additiva**: si CREA un atomo `principle`; NON si scrive codice di cancellazione. L'oblio del dettaglio è delegato al decay di Fase 1 (`lifecycle-decay.ts`, già deployato). Zero perdita irreversibile — coerente con la lapide-non-delete di Grounded Trust.

## 3. Il confine con Track B / Pilastro A (NON duplicare)
- **Track B (Mistake Notebook, esiste)**: cluster di **FALLIMENTI** (`bug-clusters.ts`) → **lessons** (`lessons-distiller.ts` → `lessons-writer.ts`), con evidence_count, reinforcement, avoidance. È l'organo di A.
- **Fase 2 (nuovo)**: cluster di **NON-fallimento** (decision/preference/observation/config ricorrenti) → **principles**. Tipo KB distinto (`principle`), sorgente di clustering distinta (ESCLUDE i tipi bug/failure che A possiede). Nessuna sovrapposizione.

## 4. Riuso (non ripartire da zero)
Rispecchiare l'architettura di `lessons-distiller.ts` (verificata, pulita):
- host-neutral (LLMRunner iniettato), **never-throws** (null su errore), testabile offline;
- `cluster → buildPrompt → LLM → parse(STRICT JSON) → writer`.

## 5. Componenti (file piccoli, uno scopo)
| File | Scopo |
|------|-------|
| `src/core/kb/principle-clusters.ts` | Raggruppa eventi maturi non-fallimento per (project, domain/entity). Soglia di **recurrence**: ≥N eventi su ≥M sessioni → il principio è GUADAGNATO, MAI un aneddoto (vincolo blueprint). |
| `src/core/kb/principle-distiller.ts` | Mirror di lessons-distiller: `{domain, principleText, confidence, evidenceCount}` da STRICT JSON. Prompt NUOVO (principio, non lesson). |
| `src/core/kb/principle-writer.ts` | Inserisce l'atomo `type:"principle"` ad **alta salience** (protetto dal decay di Fase 1 via `stampSalience`), con `evidence_count` + `source_message_ids` (provenienza). Idempotente (skip cluster già distillato — pattern di `lessons-runner`). |
| wiring | In `consolidation-runner.ts` / scheduler: off critical path, CHEAP, **LLM-gated** (no cluster → no LLM), stessa disciplina di `runLessonDistillation`. |

## 6. Protezione von Restorff (rischio n.1 del blueprint)
Il principio nasce alta-salience → Fase 1 lo protegge dal decay. Le sorgenti decadono, MA i cornerstone tra esse restano (Idea 5 + Fase 1 già lo garantiscono). Non si distilla via un fatto raro-cruciale.

## 7. Invarianti
- **Conservativo:** nessuna DELETE. Solo insert del principio + decay esistente sulle sorgenti.
- **Immutabile / append-only**, errori ingoiati, fuori dal path critico (la memoria non rompe la conversazione).
- **MAI aneddoti:** soglia evidence_count obbligatoria prima di distillare.
- **Prompt:** review `lo-llm-architect` prima della cadenza auto (precedente: nota in `lessons-distiller.ts:19`).

## 8. Test (non circolari)
- Unit: build/parse prompt (STRICT JSON, null su spazzatura).
- Integrazione su store reale: cluster maturo → principle inserito alta-salience + evidence_count + provenienza; idempotente (secondo giro = no dup).
- Non-circolare su dati reali del corpus vivo (copia), come fatto per il rollover.

## 9. Gate di chiusura (G5)
Build verde → verifica LIVE (restart gateway → dopo una consolidation reale, un `principle` compare in `vectors.db` con evidence_count>1) → poi "fatto". Aggiornare scheda `sinapsys-pilastro-c-fase1` (→ Fase 2) + questo doc + blueprint.

## 10. Sequenza
Sessione dedicata (feature multi-file: fuori dall'ultimo 20% di contesto, per la regola performance di Lorenzo). Ordine: clusterer (TDD) → distiller (TDD, prompt) → writer (TDD idempotenza) → wiring → verifica live.
