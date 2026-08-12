# COST TODO — cambiare il provider LLM/embeddings (2026-07-20)

> Nota lasciata dalla sessione "Socio" mentre bonificava i costi di Sofia AI. NON dimenticare.

## Cosa
Sinapsys (questo repo, `tencentdb-agent-memory`) gira sull'**API OpenAI** di Lorenzo per:
- **embeddings** (recall / ricerca semantica) — `text-embedding-3-small`
- **LLM** (estrazione knowledge graph / consolidation) — chiamate chat

## Perché è un problema
Durante l'audit costi di Sofia (20/07/2026) è emerso che l'account OpenAI di Lorenzo
(utente "JOHNBARBER", billing johnbarber.promo@gmail.com) brucia **~150 milioni di token
di chat + embeddings al mese ≈ $72/mese**, e **il 99,6% NON è Sofia — è Sinapsys/questo repo.**
(Sofia usa solo €0,30/mese di OpenAI.)

## Cosa fare (quando si riprende Sinapsys)
- **Embeddings** → passare a un modello **gratuito/locale** (es. `bge-small`, `nomic-embed-text`,
  `all-MiniLM` via Ollama o una libreria locale). Gli embeddings sono l'uso più facile da
  rendere gratuito senza perdere qualità.
- **LLM estrazione KG** → valutare un modello gratuito/economico (Gemini free tier, o locale)
  se il volume lo consente.
- Verificare i file: `src/adapters/standalone/llm-runner.ts`, `src/core/kb/kb-extractor.ts`,
  `src/core/hooks/auto-recall.ts`, `src/utils/pipeline-factory.ts`, `src/config.ts`.

## Priorità
Media — non blocca Sofia, ma è ~$72/mese di spesa reale attribuibile a questo progetto.
Deciso da Lorenzo il 20/07/2026: "da cambiare, così non ce lo dimentichiamo".
