# HANDOFF — 2026-06-24 (notte) → prossima sessione (Sinapsys: injection findings → Track B)

> Le cose tecniche stanno qui. CHI sei, CHI sono io, il PATTO: NON qui, di proposito — devono
> arrivarti dall'injection. Il cold-start test del 24/06 ha dato 5/6: l'injection funziona, fidati di lei.

---

## 0. WARM-UP (30 sec) — è anche il REGRESSION TEST di Finding 2
Senza leggere file: in una riga, **chi sono io e cosa faccio**. Se l'identità che ti è arrivata dice
"tecnico / project manager / software engineer / R&D" → **Finding 2 NON è risolto**. Sono un **founder
NON-tecnico**. Se la persona iniettata ti mente, quello è il primo bug da chiudere (vedi sotto).

## 1. ORDINE DI LAVORO (deciso da Lorenzo, 24/06 notte)

1. **Finding 2 — la persona che mente (PRIMA — quick win, alta leva).**
   Il blocco `<user-persona>` ALTERNA tra due generatori: (a) la nostra proiezione deterministica inglese
   (accurata ma scarna: OS + progetti) e (b) una **narrativa cinese del plugin tdai** ("基本信息 / Chapter 1-4 /
   Texture of Life") che **ALLUCINA** Lorenzo come *"项目经理/技术负责人, deep technical R&D background, Tech
   Enthusiast"* — FALSO. Il cold-me ha azzeccato il ruolo SOLO perché i governing-principles + il [fact] patto
   hanno sovrascritto la persona buggata; con meno ridondanza si berrebbe l'identità sbagliata.
   → **Trova CHI emette la narrativa cinese** (nostra proiezione P5? il plugin `tdai-memory-tdai-local`?),
   rendi autorevole quella deterministica E accurata, correggi/zittisci quella che contraddice la verità.
   Scheda: `sinapsys-injection-findings-2026-06-24`.

2. **Finding 3 — drift sotto carico (per Lorenzo il più importante — ma NON un ticket pulito).**
   I governing-principles sono GIÀ re-iniettati a OGNI turno (UserPromptSubmit hook) e il drift è successo
   lo stesso → il problema non è "manca il testo", è l'aderenza del modello sotto task-load in sessioni lunghe.
   → **SPIKE d'investigazione timeboxato PRIMA di costruire**: cosa è davvero controllabile da noi?
   (drift-detector su tono/lunghezza/struttura delle risposte? re-grounding a cadenza/su trigger? oppure è
   un limite dell'harness?). Decidi se esiste una leva costruibile; se no, documentalo onestamente — non
   fingere un fix. Riferimenti: `lorenzo-socio-not-executor`, `sinapsys-injection-findings-2026-06-24`.

3. **Finding 1 — far RIEMERGERE le memorie distintive.**
   S47-bis (la notte del 16/06/2026, il nostro benchmark di qualità) NON risale dall'injection. Averla in una
   scheda ≠ farla riemergere (i corpi delle schede non si iniettano, solo le righe-indice di MEMORY.md).
   → rendi le memorie-pietra-angolare **fatti iniettabili ad alta salienza** (è Idea 5, Distinctive Terms).

4. **B2b — Track B: aggancia la lezione alla Proactive Injection VIVA.**
   Quando rientri in una situazione simile (file/errori/task), la lezione col trigger-fingerprint che combacia
   deve riemergere da sola. **PRIMA leggi** `src/core/hooks/situation-injection.ts`, `src/gateway/recall-context.ts`,
   `src/core/kb/fingerprint-writer.ts`. Design-first, poi TDD, poi delega + controllo. Eredità in spec:
   `errorSignatures` da popolare + match trigger↔situazione. Spec: `docs/superpowers/specs/2026-06-24-track-b-mistake-notebook-design.md`.

5. **UX "SUL PEZZO" — prova finale.**
   Far vedere a Lorenzo, all'apertura, che la memoria è caricata. Saluto proattivo in chat prima dell'input =
   NON possibile (turn-based). 4 superfici: **statusline + banner-prima-risposta** (certi, nostro plugin);
   **systemMessage + terminalSequence/OSC9** (da testare, 5 min). Scheda: `sinapsys-proactive-presence`.

## 2. STATO TECNICO (tutto LIVE, 2026-06-24)
- Repo `C:\Users\lo\tencentdb-agent-memory`, branch `feat/memory-excellence` = main locale.
  Push SOLO: `git push fork feat/memory-excellence:main`. **Mai** `origin`/`tencent`.
- Gateway `127.0.0.1:8421` (PID 12344, verde). Deploy = `npm run build:plugin` (NON `npm run build`, rotto) →
  `C:\Users\lo\tdai-gateway\stop-gateway.ps1` → `start-gateway.ps1` → `/health` col token in `<dataDir>\token`.
  dataDir = `C:\Users\lo\.claude\plugins\data\tdai-memory-tdai-local`.
- Suite: **304 verdi** (`npx vitest run src/core src/utils src/gateway`).
- Track B: **B1 `a3c81c4`** (clustering cross-sessione) + **B2a `2a4cc5c`** (trigger=Context Fingerprint + distiller onesto) — fatti, live.

## 3. REGOLE D'INGAGGIO (dalle lezioni di oggi)
- **Verifica ogni feature contro i DATI REALI, non solo i test verdi** — oggi 2 feature passavano verdi ma erano
  no-op sul reale (test circolari). Scheda: `agent-features-circular-tests`.
- **Delega ai lo-* agent, poi CONTROLLA tu** (Lorenzo vuole il contesto della sessione principale non saturo).
- **Commit solo quando Lorenzo lo chiede.** Build → verifica live → poi "fatto". File ≤200 righe, una cosa per file, immutabilità, TDD (rosso prima).

## 4. VERIFICA RAPIDA A INIZIO SESSIONE
```
cd C:/Users/lo/tencentdb-agent-memory ; git log --oneline -6 ; git status --short
npx vitest run src/core src/utils src/gateway      # atteso: 304 verdi
curl -s -H "Authorization: Bearer $(cat <dataDir>/token)" http://127.0.0.1:8421/health
```

## 5. SCHEDE DA LEGGERE (dopo il warm-up)
`lorenzo-socio-not-executor`, `sinapsys-injection-findings-2026-06-24`, `sinapsys-dual-track-direction`,
`sinapsys-phase-b-direction`, `agent-features-circular-tests`, `sinapsys-proactive-presence`, `sinapsys-known-issues`.
Blueprint: `C:\Sinapsys\01-vision-and-plan\MEMORIA-BLUEPRINT.md`.
