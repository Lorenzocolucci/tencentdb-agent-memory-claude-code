/**
 * Attribute canonicalization (Consolidation — Cura #1).
 *
 * WHAT: a deterministic, no-LLM map from free-text fact attributes to a canonical
 * language-neutral English snake_case attribute. `canonicalizeAttribute()` is the
 * single source of truth, imported by BOTH the write path (upsertFact) and the
 * one-off backfill.
 *
 * WHY: extraction fragments the SAME concept across languages and surface forms
 * ("stato"/"status", "valore"/"value", "costo"/"cost"). Because the HEAD key is
 * (entity_id, attribute), fragmented attributes never collide, so upsertFact's
 * bi-temporal supersession never fires and contradictory values coexist forever.
 * Collapsing synonyms onto one canonical key lets the EXISTING supersession
 * engine (kb-queries.ts upsertFact) do its job — no new engine needed.
 *
 * DESIGN GUARDS (SOTA 2026: over-canonicalization fabricates false contradictions):
 *   - Only TRUE synonyms are mapped. QUALIFIED variants stay DISTINCT on purpose:
 *     `monthly_cost`, `cost_estimate`, `costo_annuo`, `month_to_date_cost`,
 *     `cost_displayed_in_dashboard`, `real_cost_via_api` — these are DIFFERENT
 *     facts, not synonyms of bare `cost`. Merging them would invent contradictions.
 *   - Casing/whitespace is normalized for everyone (safe: extraction already
 *     enforces lowercase snake_case going forward).
 *   - Unknown attributes (incl. all `rule_*`, `commit_hash`, `line_count`, …)
 *     pass through unchanged — never guessed.
 *
 * Deterministic + reversible: the map is versioned; the backfill records every
 * (fact_id, old_attribute → new_attribute) change to an audit log; no DELETE.
 */

/** Bump when the map changes; recorded in the backfill audit log for rollback. */
export const ATTRIBUTE_CANON_VERSION = 1;

/**
 * Synonym → canonical. Keys MUST be lowercase (lookup lowercases the input).
 * Every entry corresponds to a real attribute observed in the live KB
 * (facts table, count>=3). Grouped by canonical target for auditability.
 */
export const ATTRIBUTE_CANON_MAP: Readonly<Record<string, string>> = Object.freeze({
  // status
  // NB: "statuto" (statute/bylaws — Lorenzo runs a legal practice) and bare
  // "attuale" (current, ambiguous) are DELIBERATELY NOT mapped — mapping them
  // onto `status` would fabricate false contradictions (see DESIGN GUARDS).
  stato: "status", stato_attuale: "status", current_status: "status",
  // value
  valore: "value", valore_attuale: "value", valore_corrente: "value", current_value: "value",
  // description / definition
  descrizione: "description", significato: "description", definizione: "definition",
  // issue / problem
  problema: "issue", problem: "issue", problematica: "issue", issues: "issue", ha_problema: "issue",
  // role
  ruolo: "role",
  // usage
  uso: "usage", utilizzo: "usage", use: "usage", usa: "usage",
  // type
  tipo: "type",
  // function / functionality
  funzione: "function", funzionamento: "function", funziona: "function",
  funzionalita: "functionality", "funzionalità": "functionality", funzionalit: "functionality",
  // version
  versione: "version", versione_corrente: "version", versione_attuale: "version", current_version: "version",
  // solution / resolution
  soluzione: "solution", soluzione_proposta: "solution", risoluzione: "resolution",
  // behavior
  comportamento: "behavior", current_behavior: "behavior",
  // action
  azione: "action",
  // update
  aggiornamento: "update", aggiornato: "update", updated: "update",
  // decision
  decisione: "decision",
  // content
  contenuto: "content",
  // language
  lingua: "language", lingue: "language", languages: "language",
  // location / address
  ubicazione: "location", indirizzo: "address",
  // integration
  integrazione: "integration",
  // size
  dimensione: "size", dimensioni: "size",
  // duration
  durata: "duration",
  // importance
  importanza: "importance", importancia: "importance", rilevanza: "importance",
  // creation
  creazione: "creation",
  // cause
  causa: "cause",
  // requirement
  requisito: "requirement", requisiti: "requirement", requirements: "requirement", richiesto: "requirement",
  // error
  errore: "error",
  // verification
  verifica: "verification",
  // tool
  strumento: "tool", strumenti: "tool", tools: "tool",
  // architecture / configuration / implementation
  architettura: "architecture", configurazione: "configuration", implementazione: "implementation",
  // existence / availability
  esistenza: "existence", exists: "existence",
  disponibilita: "availability", "disponibilità": "availability", disponibilit: "availability",
  // result
  risultato: "result",
  // request
  richiesta: "request",
  // objective
  obiettivo: "objective", obiettivi: "objective",
  // phase / approach / category
  fase: "phase", approccio: "approach", categoria: "category",
  // command / rule / procedure / environment / level
  comando: "command", regola: "rule", procedura: "procedure", ambiente: "environment", livello: "level",
  // pure-money synonyms ONLY (qualified money attrs stay distinct — see guards)
  costo: "cost", prezzo: "cost", price: "cost", costo_reale: "cost", importo: "cost",
  // trivial English plurals
  changes: "change", commits: "commit", features: "feature", rules: "rule", tests: "test", components: "component",
});

/**
 * Canonicalize a fact attribute. Deterministic, pure, no LLM.
 *   1. trim + lowercase (safe normalization for legacy mixed-case attributes)
 *   2. map known synonym → canonical; unknown → the normalized form unchanged
 * Idempotent: canonicalizeAttribute(canonicalizeAttribute(x)) === canonicalizeAttribute(x).
 */
export function canonicalizeAttribute(attribute: string): string {
  const key = attribute.trim().toLowerCase();
  return ATTRIBUTE_CANON_MAP[key] ?? key;
}
