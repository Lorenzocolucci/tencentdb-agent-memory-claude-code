/**
 * Slice A2b — behavioral-law-capture.
 *
 * Pins: a detected law is persisted as a rule_<slug> fact on the user entity;
 * status notes are NOT; the slug is stable (restating supersedes, not duplicates);
 * store errors are swallowed; long rules are capped.
 */

import { describe, it, expect } from "vitest";
import {
  captureBehavioralLaw,
  captureLawFromUserTurn,
  DEFAULT_USER_NAME,
  ruleSlug,
  RULE_ATTR_PREFIX,
  MAX_RULE_LEN,
} from "../behavioral-law-capture.js";

interface Upsert { entityId: string; attribute: string; value: string; confidence?: number; now: string }

function fakeStore(sink: Upsert[], opts?: { throwOnce?: boolean }) {
  let threw = false;
  return {
    upsertFact(p: Upsert) {
      if (opts?.throwOnce && !threw) { threw = true; throw new Error("db busy"); }
      sink.push(p);
      return p;
    },
  };
}

const NOW = "2026-07-01T18:00:00.000Z";
const USER = "ent_lorenzo";

describe("captureBehavioralLaw", () => {
  it("persists a detected law as a rule_ fact on the user entity", () => {
    const sink: Upsert[] = [];
    const res = captureBehavioralLaw({
      store: fakeStore(sink),
      userEntityId: USER,
      userText: "d'ora in poi verifica sempre prima di dire fatto",
      now: NOW,
    });
    expect(res.captured).toBe(true);
    expect(res.attribute!.startsWith(RULE_ATTR_PREFIX)).toBe(true);
    expect(sink).toHaveLength(1);
    expect(sink[0].entityId).toBe(USER);
    expect(sink[0].value).toContain("verifica sempre");
    expect(sink[0].confidence).toBeGreaterThan(0);
  });

  it("does NOT capture a status note (no directive)", () => {
    const sink: Upsert[] = [];
    const res = captureBehavioralLaw({
      store: fakeStore(sink),
      userEntityId: USER,
      userText: "Non ho toccato claude-code-plugin, sospetto fallimenti pre-esistenti.",
      now: NOW,
    });
    expect(res.captured).toBe(false);
    expect(sink).toHaveLength(0);
  });

  it("uses a STABLE slug: restating the same law hits the same attribute (supersede, not duplicate)", () => {
    const sink: Upsert[] = [];
    const store = fakeStore(sink);
    const a = captureBehavioralLaw({ store, userEntityId: USER, userText: "non compiacere mai", now: NOW });
    const b = captureBehavioralLaw({ store, userEntityId: USER, userText: "non compiacere mai", now: NOW });
    expect(a.attribute).toBe(b.attribute);
    // Same attribute upserted twice → the store's supersession collapses to one HEAD.
    expect(sink[0].attribute).toBe(sink[1].attribute);
  });

  it("respects an explicit strength floor", () => {
    const sink: Upsert[] = [];
    const res = captureBehavioralLaw({
      store: fakeStore(sink),
      userEntityId: USER,
      userText: "ricordati di quella cosa",
      now: NOW,
      minStrength: 0.9, // higher than any single marker → nothing captured
    });
    expect(res.captured).toBe(false);
    expect(sink).toHaveLength(0);
  });

  it("swallows a store error (never breaks capture)", () => {
    const sink: Upsert[] = [];
    expect(() =>
      captureBehavioralLaw({
        store: fakeStore(sink, { throwOnce: true }),
        userEntityId: USER,
        userText: "non pushare mai su main",
        now: NOW,
      }),
    ).not.toThrow();
  });

  it("caps a very long rule value", () => {
    const sink: Upsert[] = [];
    const long = "d'ora in poi " + "verifica sempre tutto ".repeat(40);
    captureBehavioralLaw({ store: fakeStore(sink), userEntityId: USER, userText: long, now: NOW });
    expect(sink[0].value.length).toBeLessThanOrEqual(MAX_RULE_LEN);
  });

  it("no-ops without a store or user entity", () => {
    expect(captureBehavioralLaw({ store: {}, userEntityId: USER, userText: "non compiacere mai", now: NOW }).captured).toBe(false);
    const sink: Upsert[] = [];
    expect(captureBehavioralLaw({ store: fakeStore(sink), userEntityId: "", userText: "non compiacere mai", now: NOW }).captured).toBe(false);
  });
});

describe("captureLawFromUserTurn (turn hook)", () => {
  function hookStore(sink: Upsert[], created: string[]) {
    return {
      resolveOrCreateEntity(p: { name: string }) { created.push(p.name); return { id: "ent_lorenzo" }; },
      upsertFact(p: Upsert) { sink.push(p); return p; },
    };
  }

  it("resolves the 'Lorenzo' person entity and writes the law", () => {
    const sink: Upsert[] = []; const created: string[] = [];
    const res = captureLawFromUserTurn({
      store: hookStore(sink, created),
      userText: "non compiacere mai",
      now: NOW,
    });
    expect(res.captured).toBe(true);
    expect(created).toEqual([DEFAULT_USER_NAME]);
    expect(sink[0].entityId).toBe("ent_lorenzo");
  });

  it("does NOT touch the store on a non-law turn (no entity created)", () => {
    const sink: Upsert[] = []; const created: string[] = [];
    const res = captureLawFromUserTurn({
      store: hookStore(sink, created),
      userText: "Working tree pulito — tutto committato.",
      now: NOW,
    });
    expect(res.captured).toBe(false);
    expect(created).toHaveLength(0); // never resolved the entity
    expect(sink).toHaveLength(0);
  });

  it("no-ops (never throws) when the store lacks resolveOrCreateEntity", () => {
    expect(() =>
      captureLawFromUserTurn({ store: { upsertFact() { return {}; } } as never, userText: "non compiacere mai", now: NOW }),
    ).not.toThrow();
  });
});

describe("ruleSlug", () => {
  it("is deterministic and filesystem/attribute safe", () => {
    expect(ruleSlug("Non compiacere mai!")).toBe(ruleSlug("non compiacere mai"));
    expect(ruleSlug("aspetta la mia risposta")).toMatch(/^[a-z0-9_]+$/);
  });
  it("never returns empty", () => {
    expect(ruleSlug("!!!").length).toBeGreaterThan(0);
    expect(ruleSlug("")).toBe("law");
  });
});
