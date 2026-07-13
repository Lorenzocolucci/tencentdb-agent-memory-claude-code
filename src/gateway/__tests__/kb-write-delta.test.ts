/**
 * POST /kb/write — simplified flat-fact → KbDelta conversion tests.
 *
 * `buildRawDeltaFromFacts` is the only NEW transform on the deterministic write
 * path: it groups flat facts into entities by (entity_type, entity_name) and
 * assigns synthetic local refs. These cases lock the contract that the built
 * object survives `parseKbDelta` (schema + vocab coercion) and stays faithful:
 * entity grouping, out-of-vocabulary type coercion, attribute snake_case
 * coercion, and deterministic rejection of unwritable input.
 */

import { describe, it, expect } from "vitest";
import { buildRawDeltaFromFacts } from "../kb-write-delta.js";
import { parseKbDelta } from "../../core/kb/extraction-schema.js";
import type { KbWriteFact } from "../types.js";

describe("buildRawDeltaFromFacts — entity grouping", () => {
  it("merges facts that share (entity_type, entity_name) into ONE entity", () => {
    const facts: KbWriteFact[] = [
      { entity_type: "project", entity_name: "immigrate-be", attribute: "base_branch", value: "cloud-ready" },
      { entity_type: "project", entity_name: "immigrate-be", attribute: "language", value: "javascript" },
      { entity_type: "concept", entity_name: "node_modules-junction", attribute: "supports_pnpm", value: "true" },
    ];
    const raw = buildRawDeltaFromFacts(facts) as {
      entities: Array<{ ref: string; type: string; name: string }>;
      facts: Array<{ entity_ref: string; attribute: string; value: string }>;
    };

    // Two distinct entities (immigrate-be shared across its two facts).
    expect(raw.entities).toHaveLength(2);
    const beRef = raw.entities.find((e) => e.name === "immigrate-be")?.ref;
    expect(beRef).toBeDefined();
    // Both immigrate-be facts point at the same ref.
    const beFacts = raw.facts.filter((f) => f.entity_ref === beRef);
    expect(beFacts).toHaveLength(2);

    // Round-trips through the real schema.
    const parsed = parseKbDelta(raw);
    expect(parsed.ok).toBe(true);
  });
});

describe("buildRawDeltaFromFacts — vocabulary coercion", () => {
  it("passes out-of-vocabulary entity_type (coerced to concept) and non-snake attribute", () => {
    const facts: KbWriteFact[] = [
      // "error-class" is NOT in KB_ENTITY_TYPES → normalizeRawKbDelta coerces → "concept".
      // "Base Branch" is not snake_case → coerceAttribute → "base_branch".
      { entity_type: "error-class", entity_name: "maker-spawn-enoent", attribute: "Base Branch", value: "spawn claude with shell:true + stdin" },
    ];
    const raw = buildRawDeltaFromFacts(facts);
    const parsed = parseKbDelta(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.delta.entities[0].type).toBe("concept");
    expect(parsed.delta.facts[0].attribute).toBe("base_branch");
    expect(parsed.delta.entities[0].name).toBe("maker-spawn-enoent");
  });
});

describe("buildRawDeltaFromFacts — deterministic rejection", () => {
  it("rejects a fact with an empty entity_name (schema requires name.min(1))", () => {
    const raw = buildRawDeltaFromFacts([
      { entity_type: "concept", entity_name: "   ", attribute: "lesson", value: "x" },
    ]);
    const parsed = parseKbDelta(raw);
    expect(parsed.ok).toBe(false);
  });

  it("rejects a fact with an empty value (schema requires value.min(1))", () => {
    const raw = buildRawDeltaFromFacts([
      { entity_type: "concept", entity_name: "argus", attribute: "lesson", value: "" },
    ]);
    const parsed = parseKbDelta(raw);
    expect(parsed.ok).toBe(false);
  });

  it("produces an empty (no-op) delta for an empty facts array", () => {
    const raw = buildRawDeltaFromFacts([]) as { entities: unknown[]; facts: unknown[] };
    expect(raw.entities).toHaveLength(0);
    expect(raw.facts).toHaveLength(0);
    // parseKbDelta accepts empty as ok:true; the route rejects it separately.
    const parsed = parseKbDelta(raw);
    expect(parsed.ok).toBe(true);
  });
});
