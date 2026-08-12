# 🧠 Sinapsys — Project Hub

> Struttura verificata il **2026-08-07**. Questo file descrive l'*organizzazione*;
> lo *stato* vive in [STATO-REALE.md](STATO-REALE.md).

La miglior memoria persistente per agenti AI. Questo è l'**hub di prodotto e conoscenza**.

> ## 👉 [**STATO-REALE.md**](STATO-REALE.md) — leggi QUESTO per primo
> Dove siamo davvero (numeri misurati), cosa è vivo, **cosa manca** e qual è il prossimo passo.
> Tutti gli altri documenti partono da lì.

> Il **codice** vive nel repo git (vedi [CODE-POINTER.md](CODE-POINTER.md)), dove gira il gateway e si versiona. La documentazione tecnica vive accanto al codice (in `repo/docs/`). Qui sta tutto il resto: visione, piani, ricerca, decisioni.

## Struttura
| Cartella | Cosa contiene |
|---|---|
| `00-charter/` | Come lavoriamo (manifesto Lorenzo + Socio) |
| `01-vision-and-plan/` | Il blueprint memoria, il piano tecnico, i piani operativi aperti |
| `02-architecture/` | Puntatore alle fondamenta (nel repo) + **mappa viva delle interconnessioni** |
| `03-research/` | Deep-research verificata (round 1 + 2) |
| `04-decisions/` | ADR — Architecture Decision Records (decisioni a verbale, non si ridiscutono senza motivo) |

## Percorsi di lettura (a seconda di cosa ti serve)

| Se vuoi… | Leggi in quest'ordine |
|---|---|
| **Il quadro completo, subito** | [STATO-REALE.md](STATO-REALE.md) |
| **Capire la visione** | [STATO-REALE](STATO-REALE.md) → [MEMORIA-BLUEPRINT](01-vision-and-plan/MEMORIA-BLUEPRINT.md) → [SINAPSYS-NEXT-BLUEPRINT](../SINAPSYS-NEXT-BLUEPRINT.md) |
| **Mettere le mani nel codice** | [STATO-REALE](STATO-REALE.md) → [CODE-POINTER](CODE-POINTER.md) → [SINAPSYS-ARCHITECTURE](../SINAPSYS-ARCHITECTURE.md) → [INTERCONNECTION-MAP](02-architecture/INTERCONNECTION-MAP.md) |
| **Portare Sinapsys in Render (prossimo passo)** | [STATO-REALE §7](STATO-REALE.md) → [PUNTO5-SINAPSYS-IN-ARGUS-RENDER](01-vision-and-plan/PUNTO5-SINAPSYS-IN-ARGUS-RENDER.md) |
| **Sapere quanto vale davvero** | [STATO-REALE §5](STATO-REALE.md) → [benchmark/longmemeval/DESIGN-2026-07-21](../../benchmark/longmemeval/DESIGN-2026-07-21.md) |

## Regole del progetto (enterprise dall'inizio)
- **Codice:** una funzione per file, ~200 righe max, alta coesione / basso accoppiamento.
- **Mappa interconnessioni:** sempre aggiornata → [02-architecture/INTERCONNECTION-MAP.md](02-architecture/INTERCONNECTION-MAP.md).
- **Branch:** verificare con `git branch --show-current` nel repo — **MAI push su `tencent`**.
- **Decisioni:** ogni scelta strutturale diventa un ADR in `04-decisions/`.
- **Lingua:** italiano tra noi, inglese in codice/commit/doc tecnici.
- **Determinismo:** ogni numero in un documento deve essere misurato, non ricordato.

## Storia di questo hub
Viveva in `C:\Sinapsys` (cartella semplice, MAI un repo git). Il **2026-07-18** è stato unificato
qui sotto `docs/vision/` per smettere di essere un punto cieco; `C:\Sinapsys` contiene solo un
puntatore. Ricerca chiusa (7/7 ambiti, vedi `03-research/`). Storico dei design chiusi:
[../archive/SINAPSYS-STORICO-DOCS-20260718.md](../archive/SINAPSYS-STORICO-DOCS-20260718.md).

> **Stato del progetto: NON qui.** Vive in [STATO-REALE.md](STATO-REALE.md), che è l'unico file
> che si aggiorna ad ogni sessione. Questo README descrive solo la *struttura*.
