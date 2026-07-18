# ADR-0001 — Sinapsys si costruisce SOPRA TencentDB (niente rewrite)

- **Stato:** Accettata
- **Data:** 2026-06-23 (confermata 2026-06-24)

## Contesto
TencentDB Agent Memory è già ~metà di Sinapsys: KB entity-centric (entities/facts/relations bi-temporali), ricerca ibrida (FTS+vettori+entity→RRF), proiezioni deterministiche persona/scene, gateway stabile. Un rewrite da zero butterebbe lavoro funzionante e introdurrebbe rischio.

## Decisione
Costruire le fasi mancanti (A→E) come strati ADDITIVI sopra il KB esistente. Nessun rewrite. Lo schema si estende con `IF NOT EXISTS` / `ADD COLUMN`, mai alterando le tabelle esistenti.

## Conseguenze
- ✅ Il KB live continua a funzionare durante la costruzione.
- ✅ Meno lavoro, meno rischio.
- ⛔ Il codice NON si sposta dal repo `tencentdb-agent-memory` (gateway/hook/build dipendono dai path).
- Vincolo correlato: vedi [ADR-0002](ADR-0002-sinapsys-hub-not-code-migration.md).
