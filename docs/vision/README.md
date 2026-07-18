# 🧠 Sinapsys — Project Hub

La miglior memoria persistente per agenti AI. Questo è l'**hub di prodotto e conoscenza** — NON il codice.

> Il **codice** vive nel repo git (vedi [CODE-POINTER.md](CODE-POINTER.md)), dove gira il gateway e si versiona. La documentazione tecnica vive accanto al codice (in `repo/docs/`). Qui sta tutto il resto: visione, piani, ricerca, decisioni, handoff.

## Struttura
| Cartella | Cosa contiene |
|---|---|
| `00-charter/` | Come lavoriamo (manifesto Lorenzo + Socio) |
| `01-vision-and-plan/` | Il piano tecnico Sinapsys + il blueprint memoria |
| `02-architecture/` | Puntatore alle fondamenta (nel repo) + **mappa viva delle interconnessioni** |
| `03-research/` | Deep-research verificata (round 1 + 2) |
| `04-decisions/` | ADR — Architecture Decision Records (decisioni a verbale, non si ridiscutono senza motivo) |

## Regole del progetto (enterprise dall'inizio)
- **Codice:** una funzione per file, ~200 righe max, alta coesione / basso accoppiamento.
- **Mappa interconnessioni:** sempre aggiornata → [02-architecture/INTERCONNECTION-MAP.md](02-architecture/INTERCONNECTION-MAP.md).
- **Branch:** verificare con `git branch --show-current` nel repo — **MAI push su main.**
- **Decisioni:** ogni scelta strutturale diventa un ADR in `04-decisions/`.
- **Lingua:** italiano tra noi, inglese in codice/commit/doc tecnici.

## Stato attuale (aggiornato 2026-07-18 — unificazione D-A3)

**Questo hub viveva prima in `C:\Sinapsys` (cartella semplice, MAI un repo git — quei documenti non erano versionati). Il 2026-07-18 è stato unificato dentro questo repo, sotto `docs/vision/`, per smettere di essere un punto cieco.** `C:\Sinapsys` ora contiene solo un puntatore qui.

Ricerca chiusa (7/7 ambiti, si veda `03-research/`). Le **5 idee originali** (Parte 3 del blueprint) + **Grounded Trust** (Idea 6) sono **tutte implementate e live** — verificato file:line il 2026-07-18, non a memoria. L'unico pezzo del piano ancora davvero aperto è la **Fase E** (embeddings + reranker locali). Stato dettagliato per-modulo: `docs/SINAPSYS-ARCHITECTURE.md` (nel repo, accanto al codice) + header "Stato implementativo" in cima a `01-vision-and-plan/MEMORIA-BLUEPRINT.md` e `SINAPSYS-PLAN.md`. Storico dei design/piani per-fase: `docs/archive/SINAPSYS-STORICO-DOCS-20260718.md`.
