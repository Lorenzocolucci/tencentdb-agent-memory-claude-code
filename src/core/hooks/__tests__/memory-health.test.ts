/**
 * Immune system: getMemoryHealth (store) + resolveHealthWarning + banner surfacing.
 * The point: a session whose raw log (L0) grows but whose events lag = SICK, and
 * that must be shown LOUD at session open. NON-circular: DB state / fake store
 * drives the assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { resolveHealthWarning } from "../auto-recall.js";
import { buildSessionBanner } from "../session-banner.js";

const norm = (v: number[]) => new Float32Array(v);

describe("VectorStore.getMemoryHealth", () => {
  let dir: string;
  let store: VectorStore;
  const NOW = Date.parse("2026-07-05T12:00:00Z");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-health-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 4);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
  });
  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const l0 = (id: string, sk: string, iso: string) => ({
    id, sessionKey: sk, sessionId: "s", role: "user" as const,
    messageText: "x", recordedAt: iso, timestamp: Math.floor(Date.parse(iso) / 1000),
  });

  it("flags an ACTIVE session whose events lag far behind its L0", () => {
    store.setSessionProject("sk-stale", "Sofia-AI");
    // L0 fresh (today), but the newest event is 3 days old → stalled extraction.
    store.upsertL0(l0("m1", "sk-stale", "2026-07-05T11:00:00Z"), [norm([1, 0, 0, 0])]);
    store.insertEvent({ ts: "2026-07-02T10:00:00Z", sessionKey: "sk-stale", sessionId: "s", type: "event", text: "old", sourceMessageIds: [] } as never);

    const h = store.getMemoryHealth(NOW);
    expect(h.healthy).toBe(false);
    expect(h.stale[0].project).toBe("Sofia-AI");
    expect(h.stale[0].lagHours).toBeGreaterThan(36);
  });

  it("is HEALTHY when events keep up with L0", () => {
    store.upsertL0(l0("m2", "sk-fresh", "2026-07-05T11:00:00Z"), [norm([0, 1, 0, 0])]);
    store.insertEvent({ ts: "2026-07-05T11:30:00Z", sessionKey: "sk-fresh", sessionId: "s", type: "event", text: "fresh", sourceMessageIds: [] } as never);
    expect(store.getMemoryHealth(NOW).healthy).toBe(true);
  });

  it("does NOT flag a DORMANT session (old L0 — not 'broken', just idle)", () => {
    store.upsertL0(l0("m3", "sk-old", "2026-06-10T10:00:00Z"), [norm([0, 0, 1, 0])]);
    // no events at all, but L0 is weeks old → not actively used → not flagged.
    expect(store.getMemoryHealth(NOW).healthy).toBe(true);
  });
});

describe("resolveHealthWarning + banner surfacing", () => {
  const fake = (h: unknown) => ({ getMemoryHealth: () => h }) as never;

  it("formats a warning for the worst stalled project", () => {
    const w = resolveHealthWarning(fake({ healthy: false, stale: [{ project: "Sofia-AI", lagHours: 72 }, { project: "Tutor-Agent", lagHours: 40 }] }));
    expect(w).toContain("Sofia-AI");
    expect(w).toContain("estrazione ferma");
    expect(w).toContain("+1");
  });

  it("returns undefined when healthy", () => {
    expect(resolveHealthWarning(fake({ healthy: true, stale: [] }))).toBeUndefined();
  });

  it("the banner shows the ⚠️ warning FIRST (loud, not silent)", () => {
    const banner = buildSessionBanner({ projectName: "Sofia-AI", personaLoaded: true, sceneCount: 5, healthWarning: "estrazione ferma: Sofia-AI indietro 3gg" });
    expect(banner).toContain("⚠️");
    // warning appears before "Sul pezzo"
    expect(banner.indexOf("⚠️")).toBeLessThan(banner.indexOf("Sul pezzo"));
  });
});
