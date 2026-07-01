# Design — Pilastro B: Crescere dall'errore (track record della stance)

**Date:** 2026-07-01
**Status:** Slice 1 (cervello) COSTRUITA + TESTATA (non cablata). Slice 2 (wiring) = spec sotto.
**Blueprint:** `docs/SINAPSYS-NEXT-BLUEPRINT.md` Parte 2 Pilastro B.
**Playbook:** identico a Pilastro A (Slice 1 = cervello puro shippato prima del wiring).

---

## 1. Il DELTA (perché non è un doppione di B3)
- **B3 esistente** (`lesson-reinforcement.ts`): la confidenza della lesson sale se il **fallimento non si ripete** (avoidance). Segnale = *il bug è tornato?*
- **Pilastro B (nuovo):** track record sulla **stance stessa** — quando un interrupt SPARA, aveva **ragione** (confermato) o era **falso allarme** (rifiutato)? Segnale = *era giusto parlare?* Regola la **willingness-to-fire**, non la confidenza del bug.

Chiude il triangolo del giudizio: A decide *se/come* parlare (silent/soft/hard), B rende la stance **responsabile** nel tempo di ciò che afferma.

## 2. Slice 1 — il cervello (FATTO)
- `src/core/kb/stance-track-record.ts` (puro, 6 test): willingness ∈ [0,1].
  - `willingnessAfterConfirm` (sale, rendimenti decrescenti, cap 0.99).
  - `willingnessAfterReject` (scende, temper 0.35 > gain 0.25 — un interrupt è intrusivo, i falsi allarmi costano e silenziano in fretta; floor 0.05, **mai erasa** → può risalire).
  - `willingnessTier`: `suppressed` (<0.25) / `demoted` (<0.45) / `trusted` (≥0.45). Simmetrico.
- `src/core/kb/stance-severity.ts` (esteso, +6 test): `StanceAttestation.willingness?` opzionale.
  - `suppressed` → **silent** (lapide del "gridare al lupo", a prescindere dalla confidenza).
  - `demoted` → mai **hard**, solo soft (deve ri-guadagnarsi la fiducia).
  - `trusted` / legacy (willingness assente) → invariato (una lesson attestata fresca può sparare finché non grida al lupo).
- **Nessun cambio live** (nulla popola ancora willingness). 12 test verdi tra i 2 file, 0 regressioni.

## 3. Slice 2 — il wiring LIVE (DA COSTRUIRE, prossima sessione)
Serve la **persistenza** del track record e la **cattura del segnale** conferma/rifiuto.

1. **Colonne track-record su `lessons`** (additive, default su righe legacy — come fece B3 con exposure/avoidance): `stance_fire_count`, `stance_confirmed_count`, `stance_rejected_count`, `stance_willingness` (default `WILLINGNESS_DEFAULT`=0.7). DDL in `foundations-schema.ts` (brick lessons).
2. **Primitive writer** in `lessons-writer.ts`: `recordStanceFire(lessonId)`, `creditStanceConfirmed(lessonId)` (→ `willingnessAfterConfirm`), `creditStanceRejected(lessonId)` (→ `willingnessAfterReject`). Mirror di `creditAvoidance`/`temperOnRecurrence`.
3. **Sorgente del segnale:** l'interrupt duro è reso via la macchina Grounded Trust (`grounded-trust-ask.ts`, `renderGroundedTrustInterrupt`). Quando l'utente **conferma** quell'interrupt → `creditStanceConfirmed`; quando lo **rifiuta** (falso allarme) → `creditStanceRejected`. Riusa il gate confirm/reject esistente (`confirmMemory`/`rejectMemory`); mappare la risposta all'interrupt sulla lesson che l'ha generato (serve tracciare quale lesson ha sparato — `stance_fire` stampa l'id al momento del fire in `situation-injection.ts`).
4. **Consumo live:** `situation-injection.ts` / il selettore passa `willingness` (dalla LessonRow) dentro `classifyStanceSeverity` → la retroazione diventa viva.
5. **Verifica (G5):** una stance rifiutata 3× non spara più hard (poi silent); una confermata risale. Test su store reale + prova live.

## 4. Rischi (dal blueprint, non opzionali)
- **Inerzia:** una stance sbagliata una volta ma poi giusta DEVE risalire → decadimento simmetrico (floor, confirm che rialza). Coperto in Slice 1.
- **Non cancellare:** la soppressione è una **lapide** (silent), non un delete — coerente con Grounded Trust rejected-non-delete.

## 5. Invarianti
- Puro/deterministico nel cervello; wiring off critical path, errori ingoiati.
- Additivo: nessuna colonna rimossa, legacy = trusted.
