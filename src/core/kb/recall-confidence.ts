/**
 * recall-confidence.ts — il gate delle "due marce" (Incremento B1).
 *
 * Sistema 1 (recall veloce, situation-associativo) è la marcia di default. Questo
 * gate decide quando NON basta e serve la marcia "a sforzo" (passata associativa più
 * profonda: più hop/vicinato — sempre O(vicinato), MAI scansione globale). È
 * deliberatamente CONSERVATIVO: se il recall è già ricco NON lo dichiara magro,
 * altrimenti la passata profonda scatterebbe ogni volta e reintrodurrebbe la latenza
 * che l'Incremento A ha rimosso.
 *
 * Puro, totale, mai throw.
 */

/** Un risultato di recall di cui serve solo lo score (0-1). */
export interface ScoredLike {
  readonly score: number;
}

export interface RecallConfidence {
  /** True quando la marcia veloce è magra e vale la pena approfondire. */
  readonly thin: boolean;
  /** Quanti risultati in totale. */
  readonly total: number;
  /** Quanti risultati con score >= strongScore. */
  readonly strong: number;
  /** Motivo human-readable (per il log), "" quando non magro. */
  readonly reason: string;
}

export interface RecallConfidenceOptions {
  /** Sotto questo numero di risultati totali → magro (default 3). */
  readonly minTotal?: number;
  /** Uno score >= a questo conta come "forte" (default 0.4). */
  readonly strongScore?: number;
}

const DEFAULT_MIN_TOTAL = 3;
const DEFAULT_STRONG_SCORE = 0.4;

/**
 * Valuta la confidenza del recall veloce. Magro se: pochi risultati (< minTotal)
 * OPPURE nessun risultato abbastanza forte (strong === 0). Non lancia mai.
 */
export function assessRecallConfidence(
  results: ReadonlyArray<ScoredLike>,
  opts?: RecallConfidenceOptions,
): RecallConfidence {
  const minTotal = opts?.minTotal ?? DEFAULT_MIN_TOTAL;
  const strongScore = opts?.strongScore ?? DEFAULT_STRONG_SCORE;
  const list = results ?? [];
  const total = list.length;
  let strong = 0;
  for (const r of list) {
    if ((r?.score ?? 0) >= strongScore) strong++;
  }
  const thin = total < minTotal || strong === 0;
  const reason = thin
    ? `total=${total} strong=${strong} (need total>=${minTotal} & strong>=1)`
    : "";
  return { thin, total, strong, reason };
}
