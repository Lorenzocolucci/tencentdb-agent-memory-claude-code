# ADR-0002 — C:\Sinapsys è un HUB documentale, NON la casa del codice

- **Stato:** Accettata
- **Data:** 2026-06-24

## Contesto
Si voleva un'archiviazione enterprise pulita per Sinapsys. La tentazione: spostare "tutti i file" in C:\Sinapsys, codice incluso.

## Decisione
C:\Sinapsys ospita SOLO la conoscenza di prodotto (visione, piani, ricerca, decisioni, handoff). Il **codice resta nel repo git** `tencentdb-agent-memory`; la **documentazione tecnica resta accanto al codice** (`repo/docs/`). L'hub punta al repo via `CODE-POINTER.md`.

## Perché (alternative scartate)
- **Migrare il codice in C:\Sinapsys:** ⛔ rompe gateway live + hook (path fissi) e contraddice [ADR-0001](ADR-0001-build-on-tencentdb.md).
- **Spostare i doc tecnici fuori dal repo:** ⛔ si disallineano dal codice che descrivono — la confusione che volevamo evitare.

## Conseguenze
- ✅ Zero duplicati, zero disallineamento, codice intatto.
- ✅ Hub leggibile anche da non-tecnico; pronto come base per un eventuale pitch di vendita.
- Onere: i doc tecnici si linkano (puntatore), non si copiano nell'hub.
