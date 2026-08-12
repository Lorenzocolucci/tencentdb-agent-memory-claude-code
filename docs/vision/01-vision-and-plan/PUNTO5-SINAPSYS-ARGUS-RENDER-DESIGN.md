# Punto 5 — Sinapsys ONLINE dentro Argus su Render (design-first)

> Autore: Socio (Claude) — 2026-07-21. Design-first con ricerca SOTA PRIMA del codice.
> Stato: **PROPOSTA — nulla toccato su Render o sul DB live.** Attende OK di Lorenzo sulle 3 decisioni.
> Fonti verificate file:riga (non a memoria). Regole ferme: backup prima di migrare, non-distruttivo, reversibile, segreti mai committati, mai push su `tencent`.

---

## 0. Cosa ho verificato (deterministico, non a memoria)

| Fatto | Verifica |
|---|---|
| **Argus vive in `C:\Argus`** (la nota vecchia "non accessibile" cercava in `~/argus*` = home, sbagliato) | `ls /c/Argus` → engine/, Dockerfile, plan.md, HANDOFF.md |
| Argus = **Node/ESM `.mjs` puro, NIENTE package.json**, immagine **Docker `node:22-slim`** su Render | `C:\Argus\Dockerfile` |
| **3 servizi Argus, UNA immagine**: `argus-brain` (chat/controllo), `argus-maker` (`srv-d9d4qbt7vvec73esijhg`, fixer), `argus-nightly` (brief 07:00) | `C:\Argus\HANDOFF.md` |
| Argus **parla GIÀ a un gateway Sinapsys via HTTP** con Bearer token: `recall()` + `writeFacts()`, fail-safe | `C:\Argus\engine\lib\memory.mjs` |
| Oggi su Render quel client è **no-op**: risolve il gateway da `state.json` (path Windows) → `http://127.0.0.1:port`; su Linux il file non c'è → `enabled=false` | `memory.mjs:19,46,52,59` |
| DB live = **2.4GB** SQLite, embeddings **DeepInfra Qwen3-Embedding-4B / 1024-dim** (la memoria Argus che diceva "OpenAI 1536" è **STALE**, pre-migrazione 21/07) | `vectors.db` 2.4G + `embedding_meta` |
| Store = **`node:sqlite` built-in (Node 22+, `DatabaseSync`, SINCRONO) + `sqlite-vec`** con optional-dep `sqlite-vec-linux-x64` auto-load su Linux → **niente ricompilazione vec0** | `src/core/store/sqlite.ts:14,24` + `package.json` engines `>=22.16.0` |
| Gateway = daemon standalone, config da env; **escape hatch bind remoto**: `TDAI_GATEWAY_ALLOW_REMOTE=1`; porta `TDAI_GATEWAY_PORT`; token `TDAI_TOKEN_PATH`/`TDAI_GATEWAY_TOKEN`; data dir `TDAI_DATA_DIR` | `src/gateway/cli.ts:26-38`, `src/gateway/config.ts` |
| LLM estrazione (per `/seed`) = **Moonshot** via `TDAI_LLM_BASE_URL/API_KEY/MODEL` (ereditate da env utente Windows oggi) | env dump + `config.ts:90-97` |

### Vincoli Render (ricerca SOTA 2026)
- **Un disco persistente = UN solo servizio, non condivisibile, no multi-istanza** — per prevenire corruzione ([render.com/docs/disks](https://render.com/docs/disks)). ⟹ combacia con **SQLite single-writer**.
- **Private service + rete privata automatica**: hostname interno `http://<svc>:<port>`, nessun URL pubblico, stessa region/workspace ([render.com/docs/private-services](https://render.com/docs/private-services), [render.com/docs/private-network](https://render.com/docs/private-network)). L'auth resta a livello app = il Bearer token del gateway.
- **File da 2.4GB sul disco**: SSH → `rsync -P --append-verify` sul mount path (resumibile); il disco NON è accessibile in build/pre-deploy/one-off, solo a runtime via SSH ([render.com/docs/disks](https://render.com/docs/disks)).

---

## 1. Architettura scelta: **"Gateway-as-a-Service"**

```
        RETE PRIVATA RENDER (stessa region+workspace, nessun URL pubblico)
  ┌───────────────┐   ┌───────────────┐   ┌────────────────┐
  │  argus-brain  │   │  argus-maker  │   │  argus-nightly │
  └───────┬───────┘   └───────┬───────┘   └────────┬───────┘
          │  HTTP /recall /seed /kb/write (Bearer token)      │
          └───────────────────┼───────────────────────────────┘
                              ▼
              ┌─────────────────────────────────┐
              │   sinapsys-gateway (PRIVATE)     │  ← 1 sola istanza
              │   node gateway/cli.mjs           │
              │   Disco persistente /var/data    │  ← vectors.db 2.4GB
              └─────────────────────────────────┘
```

Il gateway Sinapsys diventa **un servizio Render privato a sé stante, singola istanza, con il disco persistente** che contiene `vectors.db`. I 3 servizi Argus lo chiamano **via rete privata** riusando il client `memory.mjs` che ESISTE GIÀ. Nessuna esposizione pubblica.

### Perché questa batte la vecchia idea "riscrivi su Supabase pgvector" (memoria Argus 19/07)
La memoria `argus-memoria-sinapsys` proponeva un mirror su **Supabase pgvector `vector(1536)` + nuovo backend Postgres `IMemoryStore` async + re-embed di tutto**. È **superata** dalla decisione di Lorenzo del 21/07 (SQLite su disco). Il perché è tecnico:
- **Zero riscrittura dello store**, zero re-embed (i 2.4GB sono GIÀ Qwen3/1024), zero ricompilazione vec0.
- **Preserva intatte tutte e 5 le idee associative** + spreading-activation (JS puro, gira uguale).
- SQLite single-writer ⟷ Render single-instance-disk = **accoppiamento naturale**, non forzato.
- Il pgvector avrebbe richiesto di riscrivere `spreadActivation`/priming/fingerprint contro Postgres async: settimane di lavoro + rischio di regредire il differenziatore. Scartata con motivo.

---

## 2. I quattro cantieri

### (a) Migrazione dei 2.4GB `vectors.db` sul disco persistente
1. **BACKUP prima di tutto** (non-distruttivo): `cp vectors.db vectors.db.bak-pre-render-<ts>` in locale + verifica dimensione/`PRAGMA integrity_check`. Il DB del laptop **non si tocca**.
2. Provisiona il servizio `sinapsys-gateway` con **disco ~10GB** mount `/var/data` (2.4GB ora + testa per crescita, WAL, e un backup on-disk).
3. Deploy immagine gateway con DB vuoto → **SSH nel servizio** → `rsync -P --append-verify` del backup locale → `/var/data/vectors.db` (resumibile sui 2.4GB). Copia anche `kb-nav-index.v1.snapshot.json` e il file `token`.
4. Restart → `/health` verde → **smoke recall** (una query nota → confronto col laptop).
- **Reversibile**: il DB del laptop resta intatto; per abortire, si cancella il servizio. Nessun dato perso.

### (b) Ri-wiring CATTURA e RECALL dentro Argus SENZA hook Claude Code
- **RECALL — già costruito.** `memory.mjs.recall()` funziona; basta puntarlo al gateway cloud. Modifica minima: far leggere base+token da **env `SINAPSYS_GATEWAY_URL` / `SINAPSYS_GATEWAY_TOKEN`**, con il fallback `state.json` attuale per il laptop. Flag-gated, default = comportamento attuale (byte-identico se le env mancano).
- **CATTURA — serve "l'hook di Argus".** Oggi la cattura passa dagli hook CC (SessionStart/PostToolUse/Stop → `/seed`). Argus non ha hook CC: è il guardian `.mjs`. ⟹ Aggiungere una **chiamata di cattura nel loop del brain** (dopo ogni turno e/o dopo ogni esito di indagine/fix) che fa `POST /seed` fire-and-forget, fail-safe (come tutto memory.mjs). È "l'hook di Argus" a livello di codice, non un hook CC. Flag `ARGUS_SINAPSYS_CAPTURE`, default OFF.
- TDD RED-first; review `lo-code-reviewer` + `lo-security-auditor` in parallelo (regola Argus + globale).

### (c) Setup servizio Render
- Tipo: **private web service** (deve ricevere richieste dai servizi Argus). Stessa **region + workspace** di `argus-brain/maker` (cross-region non parla).
- Disco persistente `/var/data`.
- Env (manifest completo sotto). Bind: `TDAI_GATEWAY_HOST=0.0.0.0` + `TDAI_GATEWAY_ALLOW_REMOTE=1`, porta mappata su quella che Render assegna.
- Indirizzo interno risultante es. `http://sinapsys-gateway:<port>` → va in `SINAPSYS_GATEWAY_URL` dei servizi Argus.
- **Nota Node 22**: `node:sqlite` è built-in ma in alcune versioni emette warning/richiede flag — verificare all'avvio (`--experimental-sqlite` se necessario) sul `node:22-slim`.

### (d) Segreti come env Render (mai committati)
Manifest env del servizio `sinapsys-gateway`:
| Env | Valore | Fonte |
|---|---|---|
| `TDAI_GATEWAY_HOST` | `0.0.0.0` | fisso |
| `TDAI_GATEWAY_ALLOW_REMOTE` | `1` | fisso (bind rete privata) |
| `TDAI_GATEWAY_PORT` | porta Render | Render |
| `TDAI_DATA_DIR` | `/var/data` | fisso (mount disco) |
| `TDAI_GATEWAY_TOKEN` *(o `TDAI_TOKEN_PATH`)* | token Bearer | **segreto** |
| `TDAI_LLM_BASE_URL` | `https://api.moonshot.ai/v1` | estrazione |
| `TDAI_LLM_API_KEY` | Moonshot | **segreto** |
| `TDAI_LLM_MODEL` | `moonshot-v1-auto` | estrazione |
| `DEEPINFRA_API_KEY` | DeepInfra | **segreto** (embedding Qwen3-4B) |
| `OPENAI_API_KEY` | OpenAI | **segreto** (fallback/altri path) |
| *(config embedding provider/baseUrl/model/dim)* | **DA PINNARE in build** ⚠️ | vedi §4 |

Env lato servizi Argus: `SINAPSYS_GATEWAY_URL`, `SINAPSYS_GATEWAY_TOKEN`, `ARGUS_SINAPSYS_CAPTURE` (flag).

---

## 3. Decisioni GENUINE per Lorenzo (porte a senso unico / sue per natura)

1. **Workspace Render.** Quale? Non lo scelgo io (regola sicurezza + il tool Render lo pretende). Serve conferma.
2. **Un cervello o due? (semantica del "dual-home").** Dopo la copia, laptop e cloud **divergono** (nessun sync-back automatico). Due strade:
   - **(A) Cloud = cervello DI ARGUS**, seedato una volta dallo snapshot, poi cresce dalle catture di Argus. Il laptop resta com'è. Fratelli con antenato comune; si accetta la divergenza (ri-snapshot occasionale se serve). *Racc. mia: A — semplice, reversibile, nessuna superficie pubblica.*
   - **(B) Cloud = UNICO cervello**, e anche gli hook CC del laptop puntano al cloud. Un solo cervello ovunque, MA il gateway deve essere raggiungibile dal laptop via internet (URL pubblico o tunnel) → **superficie di sicurezza + latenza** sul budget recall di 6s degli hook.
3. **GDPR — cosa cattura Argus nel DB cloud.** Sofia tratta PII di clienti immigrati. Salvare gli **L0 grezzi** (conversazioni con PII) in un SECONDO DB cloud è una nuova superficie dati-at-rest. Opzioni: **solo fatti distillati/operativi (niente PII grezza)** vs **L0 pieni**. *Racc. mia: facts-only nel cloud (coerente col "default NO L0 grezzo" già annotato).* Decisione tua da titolare del dato.

Conferme operative (non porte a senso unico, ma servono): costo disco ~10GB + servizio always-on.

---

## 4. Config embedding — PINNATA (risolta deterministicamente 2026-07-21)
La config del gateway è risolta da `loadGatewayConfig` (`gateway/config.ts:100-138`) da un **file `tdai-gateway.yaml`** via `resolveConfigPath()`: 1) env `TDAI_GATEWAY_CONFIG` → 2) CWD → 3) default data dir. Il file live è **`~/.memory-tencentdb/memory-tdai/tdai-gateway.yaml`** (data dir di default, NON quella del DB) e contiene:
```yaml
memory:
  embedding: { enabled: true, provider: deepinfra,
    baseUrl: https://api.deepinfra.com/v1/openai,
    apiKey: <SEGRETO>, model: Qwen/Qwen3-Embedding-4B, dimensions: 1024 }
  extraction: { engine: kb, kbProjections: true }
  recall: { source: kb }
```
Fatti operativi per Render:
- **`recall.source: kb`** ed **`extraction.engine: kb`** vanno replicati ESATTI (è il path associativo reale — coerente con `sinapsys-benchmark-longmemeval`).
- ⚠️ **`src/config.ts:385` legge `embedding.apiKey` dal YAML, SENZA fallback env.** Per NON bakeare il segreto DeepInfra nell'immagine Docker → usare un **Render Secret File** che monta `tdai-gateway.yaml` a un path, con env **`TDAI_GATEWAY_CONFIG=<quel path>`**. In alternativa, un piccolo entrypoint che scrive il YAML da env al boot. (Il codice `factory.ts:106-114` avverte a WARN se l'apiKey non risolve — nessun degrado silenzioso.)
- Questo file NON è committato (né va committato): è materiale-segreto, arriva come Render Secret File.

---

## 4-bis. DECISIONI PRESE da Lorenzo (2026-07-21) + fatti Render finali

- **Decisione 1 = B — UN CERVELLO UNICO.** Il gateway cloud diventa l'unico cervello; anche gli hook CC del laptop lo puntano. ⟹ **Il gateway NON è più solo-privato: è un web service PUBBLICO** (HTTPS `onrender.com`). Argus lo raggiunge via **hostname interno privato** (veloce, non esce da Render); il **laptop** via **URL pubblico HTTPS** col token. Un solo `vectors.db`, un solo processo gateway = un solo writer (serializza). Il gateway locale del laptop va in **pensione** (DB locale = backup). ⚠️ Da verificare in build: **latenza laptop→frankfurt** dentro il budget recall degli hook CC (memory.mjs Argus usa 10s; gli hook CC hanno budget più stretto — misurare).
- **Decisione 2 = L0 PIENI (PII inclusa).** Cattura completa nel cloud, incl. conversazioni grezze con PII cliente (coerente con la decisione GDPR di Lorenzo titolare del dato, `C:\Argus\plan.md` M5). ⟹ **Intersezione critica: gateway PUBBLICO che contiene PII.** Pavimento di sicurezza OBBLIGATORIO prima del live (audit `lo-security-auditor`): token forte 32B, **solo HTTPS**, rate-limit, valutare **IP-allowlist Render**, confermare **encryption-at-rest del disco Render**. NON è un blocco al design, è un gate di sicurezza pre-live.
- **Decisione 3 = elenca workspace.** FATTO: un solo workspace **"My Workspace"** (`tea-d3ejq8ali9vc739qbblg`).

### Fatti Render verificati (sola-lettura, 2026-07-21)
- **Region = `frankfurt`** per TUTTI i servizi Argus (`argus-brain srv-d9bqa8r7uimc73cgno7g`, `argus-maker srv-d9d4qbt7vvec73esijhg`, `argus-nightly crn-d9bqa9bbc2fs73aqs44g`). Il gateway **deve** stare a frankfurt.
- Argus = background worker/cron su piano `starter` (512MB). **Il gateway richiede RAM ≥ ~2GB** (2.4GB DB + indice navigabile in memoria) → piano **Standard**. Costo stimato: Standard ~$25/mese + disco 10GB ~$2.5/mese = **~$28/mese** (always-on).
- **Prerequisito di build:** il repo `tencentdb-agent-memory` **non ha un Dockerfile** (oggi il gateway gira come daemon Windows). Serve **creare un Dockerfile** `node:22` che builda TS→`dist/` e lancia `dist/src/gateway/cli.mjs`, con `sqlite-vec` (linux-x64 auto) — un servizio Render nuovo che punta a questo repo. Verificare il flag `node:sqlite` su node 22.

## 5. Ordine di esecuzione (dopo GO di Lorenzo)
1. Backup locale `vectors.db` + `integrity_check`.
2. Pinnare config embedding (§4).
3. Creare servizio `sinapsys-gateway` privato + disco (workspace/region confermati).
4. Deploy immagine gateway; SSH; rsync 2.4GB; restart; `/health` + smoke recall.
5. Wiring `memory.mjs` recall via env (flag) — TDD + review.
6. Wiring cattura Argus `/seed` (flag OFF) — TDD + review — poi accensione secondo decisione GDPR.
7. Verifica dal vivo end-to-end (Argus cloud fa recall reale) prima di dire "fatto".
