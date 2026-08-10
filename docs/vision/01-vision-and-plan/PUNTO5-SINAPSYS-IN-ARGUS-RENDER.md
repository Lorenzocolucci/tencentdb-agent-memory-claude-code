# Punto 5 — Sinapsys dentro Argus su Render (DESIGN)

> 2026-08-07. Autore: Socio. Stato: **PROPOSTA — nulla è stato toccato su Render.**
> Regola rispettata: design-first + ricerca dei vincoli reali PRIMA del codice.

## 0. Ricognizione (fatti verificati, non ipotesi)

**Argus** (`C:\Argus`, repo `Lorenzocolucci/Argus`, branch `main`): motore Node/ESM `.mjs`,
deployato su Render via Docker (`./Dockerfile`, `node:22-slim`), regione **frankfurt**.
Su Render è **TRE servizi** dallo stesso repo:

| servizio | tipo | comando | piano |
|---|---|---|---|
| `argus-brain` | background worker | (CMD del Dockerfile) | starter |
| `argus-maker` | background worker | `node engine/argus-guardian.mjs --maker` | standard |
| `argus-nightly` | **cron** (05:00) | `node engine/argus-guardian.mjs --once` | starter |

**Nessuno dei tre ha un disco persistente** (verificato via API Render: nessun campo `disk`).
Oggi Argus è senza memoria: tutto ciò che scrive in `/app` sparisce a ogni deploy/riavvio.

## 1. Il vincolo che decide l'architettura

Ricerca sui vincoli Render (documentazione ufficiale):

- **Un disco persistente è accessibile da UN SOLO servizio.** Non è condivisibile fra servizi.
- **I cron job NON possono accedere ai dischi** (girano su compute separato).
- Un servizio con disco non può scalare a più istanze e perde il deploy zero-downtime.

→ **"Montiamo un disco su Argus" è impossibile**: Argus è 3 servizi, e uno è un cron.
Qualunque design che metta `vectors.db` sul disco di *un* servizio lascia gli altri due ciechi.

Secondo fatto decisivo:
- **Worker e cron NON possono RICEVERE traffico privato, ma POSSONO INVIARLO.**

→ È esattamente la forma di cui abbiamo bisogno.

## 2. L'architettura proposta

```
        rete privata Render (frankfurt, nessun traffico su internet)

  argus-brain  ─┐
  argus-maker  ─┼──►  http://sinapsys-memory:8421   ──►  [disco persistente]
  argus-nightly ┘         (private service)                 vectors.db
     (inviano)          Sinapsys gateway
```

**Sinapsys diventa un servizio privato Render con un disco.** Non inventiamo niente: il gateway
**è già** un server HTTP con autenticazione Bearer (`/recall`, `/capture`, `/observe`,
`/search/memories`) — lo stesso identico che gira sul portatile. Argus lo chiama come lo chiama
oggi il plugin di Claude Code.

**Perché è la scelta giusta e non la scorciatoia ovvia:**
- riusa il gateway esistente (zero riscritture, zero secondo motore che diverge);
- un solo proprietario del file SQLite → nessuna corruzione da scrittori concorrenti
  (che è esattamente il motivo per cui Render vieta il disco condiviso);
- i 3 servizi Argus restano stateless e sostituibili;
- il traffico resta sulla rete privata (né internet né banda fatturata).

## 3. Innesto dentro Argus (COSA / DOVE / PERCHÉ)

**DOVE:** `engine/lib/llm.mjs:115` — `askLLM({system, messages, prompt, ...})`.
È l'**unico** punto in cui Argus parla con l'LLM (lo chiamano `argus-guardian.mjs`,
`argus-maker-loop.mjs`, `alert-window.mjs`, `brain-resilience.mjs`).

**COSA:** un modulo nuovo `engine/lib/memory.mjs` (~150 righe, file piccolo come da regola):
- `recall(prompt)` → `POST /recall` → stringa da anteporre al `system`;
- `capture(prompt, answer)` → `POST /capture` (fire-and-forget);
- `observe(tool, isError, output)` → `POST /observe` — la stessa **officina** appena costruita,
  così anche i fallimenti di Argus nel cloud alimentano il Quaderno degli Errori.

**PERCHÉ lì:** un solo punto di innesto copre brain + maker + nightly senza toccarne la logica.

**Regola invariabile:** la memoria non rompe MAI Argus. Timeout corto, errori ingoiati e loggati,
se il servizio memoria è giù Argus prosegue esattamente come oggi (fail-open, come il plugin cc).

## 4. Migrazione dei 2,5 GB — il pezzo delicato

I dischi Render **non sono accessibili durante la build**, quindi il DB non può essere copiato
nell'immagine (e non deve: sarebbe un'immagine da 2,5 GB con dentro dati personali).

Strada scelta: **SSH**. I servizi Render espongono un indirizzo SSH
(es. `srv-...@ssh.frankfurt.render.com`), quindi il file si trasferisce una tantum sul disco montato.
Alternative scartate: object storage (aggiunge un fornitore e una copia dei dati in più);
ripartire da zero (perderebbe 35.000 conversazioni e il grafo).

**Prima del trasferimento:** `VACUUM` su una copia per ridurre il file (i vec0 non rilasciano
spazio morto — è già successo, vedi `tools/kb-defrag-vec.mts`), così si sposta meno roba e il
disco costa meno.

## 5. Costi reali (soldi tuoi, numeri verificati)

| voce | costo |
|---|---|
| servizio privato (compute) | da **$7/mese** (0.5 vCPU / 512 MB) |
| disco persistente | **$0,25 / GB / mese** → 10 GB ≈ **$2,50/mese** |
| traffico interno | non fatturato (rete privata) |

Stima realistica: **~$10–20 al mese**. Nota onesta: 512 MB di RAM potrebbero essere stretti
(sqlite-vec fa scansioni in memoria); se il recall risulta lento si sale di taglia — lo misuro
prima di consigliare una spesa maggiore.

## 6. ⚠️ La decisione di prodotto che spetta a Lorenzo

**Una memoria o due?**

- **(A) Due memorie separate** — il portatile continua col suo DB, Argus nel cloud ha il suo.
  *Pro:* zero rischi per il lavoro quotidiano, nessuna dipendenza da internet, reversibile.
  *Contro:* le due memorie divergono; Argus non ricorda ciò che fai tu sul portatile e viceversa.

- **(B) Una memoria sola nel cloud** — anche il portatile punta al gateway cloud.
  *Pro:* è letteralmente la stella polare ("Argus è Socio", una sola testa).
  *Contro:* ogni tuo prompt dipende dalla rete; il recall ha 6s di budget, un ritardo lo azzera
  e resti senza memoria. **Rischio reale sul lavoro quotidiano.**

**La mia raccomandazione: (A) adesso, (B) dopo aver misurato la latenza vera** da qui a Frankfurt.
Partire da (B) significherebbe scommettere il funzionamento quotidiano su un numero che non ho
ancora misurato — contro la nostra regola del determinismo.

## 7. Piano in fasi (ognuna verificabile e reversibile)

1. **Dockerfile del gateway** + prova in locale che parte in container Linux (vec0 linux-x64 arriva
   da npm, già verificato). Nessun tocco a Render.
2. **Servizio privato + disco** su Render, DB vuoto. Verifica: health `ok`, embedding `ok`.
3. **Migrazione DB** via SSH (dopo VACUUM su copia). Verifica: conteggi identici all'originale.
4. **`engine/lib/memory.mjs` + innesto in `askLLM`** dietro flag `ARGUS_MEMORY=1` (spento di
   default). Test unitari con memoria finta.
5. **Accensione su UN solo servizio** (`argus-nightly`, il meno critico) e osservazione.
6. Estensione a brain + maker. Poi si riapre la scelta (A)/(B).

**Gate fermi:** niente creazione di servizi Render, nessun costo attivato e nessuna migrazione
senza il tuo OK esplicito. Le fasi 1 e 4 non toccano nulla di vivo e posso farle subito.
