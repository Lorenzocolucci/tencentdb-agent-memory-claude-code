# Kickoff prossima sessione — Sinapsys al 100% + test reale + deploy in Argus su Render

> Scritto 2026-07-21 a fine sessione (Cura #1 + Cura #2 2a + 2b-core fatti). Copia il blocco qui sotto nella nuova sessione.

---

Socio, completiamo **Sinapsys al 100%** e la portiamo **dentro Argus su Render** (non più sul mio laptop locale). Ma prima **leggi in ordine**: `docs/vision/01-vision-and-plan/MEMORIA-BLUEPRINT.md` (north-star), `docs/vision/01-vision-and-plan/PIANO-CONSOLIDAMENTO-E-EMBEDDING-20260720.md`, e le schede memoria `sinapsys-cura2-entity-reconciliation`, `sinapsys-cura1-attribute-canon-shipped`, `sinapsys-consolidation-rootcause-fragmentation`, `sinapsys-banner-interrupt-harness-enforcement`, `sinapsys-recall-redesign`, `sinapsys-track2-embedding-qwen3-reindex`. Stato git: branch `feat/consolidation-cura1-attribute-canon` (commit `2bf87fe` Cura#1, `9f40f75` 2a, `a8e7a83` 2b-core; **mai** su main; Track 2 embedding già mergiato in main locale `5d8bb58`, non pushato).

**Regole ferme (non negoziabili):** design-first con ricerca web SOTA **prima** del codice; backup del DB prima di toccarlo; **review lo-code-reviewer + lo-security-auditor PRIMA di ogni apply sul live** (lezione di questa sessione: applicare prima della review è prematuro); non-distruttivo e reversibile; mai push su main; determinismo assoluto (se non verificato, dillo); ambition-bar (mai la versione ovvia); la memoria non rompe mai la conversazione.

**Lavoro rimanente al 100%, in ordine:**

1. **Chiudere Track 1 — consolidamento (la north-star):**
   a. **Cura #2 Fase 2b** — runner report-editabile (`--generate`: auto-cluster 140 flaggati + top-N ask-cluster ordinati per size/importanza, campo decisione `OK|SPLIT:<ids>|NO`; `--apply`: legge il report editato + backup + `pickCanonical` + `mergeEntities`) + **wiring read-path `merged_into`** (`resolveOrCreateEntity` in kb-queries.ts:310 segue la canonica; `queryEntitiesByTokens` e le query entità di recall filtrano `WHERE merged_into IS NULL`) + dry-run live + apply. Il motore (`src/core/kb/entity-merge.ts`) è già fatto e testato.
   b. **Cura #1b** — canonicalizzazione degli **attributi-costo qualificati** (`monthly_cost`/`real_cost_via_api`/`api_usage_eur` → uno) così il caso €18/€387 collassa DAVVERO (il merge entità da solo non basta: vivono su attributi diversi).
   c. **Cura #3** — agganciare la supersession al **Grounded Trust**: se incerto E conta E mai confermato → **CHIEDE a me**, e la mia risposta soppianta per sempre.
   d. **Test d'accettazione su DB reale:** query "costo OpenAI" → un valore consolidato (€18 superseded, €387 corrente, €96 tenuto come misura distinta "dashboard").

2. **Rendere VERA la domanda "chiedo a Lorenzo":** oggi le domande del Grounded Trust **non interrompono** (iniezione ≠ interruzione, provato). Implementare l'interrupt via hook **PreToolUse deny** + banner **systemMessage** (scheda `sinapsys-banner-interrupt-harness-enforcement`). Senza questo, il pilastro "bambino col fuoco" non scatta.

3. **Non perdere niente — cattura automatica delle chat claude.ai:** oggi solo le sessioni Code sono catturate; le chat no (filo 1, API non ufficiale via cookie Desktop DPAPI — scheda `sinapsys-filo1-chat-acquisition`).

4. **PROVARLA DAVVERO (non verde sintetico):** girare Sinapsys su **LongMemEval** (scheda `sinapsys-benchmark-longmemeval`), misurare recall + consolidamento prima/dopo su dati reali, con numeri.

5. **PORTARLA IN ARGUS SU RENDER (non più locale):** design-first del deploy del gateway+store in cloud persistente. Nodi da risolvere: SQLite + sqlite-vec + FTS5 su **disco persistente Render**; **ricompilare vec0 per Linux x64** (oggi ho solo il `.dll` ARM64 Windows); migrare i ~2.5GB di `vectors.db`; provider embedding già remoto (DeepInfra Qwen3-4B, ok in cloud); e soprattutto il **wiring cattura/recall dentro Argus**, che NON usa gli hook di Claude Code (serve un adattatore per far sì che Argus scriva/legga la memoria). Progetta, mostrami il piano, poi build, poi verifica live su Render.

**Parti dal punto 1a.** Prima progetta e mostrami il piano, poi codice incrementale con verifica su dati reali a ogni passo. Fermati solo per le porte a senso unico.
