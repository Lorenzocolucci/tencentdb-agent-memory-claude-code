# Sinapsys — Next Blueprint (Judgment + Chat) — 2026-07-01

> **Chi legge questo file a freddo (memoria non arrivata):** questo documento è
> auto-verificabile. Segui la Parte 0 per ricostruire lo stato da zero, la Parte 1
> per le regole di costruzione dei file, poi le Parti 2–3 per il lavoro. Ogni claim
> "esiste già" è ancorato a un path reale verificato il 2026-07-01. Se un path non
> combacia, FERMATI e riverifica prima di costruire — non fidarti di questo doc più
> del codice.

Deciso da Lorenzo (2026-07-01): **non vendiamo Sinapsys.** Lo rendiamo il migliore
possibile *per noi due*, e forse lo pubblichiamo **gratis su GitHub** come dono.
Nord: Sinapsys non è un bibliotecario (recall che vince benchmark), è un **socio** —
memoria che forma **giudizio**, cresce dai suoi errori, e si guadagna il diritto di
fermarti. (Contesto mercato/benchmark: `docs/SINAPSYS-ARCHITECTURE.md` +
schede memoria `sinapsys-*`.)

---

## PARTE 0 — Bootstrap a freddo (verificare TUTTO da zero)

Esegui in ordine. Nessuno di questi passi modifica dati.

1. **Repo + branch.** `git -C C:/Users/lo/tencentdb-agent-memory branch --show-current`
   → deve essere `feat/memory-excellence`. Remote di lavoro = `fork`
   (Lorenzocolucci/tencentdb-agent-memory-claude-code). **MAI push su `origin`/main.**
2. **Gateway vivo?** `curl -s -m 4 http://127.0.0.1:8421/health`
   → risposta JSON (con token: `{"error":"Unauthorized"}` = server su ma serve
   `Authorization: Bearer $TDAI_GATEWAY_TOKEN`). Porta **8421** (non 8420).
   Rilancio gateway: `C:\Users\lo\tdai-gateway\start-gateway.ps1`.
3. **Build verde?** `npm run build` (tsdown). **Test verdi?** `npm test`
   (vitest). Baseline nota: ~586 test, **7 falliti pre-esistenti** (claude-code-plugin
   daemon.test.ts + hook.test.ts — permessi-file/capture Windows, NON Sinapsys).
   Un fallimento nuovo fuori da quei 7 = regressione da risolvere.
4. **Env necessari** (presenza, non valore): `OPENAI_API_KEY` (embeddings +
   estrazione benchmark gpt-4o), `TDAI_LLM_*` (LLM live = Moonshot/Kimi).
   Segreti reali in `C:\Credentials\` — MAI committare.
5. **Interfaccia gateway** (verificata in `src/gateway/server.ts`):
   `GET /health`, `POST /recall {query,session_key}`, `POST /capture`,
   `POST /search/memories`, `POST /search/conversations`, `POST /session/end`,
   `POST /seed` (batch, **bloccante**). Auth Bearer opzionale via `TDAI_GATEWAY_TOKEN`.
6. **Mappa architettura completa:** `docs/SINAPSYS-ARCHITECTURE.md` (layer L0–L5,
   albero, portabilità). `docs/SINAPSYS_FOUNDATIONS.md`, `docs/ENTITY_CORE_BLUEPRINT.md`.

---

## PARTE 1 — Regole di costruzione dei file (vincolanti)

Fonti verificate: `~/.claude/CLAUDE.md` + `~/.claude/rules/common/*` +
`~/.claude/rules/typescript/*`. Sintesi operativa (se in conflitto, vince CLAUDE.md):

- **File piccoli, una cosa per file.** ~200 righe tipiche, **800 max**. Alta coesione,
  bassa coupling. Organizza per dominio, non per tipo. (`coding-style.md`)
- **Immutabilità.** Crea nuovi oggetti con spread, NON mutare in-place. (`coding-style.md`)
- **TDD su dati REALI.** Test prima (RED→GREEN), 80%+ coverage. MAI aggiustare un
  test per nascondere un bug: se un test è davvero sbagliato, FERMATI e chiedi a
  Lorenzo. Verifica contro la forma dei dati VERA (lezione anti-circolarità:
  agenti hanno spedito feature "verdi ma no-op" due volte). (`testing.md`)
- **Ogni modifica = COSA + DOVE (file:riga) + PERCHÉ.** Senza tutti e 3 non è completa.
- **NO file `.bak`** (il repo è git). NB: `~/.claude/rules/common/testing.md.bak`
  esiste e viola questa regola — ignoralo, non è nostro pattern.
- **Errori gestiti ai bordi, input validati (Zod), zero `console.log` in prod,
  zero segreti hardcoded** (usa `process.env`). (`security.md`, `coding-style.md`)
- **La memoria non rompe MAI la conversazione**: errori ingoiati+loggati, fuori dal
  path critico (pattern già ovunque nel core).
- **Git**: commit conventional (`feat:`/`fix:`…), inglese, NIENTE trailer di
  attribuzione (disabilitato globalmente). Commit/push SOLO quando Lorenzo lo chiede.
- **Delega** ad agenti `lo-*` nominati (mai anonimi). Ricerca codice: Augment
  (`mcp__auggie__codebase-retrieval`) come PRIMA scelta.

---

## PARTE 2 — I 3 pilastri del GIUDIZIO (approfondimento, non greenfield)

Principio: NON costruire la versione ordinaria. Questi tre organi trasformano
Sinapsys da "cosa ricordo?" a "cosa devo FARE diversamente?". **Tutti e tre
estendono codice che esiste già** — verificato in `src/core/kb/`.

### Pilastro A — GIUDIZIO (la memoria forma una stance e interviene)
- **Estende** (verificato): il Mistake Notebook — `lessons-runner.ts`
  (cluster→trigger→distill→lesson, `evidence_count`, trigger canonici non-LLM),
  `lesson-trigger.ts`, `lessons-distiller.ts`, `lessons-writer.ts` — PIÙ il gate
  Grounded Trust — `stakes.ts` (high-stakes AND uncertain AND not-confirmed) e
  `grounded-trust-ask.ts` (modello **INTERRUPT**: il socio DEVE sollevare, non è
  una nota soft).
- **Cosa costruire:** generalizzare il "notebook" dai soli bug a **pattern
  comportamentali su Lorenzo** ("sotto deadline taglia la verifica", "decisione X
  contraddice il principio Y dichiarato"). Il pattern diventa una `lesson`
  proattiva che spara via l'interrupt esistente quando lo Spreading Activation
  (`spreading-activation.ts`) lo innesca in un contesto affine.
- **Rischio letale (da design, non opzionale):** giusto, non fastidioso. Una
  stance che grida "al lupo" si silenzia in una settimana. Soglia conservativa
  (riusa la logica `stakes.ts`), evidenza cross-sessione minima prima di sparare,
  e un solo interrupt per volta.

### Pilastro B — CRESCERE DALL'ERRORE (memoria con un track record)
- **Estende** (verificato): `provenance.ts` (unverified→trusted, confirm/reject,
  gate_state), `lesson-reinforcement.ts`, la lapide/tombstone (rejected non-delete).
- **Cosa costruire:** ogni stance/lesson porta un **track record** (hit/miss nel
  tempo). Quando una stance spara ed è confermata → la sua willingness-to-fire
  sale; quando è rifiutata → scende e, se ripetutamente sbagliata, si sopprime
  (non cancella: lapide, come già fa Grounded Trust). La memoria diventa
  **responsabile** di ciò che afferma.
- **Rischio:** non trasformare il track record in inerzia (una stance sbagliata
  una volta ma poi giusta deve poter risalire). Decadimento simmetrico.

### Pilastro C — DIMENTICARE CON GUSTO (distillazione, non accumulo)
> ✅ **Fase 1 (decay consapevole) DEPLOYATA** (`e8056ee`). ✅ **Fase 2 (distillazione) COSTRUITA + DEPLOYATA 2026-07-01** (gateway PID 51356, 21 test verdi, 7 cluster reali sui dati vivi). Scelta di Lorenzo: **conservativo — distilla, non cancella** (le sorgenti decadono via Fase 1, mai rimosse). Principio = atomo `events` type=`principle` alta-salience; clustering per entità con guard cross-sessione su session_id. Design+esito: `docs/superpowers/specs/2026-07-01-pilastro-c-fase2-distillazione-design.md`.
- **Estende** (verificato): `consolidation-runner.ts` (reinforce + decay,
  deterministico, no-LLM), `lifecycle-writer.ts`, `lifecycle-decay.ts` (staleness
  14gg), il sistema a tier.
- **Cosa costruire:** oltre a reinforce/decay, un passo di **distillazione**: da
  ~30k messaggi a **pochi principi guadagnati** ("hard-won principles"), non un
  mucchio cercabile. Tutti gli altri accumulano (più contesto, più recall); la
  nostra diversità è dimenticare bene — il rumore diventa intuito, non righe.
- **Rischio:** distillare via un fatto raro-ma-cruciale (von Restorff). Proteggere
  i picchi distintivi (Idea 5 / cornerstone) dal decadimento.

> Nota di onestà (benchmark 2026-06-30): su LongMemEval hard Sinapsys fa 6/14 —
> forte su multi-session/knowledge-update, **crollo sul temporale** (0/5, terreno
> di Zep/Graphiti). NON inseguiamo quel numero: è la partita del bibliotecario.
> Questi 3 pilastri sono la partita del socio, che nessuno gioca.

---

## PARTE 3 — Le CHAT (portare il socio dove Lorenzo pensa davvero)

### #1 — Ingest automatico giornaliero delle chat claude.ai
- **Metà FATTA (verificato):** `src/cli/backfill/backfill-chat-export.ts` ingerisce
  già un export claude.ai (`conversations.json`) → L0→L1, con redazione segreti,
  embedding, **idempotente** (ledger.db salta gli UUID già visti → sicuro da
  ri-eseguire ogni giorno). ⚠️ SINGLE-WRITER: il gateway tiene `vectors.db` aperto
  (WAL) → o si ferma il gateway durante l'ingest, o si scrive via `POST /seed`
  (che ora completa bene — bug della coda fixato 2026-06-30, commit 8294e39).
- **Metà DA COSTRUIRE (il lavoro vero) = ACQUISIZIONE.** Non esiste API pubblica
  ufficiale per la cronologia chat. Tre strade (NON verificate live — vedi Gate G3):
  1. **Export ufficiale** (impostazioni → zip via mail): ufficiale, ma manuale/lento.
  2. **API interna del browser** (il frontend claude.ai scarica le conversazioni in
     JSON con la sessione loggata): veloce/quotidiana, NON ufficiale, auth fragile
     (token che scade — pattern noto: skill `spa-login-token-seed`).
  3. **Automazione browser** (Claude-in-Chrome): fattibile, la più fragile (UI).
- **Piano #1:** job giornaliero (scheduled task Windows o trigger) → acquisisce le
  conversazioni nuove dall'ultimo cursore → le passa all'ingester idempotente.
  Raccomandazione: partire da (1) per lo storico, valutare (2) per il quotidiano
  DOPO aver verificato Gate G3.

### #2 — Sinapsys DENTRO le chat (il socio nella stanza giusta)
Vincolo reale: claude.ai è il prodotto Anthropic, **non controlliamo il suo motore**
(nessun hook nel system prompt come in Claude Code). Due modi reali:

- **(A) PULL — base robusta (Claude CHIEDE alla memoria).** Wrappare il gateway
  HTTP come **server MCP** (recall/search) → dentro una chat claude.ai (connettori
  MCP), Claude interroga Sinapsys come strumento. Ufficiale, non hackera nulla.
  ⚠️ Meccanismo esatto dei connettori claude.ai = **Gate G4, DA VERIFICARE**.
- **(B) PUSH — l'anima proattiva (la memoria ARRIVA da sola).** Estensione browser
  su claude.ai che vede cosa scrivi, chiama il gateway `/recall`, e inietta il
  ricordo nel tuo messaggio (o in un pannello accanto). È l'UNICO modo per la
  Proactive Injection dentro claude.ai. Più magico, più fragile (dipende dalla UI).
- **Sequenza decisa con Lorenzo:** **PULL come fondamenta, PUSH come anima sopra.**
  Il cuore di Lorenzo batte per il PUSH; costruiamo la base solida prima.
- **Legame con Parte 2:** claude.ai è dove Lorenzo *pensa*. È lì che il GIUDIZIO
  (Pilastro A) deve poter dire "tre chat fa avevi deciso il contrario".

---

## PARTE 4 — Verification Gates (verificare PRIMA di costruire ogni pezzo)

- **G1 (sempre):** Parte 0 tutta verde (gateway vivo, build+test, 7-falliti-noti).
- **G2 (Parte 2):** per ogni pilastro, leggere i file che estende (path in Parte 2)
  e confermare che esistono e fanno ciò che il doc dice. TDD su dati reali.
- **G3 (Parte 3 #1):** verificare COME si ottengono oggi le chat claude.ai (export
  ufficiale? endpoint interno raggiungibile? formato JSON attuale?). **Non l'ho
  verificato live.** Toccare con mano prima di promettere l'automatismo.
- **G4 (Parte 3 #2):** verificare il meccanismo attuale dei connettori MCP di
  claude.ai (esistono? come si registra un server locale? auth?). **Non verificato.**
- **G5 (chiusura):** ogni parte → build verde + verifica live + poi "fatto". Aggiorna
  la scheda memoria `sinapsys-*` e questo doc.

---

## PARTE 5 — Ordine di lavoro proposto (una sessione = un pezzo verificabile)

> **STATO al 2026-07-01 (fine sessione feat/memory-excellence, tutto pushato su fork):**
> - ✅ **Pilastro A (Giudizio)** — LIVE (`b9781ad`).
> - ✅ **Pilastro C Fase 1 (decay) + Fase 2 (distillazione)** — LIVE (`e8056ee`, `e6eb213`).
> - ✅ **Pilastro B (Crescere dall'errore) — SLICE 1 (cervello willingness)** fatta (`9a881e7`), NON cablata. **SLICE 2 (wiring live) = PROSSIMO** → `docs/superpowers/specs/2026-07-01-pilastro-b-track-record-design.md`.
> - ✅ **Cross-cutting fixati**: continuità "dove eravamo" (rollover `0cd8233`), trigger distillazione al session-start (`8fd19d6`), **barriera CJK** — nessun cinese salvato (`d365699`+`c0c1035`).
> - ⏳ **RIMANE**: Pilastro B Slice 2 · #1 ingest chat claude.ai (Gate G3) · #2 PULL(MCP,G4)+PUSH(estensione) · benchmark LongMemEval · residui (fatti-git nel recap, review prompt distiller lo-llm-architect, clustering principi semantico, purga 1 principio cinese pre-barriera).

1. **#1 storico + quotidiano** (valore subito, ingester già pronto): Gate G3, poi
   acquisizione → ingester idempotente → verifica ricordi live.
2. **Pilastro C (Dimenticare con gusto)**: ✅ Fase 1+2 fatte.
3. **Pilastro A (Giudizio)**: ✅ LIVE.
4. **Pilastro B (Crescere dall'errore)**: track record sopra A. ✅ Slice 1 (cervello) — ⏳ Slice 2 (wiring).
5. **#2 PULL (MCP)**: Gate G4, poi wrapper MCP del gateway.
6. **#2 PUSH (estensione)**: l'anima proattiva, quando la base regge.

## PARTE 6 — Porte a senso unico / decisioni per Lorenzo (da confermare a ogni bivio)
- Acquisizione chat: export ufficiale (lento/sicuro) vs API interna (veloce/grigia).
- Pubblicazione GitHub gratuita: quando? (serve README prodotto + getting-started
  multi-OS + LICENSE — `package.json` è già MIT). Zona no-ritorno = dati/segreti fuori.
- Intrusività del Giudizio: soglia di quando il socio ha diritto di fermarti.
