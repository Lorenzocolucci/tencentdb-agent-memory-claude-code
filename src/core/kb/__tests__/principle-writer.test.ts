import { describe, it, expect, vi } from "vitest";
import { writePrinciple, PRINCIPLE_TYPE, PRINCIPLE_SALIENCE } from "../principle-writer.js";
import type { PrincipleCluster } from "../principle-clusters.js";
import type { KbEventInput } from "../../store/types.js";

const cluster: PrincipleCluster = {
  domainEntity: "ent_pricing",
  eventIds: ["d1", "d2"],
  texts: ["a", "b"],
  sessionIds: ["chatA", "chatB"],
  sessionKey: "sA",
  sourceMessageIds: ["m1", "m2"],
  project: "sofia",
};
const distilled = { domain: "pricing", principleText: "Prezza a valore.", confidence: 0.8 };

describe("writePrinciple", () => {
  it("inserts a principle atom and stamps protective salience", () => {
    const inserted: KbEventInput[] = [];
    const stamped: Array<{ ownerId: string; ownerKind: string; salience: number }> = [];
    const store = {
      insertEvent: (e: KbEventInput) => { inserted.push(e); return { ...e, id: "prc_1" } as any; },
      stampSalience: (p: any) => { stamped.push(p); },
    } as any;

    const ev = writePrinciple({ store, cluster, distilled, now: "2026-07-01T14:00:00.000Z" });

    expect(ev).not.toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].type).toBe(PRINCIPLE_TYPE);
    expect(inserted[0].text).toBe("Prezza a valore.");
    expect(inserted[0].sessionKey).toBe("sA");
    expect(inserted[0].project).toBe("sofia");
    expect(inserted[0].entities).toEqual(["ent_pricing", "principle-domain:pricing", "evidence:2"]);
    expect(inserted[0].sourceMessageIds).toEqual(["m1", "m2"]);
    expect(stamped).toHaveLength(1);
    expect(stamped[0].ownerKind).toBe("event");
    expect(stamped[0].salience).toBe(PRINCIPLE_SALIENCE);
  });

  it("never throws when the store lacks insertEvent", () => {
    expect(() => writePrinciple({ store: {} as any, cluster, distilled, now: "n" })).not.toThrow();
    expect(writePrinciple({ store: {} as any, cluster, distilled, now: "n" })).toBeNull();
  });

  it("still returns the event when stampSalience is absent (optional capability)", () => {
    const store = { insertEvent: (e: KbEventInput) => ({ ...e, id: "prc_1" } as any) } as any;
    const ev = writePrinciple({ store, cluster, distilled, now: "n" });
    expect(ev).not.toBeNull();
  });
});
