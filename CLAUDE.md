# SINAPSYS — Project Context

> **Vedi anche**: [docs/vision/STATO-REALE.md](docs/vision/STATO-REALE.md) (**leggilo per primo**,
> è il punto d'ingresso) · [MEMORIA-BLUEPRINT](docs/vision/01-vision-and-plan/MEMORIA-BLUEPRINT.md) ·
> [CODE-POINTER](docs/vision/CODE-POINTER.md) ·
> [INTERCONNECTION-MAP](docs/vision/02-architecture/INTERCONNECTION-MAP.md) ·
> [SINAPSYS-ARCHITECTURE](docs/SINAPSYS-ARCHITECTURE.md) ·
> [SINAPSYS_FOUNDATIONS](docs/SINAPSYS_FOUNDATIONS.md). Il quadro di tutti i sistemi:
> `C:\RISTRUTTURAZIONE\04-I-CINQUE-SISTEMI.md`. Dove siamo adesso: `C:\RISTRUTTURAZIONE\00-STATO.md`.

## Cos'è Sinapsys, in una frase

Memoria **associativa** a lungo termine per agenti AI: non un motore di ricerca — un grafo dove un
ricordo ne innesca un altro e i ricordi **arrivano da soli**, senza doverli cercare. Vive su questo
fork (`tencentdb-agent-memory-claude-code`), installato come plugin Claude Code sulla macchina di
Lorenzo. Gateway locale: `127.0.0.1:8421`, girato dal `dist/` compilato (`npm run build`), non dai
sorgenti TypeScript — se cambi codice e non ricompili, il gateway continua a girare sulla versione
vecchia.

## 🔴 Sinapsys NON è memoria per un progetto solo

Per natura, questo sistema è pensato per dare memoria a **qualunque agente AI su qualunque
progetto** — oggi ricorda conversazioni su Sofia, Argus, Dashboard e altri lavori di Lorenzo, ma
**non è specializzato su nessuno di questi**: è un'infrastruttura generale. Quando Lorenzo apre un
progetto nuovo, oggi o in futuro, Sinapsys deve poterne ricordare le conversazioni allo stesso modo,
senza bisogno di essere riconfigurato per quel progetto specifico. **Non trattare mai l'elenco dei
progetti di oggi come l'unico scopo di questo sistema.**

⚠️ **Il guasto già successo per questo motivo** (luglio 2026, riparato): un'entità "file" creata da
un progetto veniva identificata **solo dal nome del file**, non da progetto+percorso — quindi
`README.md` di un progetto qualsiasi combaciava con `README.md` di un altro, e la memoria di un
progetto **colava dentro un altro**. Riparato (`kb-queries.ts:204`, commit `61f0e2e`): l'identità di
un file è **sempre** progetto+percorso, mai il nome nudo. Se tocchi il codice di indicizzazione,
questa regola non si tocca.

## Verifica

```
npm test              # vitest run — CI ora esegue davvero i test (era rossa in silenzio da giugno a agosto)
npm run build          # tsdown — il gateway gira SOLO da qui, non dai sorgenti
npm run install:cc-plugin   # dopo ogni build, se vuoi che il plugin installato la usi — serve un riavvio
```
**Non fidarti di un conteggio test copiato da un documento**: al 04/09/2026 due file diversi dello
stesso repo dichiaravano numeri diversi (1.052 contro 1.063) per lo stesso giorno — rieseguilo.

## Traps che sono già costate tempo qui

- **`C:\Sinapsys\` non esiste più dal 18/07/2026** — è un puntatore vuoto. Il vero percorso è questo
  repo, `C:\Users\lo\tencentdb-agent-memory`. Se trovi un riferimento al vecchio percorso in un
  documento (fuori da `docs/archive/`), è una bugia rimasta indietro, correggila.
- **Un errore dentro `main()` del hook può spegnere richiamo E cattura in silenzio**: c'era un
  `try/catch` la cui unica azione era scrivere una riga di log — nessun allarme delle "sette (oggi
  otto) trappole" poteva vederlo, perché vivevano dentro quello stesso `try`. Riparato (`alarm.ts`,
  `hook.ts`), ma è la forma di guasto a cui fare più attenzione qui: **un log non è un allarme**.
- **Il bundle installato può restare indietro rispetto al codice del repo** anche dopo un merge: il
  plugin gira dalla build compilata e installata (`claude-code-plugin/`), non dal sorgente aperto qui.
  Dopo un fix, verifica `npm run install:cc-plugin` + riavvio, non dare per scontato che sia già live.

## Non-negoziabili

Mai push diretto su `main`. Mai committare segreti. Mai cancellare un file senza l'OK di Lorenzo.
Mai mescolare i dati di progetti diversi nello stesso ricordo (è il guasto di luglio: non si ripete).
Mai inventare un numero: se non l'hai rieseguito oggi, scrivi "non verificato".
