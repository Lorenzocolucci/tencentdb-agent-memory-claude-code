import { describe, it, expect } from "vitest";
import {
  canonicalizeAttribute,
  ATTRIBUTE_CANON_MAP,
  ATTRIBUTE_CANON_VERSION,
} from "../attribute-canon-map.js";

describe("canonicalizeAttribute", () => {
  it("normalizes case and whitespace", () => {
    expect(canonicalizeAttribute("  Status ")).toBe("status");
    expect(canonicalizeAttribute("LINE_COUNT")).toBe("line_count");
  });

  it("maps Italian/Spanish language variants to English canonicals", () => {
    expect(canonicalizeAttribute("stato")).toBe("status");
    expect(canonicalizeAttribute("valore")).toBe("value");
    expect(canonicalizeAttribute("descrizione")).toBe("description");
    expect(canonicalizeAttribute("problema")).toBe("issue");
    expect(canonicalizeAttribute("ruolo")).toBe("role");
    expect(canonicalizeAttribute("utilizzo")).toBe("usage");
    expect(canonicalizeAttribute("tipo")).toBe("type");
    expect(canonicalizeAttribute("versione")).toBe("version");
    expect(canonicalizeAttribute("importancia")).toBe("importance");
  });

  it("maps pure-money synonyms to `cost`", () => {
    expect(canonicalizeAttribute("costo")).toBe("cost");
    expect(canonicalizeAttribute("prezzo")).toBe("cost");
    expect(canonicalizeAttribute("price")).toBe("cost");
    expect(canonicalizeAttribute("costo_reale")).toBe("cost");
  });

  it("GUARD: keeps QUALIFIED money attributes distinct (no false contradictions)", () => {
    // These are different facts, not synonyms of bare `cost`.
    for (const q of [
      "monthly_cost",
      "cost_estimate",
      "costo_annuo",
      "month_to_date_cost",
      "cost_displayed_in_dashboard",
      "real_cost_via_api",
      "api_usage_eur",
    ]) {
      expect(canonicalizeAttribute(q)).toBe(q);
    }
  });

  it("passes unknown attributes through unchanged (never guesses)", () => {
    expect(canonicalizeAttribute("commit_hash")).toBe("commit_hash");
    expect(canonicalizeAttribute("line_count")).toBe("line_count");
    expect(canonicalizeAttribute("rule_wait_for_answer")).toBe("rule_wait_for_answer");
    expect(canonicalizeAttribute("iban")).toBe("iban");
  });

  it("is idempotent for every mapped key (canon(canon(x)) === canon(x))", () => {
    for (const key of Object.keys(ATTRIBUTE_CANON_MAP)) {
      const once = canonicalizeAttribute(key);
      const twice = canonicalizeAttribute(once);
      expect(twice).toBe(once);
    }
  });

  it("no canonical target is itself a mapped key (single-hop stability)", () => {
    const targets = new Set(Object.values(ATTRIBUTE_CANON_MAP));
    for (const t of targets) {
      expect(ATTRIBUTE_CANON_MAP[t]).toBeUndefined();
    }
  });

  it("exposes a numeric version for audit/rollback", () => {
    expect(typeof ATTRIBUTE_CANON_VERSION).toBe("number");
  });
});
