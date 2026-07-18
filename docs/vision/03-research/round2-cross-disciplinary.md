# Research Round 2 — 5 ambiti cross-disciplinari
> Deep-research verificato (24 giugno 2026). 111 agenti, 24/25 claim confermati. 4 ambiti su 5 verificati; jazz a vuoto (onestà).

| Ambito | Esito | Principio verificato | → Feature Sinapsys |
|---|---|---|---|
| **📚 Archivistica** | ✅ **originale** | Retention per IMPORTANZA DELLA FUNZIONE (non del contenuto); policy per CATEGORIA predefinita; dedup per PROVENIENZA (fonte autorevole/OPI) | retention_class + function_importance + provenance su `memory_lifecycle`. Fonte: bac-lac.gc.ca Macroappraisal (Terry Cook); SAA retention-schedule |
| **🩺 Medicina / illness scripts** | ✅ **originale** | L'esperto attiva lo script giusto dai primi indizi, SOTTO la coscienza, SENZA cercare, su "fit" stretto. Vince per ORGANIZZAZIONE non quantità | Context Fingerprint (file+errore+task) → iniezione proattiva su match forte, fallback a ricerca su ambiguo. Fonte: PMC4795084, PMC3060310 |
| **🕵️ Intelligence** | 🟡 metà | Spreading activation trova nodi-ponte, MA va VINCOLATO (hop/fan-out/soglia). ACH (matrice) è una TRAPPOLA: può aumentare l'errore (N=50) | CSA in Fase D; per conflitti: mostrare, non forzare ipotesi rigida. Fonte: Crestani 1997; Cohen & Kjeldsen 1987. ⚠️ numeri 87%/48% REFUTATI |
| **🍷 Sommelier / Distinctive Terms** | 🟡 ridotto | Termini rari ricordati meglio MA non monotonico: banda ottimale, escludere ultra-rari (hash); applicare all'indicizzazione | peso termini rari nell'FTS con cap. ⚠️ si sovrappone a BM25/IDF → poco originale. Fonte: PMC2387211 |
| **🎷 Jazz** | ❌ a vuoto | Nessuna fonte sopravvissuta; il principio è già coperto dalla medicina | **tagliato.** sub-200ms = obiettivo ingegneristico, non dato |

## I 3 angoli di originalità VENDIBILI (round 1 + 2)
1. **Memoria che si auto-migliora SENZA corrompersi** — evoluzione (A-MEM) + audit trail (MemOS): nessuno combina i due. → tabella `memory_audit`.
2. **Tenere/buttare per FUNZIONE + PROVENIENZA** (archivistica) — tutti gli altri usano regole ad-hoc recency/importance.
3. **Iniezione PROATTIVA da impronta della situazione, senza query** (medicina) — Mem0/Letta sono query-driven.

> Verdetto originalità = giudizio di design ragionato, non verificato avversarialmente.
