# Research Round 1 — Neuroscienze della memoria + Stato dell'arte AI
> Deep-research verificato (24 giugno 2026). 111 agenti, 24/25 claim confermati con voto avversariale 3 giudici. Fonti primarie peer-reviewed. 1 claim refutato (segnalato).

## Neuroscienze della memoria umana
| Principio | Fonte | → Feature Sinapsys |
|---|---|---|
| **Promozione a 2 condizioni** (Synaptic Tagging & Capture): durevole solo se taggato E confermato da evento successivo | Nature s42003-021-01778-y; nrn2963 | promuovere short→long con 2 cancelli (tag + conferma) |
| **Salienza salva i vicini, solo se semanticamente simili** (gate cosine); solo ricordi deboli, effetto ritardato, finestra ~30min-3h | Science Advances ady1704 (2025); PMC9378568; eLife 72519 | su evento saliente, rinforza i correlati vicini filtrati per similarità |
| **Importanza si CONTA** (replay cumulativo guidato da novità+durata, non reward) | PMC10710481 | driver di promozione = conteggio riapparizioni/accessi |
| **Memoria migliora offline da sola** (consolidamento rafforza, non solo preserva) | s42003-021-01778-y (modello comp.) | il motore notturno RIELABORA, non solo indicizza |

⛔ **Refutato (1-2):** "tier perché il cervello ha tempi ore-vs-giorni". → i tier si giustificano per logica di sistema (caching), NON per biologia.

## Stato dell'arte sistemi di memoria AI (2025-2026)
- **ReasoningBank** (Google, arXiv:2509.25140): distillare lezioni da successi **E fallimenti** = +3-34% vs salvare solo successi/tracce grezze. → conferma il Mistake Notebook (Fase B).
- **A-MEM** (arXiv:2502.12110, NeurIPS 2025): note Zettelkasten 7-componenti + linking LLM + "memory evolution" — MA senza audit trail (rischio compounding allucinazioni).
- **MemOS** (arXiv:2507.03724): MemCube con provenienza + versioning — ma senza evoluzione.
- **Gap centrale** (survey arXiv:2509.18868): gli LLM mancano di un vero sistema di gestione memoria con lifecycle.

## Caveat onesti
- "dichiarativo vs procedurale" del cervello = bussola di design, NON verità biologica 1:1 (i paper avvertono).
- Numeri ReasoningBank = benchmark auto-riportati, non replica terza.
