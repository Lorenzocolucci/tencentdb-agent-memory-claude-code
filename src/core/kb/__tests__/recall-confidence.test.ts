/**
 * recall-confidence — il gate delle "due marce" (Incremento B1).
 *
 * Valuta se la marcia veloce (System 1) è MAGRA. Deve essere CONSERVATIVO: se il
 * recall è già ricco NON deve dichiararlo magro (altrimenti la passata profonda
 * scatterebbe ogni volta = latenza reintrodotta, il contrario di A). Magro solo se
 * pochi risultati OR nessuno abbastanza forte.
 */
import { describe, it, expect } from "vitest";
import { assessRecallConfidence } from "../recall-confidence.js";

describe("assessRecallConfidence", () => {
  it("recall ricco (>=3 risultati, almeno uno forte) → NON magro", () => {
    const c = assessRecallConfidence([{ score: 0.6 }, { score: 0.5 }, { score: 0.3 }]);
    expect(c.thin).toBe(false);
    expect(c.total).toBe(3);
    expect(c.strong).toBe(2);
  });

  it("pochi risultati (<3) → magro (deepen)", () => {
    expect(assessRecallConfidence([{ score: 0.9 }]).thin).toBe(true);
    expect(assessRecallConfidence([{ score: 0.9 }, { score: 0.8 }]).thin).toBe(true);
  });

  it("nessun risultato → magro", () => {
    expect(assessRecallConfidence([]).thin).toBe(true);
  });

  it("abbastanza risultati ma tutti deboli (nessuno >= soglia) → magro", () => {
    const c = assessRecallConfidence([{ score: 0.1 }, { score: 0.05 }, { score: 0.2 }, { score: 0.15 }]);
    expect(c.thin).toBe(true);
    expect(c.strong).toBe(0);
  });

  it("soglie configurabili", () => {
    const strict = assessRecallConfidence([{ score: 0.6 }, { score: 0.6 }, { score: 0.6 }], { minTotal: 5 });
    expect(strict.thin).toBe(true); // richiede 5 risultati, ne ha 3
    const loose = assessRecallConfidence([{ score: 0.35 }], { minTotal: 1, strongScore: 0.3 });
    expect(loose.thin).toBe(false); // 1 risultato basta, 0.35 >= 0.3
  });

  it("tratta score mancante come 0 (non lancia)", () => {
    const c = assessRecallConfidence([{} as { score: number }, { score: 0.9 }, { score: 0.9 }]);
    expect(c.thin).toBe(false); // total=3, due forti
    expect(() => assessRecallConfidence([{} as { score: number }])).not.toThrow();
  });
});
