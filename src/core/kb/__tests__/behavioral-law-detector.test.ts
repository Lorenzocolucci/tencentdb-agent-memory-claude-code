/**
 * Slice A1 — behavioral-law-detector (Percorso A brain).
 *
 * The detector is a HIGH-RECALL, deterministic candidate gate: it fires on
 * explicit behavioral directives/corrections Lorenzo states ("aspetta la mia
 * risposta", "non compiacere mai", "d'ora in poi verifica prima"), and stays
 * SILENT on status notes that merely contain a negation ("non ho toccato...",
 * "il flag è spento"). The exact rule text is refined later by the LLM (A3);
 * here we pin detection vs non-detection on REAL phrases.
 */

import { describe, it, expect } from "vitest";
import { detectDirective } from "../behavioral-law-detector.js";

describe("detectDirective — fires on real directives", () => {
  const directives: Array<[string, string]> = [
    ["non proseguire quando sei in attesa di una mia risposta", "prohibition"],
    ["non compiacere mai", "prohibition"],
    ["aspetta la mia risposta prima di proseguire", "prescription"],
    ["d'ora in poi verifica sempre prima di dire fatto", "prescription"],
    ["devi essere sicuro che sia la strada giusta", "prescription"],
    ["ricordati di non pushare mai su main", "prohibition"],
    ["from now on always run the tests before saying done", "prescription"],
    ["never people-please me", "prohibition"],
  ];
  for (const [text, kind] of directives) {
    it(`fires (${kind}) on: "${text.slice(0, 40)}..."`, () => {
      const c = detectDirective(text);
      expect(c).not.toBeNull();
      expect(c!.kind).toBe(kind);
      expect(c!.strength).toBeGreaterThan(0);
      expect(c!.markers.length).toBeGreaterThan(0);
    });
  }
});

describe("detectDirective — stays silent on status / non-directives", () => {
  const noise = [
    "Non ho toccato claude-code-plugin, sospetto fallimenti pre-esistenti.",
    "Il flag ENABLE_MULTILANG_TEMPLATES è attualmente spento.",
    "Working tree pulito — tutto committato.",
    "Il branch principale del progetto Sofia è 'main'.",
    "La barriera al confine LLM è stata deployata con successo.",
    "Il prossimo passo sarà il test dell'idea 5.",
    "",
    "   ",
  ];
  for (const text of noise) {
    it(`silent on: "${text.slice(0, 40)}"`, () => {
      expect(detectDirective(text)).toBeNull();
    });
  }
});

describe("detectDirective — robustness", () => {
  it("never throws on odd input", () => {
    expect(() => detectDirective(undefined as unknown as string)).not.toThrow();
    expect(detectDirective(undefined as unknown as string)).toBeNull();
    expect(detectDirective("!!!???")).toBeNull();
  });

  it("classifies an explicit correction as 'correction'", () => {
    const c = detectDirective("no, quello è sbagliato: non va bene così");
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("correction");
  });

  it("a stronger, unambiguous directive scores higher than a borderline one", () => {
    const strong = detectDirective("d'ora in poi non pushare mai su main")!;
    const soft = detectDirective("devi controllare")!;
    expect(strong.strength).toBeGreaterThan(soft.strength);
  });
});
