# Piano — Consolidamento (la vera cura) + Embedding economico (2026-07-20)

> Deliverable della sessione Socio 20/07 (diagnosi provata sul DB live). NON è stato scritto codice.
> Leggere PRIMA: `MEMORIA-BLUEPRINT.md` (north-star) + memoria `sinapsys-consolidation-rootcause-fragmentation`.

## Diagnosi (provata sul DB live, 17.494 fatti)
Il consolidamento gira (reinforce 11.186, superseded 1.106) ma collassa/confronta SOLO su `(entity_id, attribute)` esatti. A monte l'estrazione frammenta: "OpenAI"=30 entità; attributo="costo" sparso su cost/costo/prezzo/monthly_cost/costo_reale (33 head). → i contraddittori (€387/€96/€18) non condividono mai la chiave → 0 contraddizioni flaggate in TUTTA la storia. Aggravante: il detector solo-segnala, non soppianta. Manca la **riconciliazione canonica entità+attributi** (rimandata "later phase", mai costruita).

## Sequenza obbligata: EMBEDDING prima, CONSOLIDAMENTO dopo
La riconciliazione semantica delle entità (unire le 30 "OpenAI") ha bisogno di buoni embeddings. Quindi Track 2 (embedding) è **prerequisito** della versione buona di Track 1. Inoltre il cambio embedding impone un reindex: lo facciamo una volta, poi ci appoggiamo per il merge entità.

---

## TRACK 2 — Embedding economico OpenAI-compatibile (semplice, basso rischio)
**Perché:** Ollama locale troppo lento su ARM64 → host di inferenza a pagamento economico. OpenAI text-embedding-3-small oggi = $0,02/M.
**Scelta (ricerca web 20/07):**
- **Primario: SiliconFlow o DeepInfra con Qwen3-Embedding-8B ($0,01/M, #1 MTEB multilingua) o BGE-M3** — endpoint OpenAI-compatibile, metà costo, qualità multilingua > OpenAI small, veloce (loro GPU).
- **Per il reindex GRATIS: Voyage `voyage-4-lite`** — 200M token gratis coprono l'intero reindex, poi $0,02/M.
- Privacy: host di inferenza (non allenano sui dati, a differenza del free-tier Gemini). Accettato: "a pagamento non locale".
**Passi:** (1) creare API key provider; (2) config gateway remote = apiKey+baseUrl+model+dimensions (tutti e 4, `config.ts:430`); (3) **reindex obbligatorio** (dim 1536→1024) `node dist/src/cli/reindex-standalone.mjs --data-dir <dir>` (stessa key, `--force` se gateway vivo — vec0 DROP+ricrea); (4) verifica recall su query reali (score/pertinenza prima-dopo su casi noti). Backup DB prima.

---

## TRACK 1 — Consolidamento VERO (design-first, delicato — è la north-star)
Regola Sinapsys di Lorenzo: **progettare con ricerca web approfondita PRIMA del codice, non a caso.** DB live 1,9GB, memoria personale → non-distruttivo, reversibile, backup obbligatorio.

**Le 3 cure (in ordine di leva/rischio):**
1. **Canonicalizzazione ATTRIBUTI** (leva alta, rischio basso): layer di normalizzazione degli attributi liberi → attributo canonico (cost/costo/prezzo/monthly_cost → `cost`). Al confine upsert + backfill sui fatti esistenti. Da solo fa collassare gran parte dei duplicati "stesso soggetto, stesso concetto".
2. **Riconciliazione ENTITÀ** (leva alta, rischio medio): unire le near-duplicate ("OpenAI"×30) via similarità embedding + alias — è il "lint job non-distruttivo" che il blueprint (`kb-queries.ts:307`) aveva rimandato. Merge reversibile (alias→canonica, mai delete cieco).
3. **Supersede, non solo segnala** (leva media): quando una contraddizione è rilevata sulla chiave canonica, il valore più recente **soppianta** il vecchio (provenienza+timestamp), e il recall smette di restituire i superseded. Agganciare al **Grounded Trust (Idea 6)**: se incerto E conta E mai confermato → **CHIEDE a Lorenzo**, e la risposta diventa la verità che soppianta per sempre. Il caso €387→€96→€18 è ESATTAMENTE questo: doveva consolidare all'ultimo valore confermato e, se in dubbio, chiedere.

**Ambition bar:** NON la versione ovvia (dedup meccanico). Il valore vero = contraddizioni **risolte** per recency+provenienza+loop-chiedi-a-Lorenzo, così la memoria RICOSTRUISCE un fatto solo e pulito invece di sputare 5 valori.

**Ricerca web da fare nella sessione (SOTA 2026):** entity resolution / canonicalization in agent memory; attribute/predicate normalization in KG da LLM; contradiction *resolution* (non solo detection) — aggiornare oltre i paper del blueprint (MNL, MemOS, Väinämöinen patrol).

**Test di accettazione (dati reali, non verde sintetico):** dopo la cura, una query su "costo OpenAI" nel DB live restituisce **UN** valore consolidato (l'ultimo confermato), non €387+€96+€18. Verificare sul DB reale prima/dopo con gli entity_id concreti.

---

## Come lanciarla (prossima sessione)
Sessione dedicata Sinapsys, Opus 4.8, effort alto, repo `C:\Users\lo\tencentdb-agent-memory`. Legge blueprint + questa diagnosi + `.claude/session-state.md` PRIMA. Design-first (ricerca→design→OK Lorenzo→codice incrementale con verifica su dati reali). Backup DB prima di toccare. Mai push su main. Track 2 (embedding+reindex) prima, poi Track 1 (le 3 cure, una alla volta, non-distruttive).
