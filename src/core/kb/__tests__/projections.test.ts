/**
 * Phase 5 — deterministic projection tests (temp DB, NEVER the live vectors.db,
 * NO network, NO LLM).
 *
 * Seeds entities (person "Lorenzo" + a preference + project "Sofia" + a bug + a
 * "secret-code" concept), HEAD facts (including a SECRET VALUE that MUST be
 * EXCLUDED from persona), events, and relations, then asserts:
 *   - projectPersonaBody : contains allow-listed facts, NEVER the secret value.
 *   - projectScenes      : produces scene block(s) + index in the expected
 *                          META-delimited format.
 *   - renderEntityPage   : Current facts / a superseded fact under History /
 *                          Related [[links]] from relations / event Timeline.
 *   - projectAll         : writes persona.md + scene_blocks/* + scene_index.json
 *                          into a temp dataDir (scene navigation appended).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { _resetUlidStateForTest } from "../kb-queries.js";
import {
  projectPersonaBody,
  projectScenes,
  renderEntityPage,
  type ProjectionStore,
} from "../projections.js";
import { projectAll } from "../projections-writer.js";
import { parseSceneBlock } from "../../scene/scene-format.js";
import { readSceneIndex } from "../../scene/scene-index.js";

const DIMS = 4;
const NS = "default";

const SECRET_VALUE = "MANGO-STELLARE-99"; // must NEVER appear in persona.md

describe("KB projections (temp DB)", () => {
  let dir: string;
  let store: VectorStore;
  // Seeded entity ids (filled in beforeEach).
  let lorenzoId: string;
  let sofiaId: string;
  let bugId: string;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-proj-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
    expect(store.isDegraded()).toBe(false);
    expect(store.isKbReady()).toBe(true);

    // ── Entities ──
    const lorenzo = store.resolveOrCreateEntity({ namespace: NS, type: "person", name: "Lorenzo", now: "2026-06-01T00:00:00.000Z" });
    const pref = store.resolveOrCreateEntity({ namespace: NS, type: "preference", name: "Editor preference", now: "2026-06-01T00:00:00.000Z" });
    const sofia = store.resolveOrCreateEntity({ namespace: NS, type: "project", name: "Sofia", now: "2026-06-01T00:00:00.000Z" });
    const bug = store.resolveOrCreateEntity({ namespace: NS, type: "bug", name: "postcall-42703", now: "2026-06-01T00:00:00.000Z" });
    const secret = store.resolveOrCreateEntity({ namespace: NS, type: "concept", name: "secret code", now: "2026-06-01T00:00:00.000Z" });
    lorenzoId = lorenzo.id;
    sofiaId = sofia.id;
    bugId = bug.id;

    // ── Events (append-only) ──
    const evBug = store.insertEvent({
      ts: "2026-06-02T09:00:00.000Z",
      sessionKey: "sess-1",
      namespace: NS,
      type: "bug",
      text: "Bug 42703: postcall column missing in Sofia after migration.",
      entities: [bug.id, sofia.id],
      sourceMessageIds: ["m1"],
    });
    const evFix = store.insertEvent({
      ts: "2026-06-03T10:00:00.000Z",
      sessionKey: "sess-1",
      namespace: NS,
      type: "fix",
      text: "Fixed 42703 by adding the postcall column migration in Sofia.",
      entities: [bug.id, sofia.id],
      sourceMessageIds: ["m2"],
    });

    // ── Facts ──
    // Allow-listed person facts (identity/role, languages, process rule).
    store.upsertFact({ entityId: lorenzo.id, attribute: "role", value: "Non-developer entrepreneur", validFrom: "2026-06-01T00:00:00Z", now: "2026-06-01T00:00:00.000Z" });
    store.upsertFact({ entityId: lorenzo.id, attribute: "language", value: "Italian", validFrom: "2026-06-01T00:00:00Z", now: "2026-06-01T00:00:00.000Z" });
    store.upsertFact({ entityId: lorenzo.id, attribute: "os", value: "Windows 11", validFrom: "2026-06-01T00:00:00Z", now: "2026-06-01T00:00:00.000Z" });
    store.upsertFact({ entityId: lorenzo.id, attribute: "credentials_location", value: "C:/Credentials/credentials.md", validFrom: "2026-06-01T00:00:00Z", now: "2026-06-01T00:00:00.000Z" });
    // NON-allow-listed person fact: a SECRET VALUE that MUST be excluded.
    store.upsertFact({ entityId: lorenzo.id, attribute: "secret_code", value: SECRET_VALUE, validFrom: "2026-06-01T00:00:00Z", now: "2026-06-01T00:00:00.000Z" });
    // Preference entity fact (allow-listed via "preference" attribute).
    store.upsertFact({ entityId: pref.id, attribute: "preference", value: "Prefers TypeScript strict mode", validFrom: "2026-06-01T00:00:00Z", now: "2026-06-01T00:00:00.000Z" });
    // Secret concept entity fact (its value must also never reach persona).
    store.upsertFact({ entityId: secret.id, attribute: "value", value: SECRET_VALUE, validFrom: "2026-06-01T00:00:00Z", now: "2026-06-01T00:00:00.000Z" });

    // Bug fact that gets SUPERSEDED (open → fixed) → History on the entity page.
    store.upsertFact({ entityId: bug.id, attribute: "status", value: "open", validFrom: "2026-06-02T09:00:00Z", sourceEventId: evBug.id, now: "2026-06-02T09:00:00.000Z" });
    store.upsertFact({ entityId: bug.id, attribute: "status", value: "fixed", validFrom: "2026-06-03T10:00:00Z", sourceEventId: evFix.id, now: "2026-06-03T10:00:00.000Z" });

    // ── Relations ──
    // bug --affects--> Sofia project (so the entity page shows a [[Sofia]] link).
    store.upsertRelation({ srcEntityId: bug.id, type: "affects", dstEntityId: sofia.id, now: "2026-06-02T09:00:00.000Z" });
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // projectPersonaBody
  // ──────────────────────────────────────────────────────────────────────────
  describe("projectPersonaBody", () => {
    it("includes allow-listed facts and EXCLUDES the secret value", () => {
      const persona = projectPersonaBody(store as unknown as ProjectionStore, { namespace: NS });

      // Allow-listed facts present.
      expect(persona).toContain("Lorenzo");
      expect(persona).toContain("Non-developer entrepreneur"); // role (identity)
      expect(persona).toContain("Italian");                    // language
      expect(persona).toContain("Windows 11");                 // os (preferences)
      expect(persona).toContain("C:/Credentials/credentials.md"); // credentials LOCATION
      expect(persona).toContain("Prefers TypeScript strict mode"); // preference
      expect(persona).toContain("Sofia");                      // active project

      // SECRET VALUE must NOT leak — neither via the person's secret_code fact
      // nor via the secret-code concept entity (concepts aren't even gathered).
      expect(persona).not.toContain(SECRET_VALUE);
      expect(persona.toLowerCase()).not.toContain("secret_code");
    });

    it("is deterministic (same input → byte-identical output)", () => {
      const a = projectPersonaBody(store as unknown as ProjectionStore, { namespace: NS });
      const b = projectPersonaBody(store as unknown as ProjectionStore, { namespace: NS });
      expect(a).toBe(b);
    });

    it("renders the documented sections", () => {
      const persona = projectPersonaBody(store as unknown as ProjectionStore, { namespace: NS });
      expect(persona).toContain("## Identity & Role");
      expect(persona).toContain("## Languages");
      expect(persona).toContain("## OS, Stack & Tooling Preferences");
      expect(persona).toContain("## Credential Locations");
      expect(persona).toContain("## Active Projects");
    });

    // ── Percorso A (behavioral laws) — rule_* family renders in the process section ──
    it("projects MANY behavioral-law facts (rule_* family) into Process & Working-Style Rules", () => {
      store.upsertFact({ entityId: lorenzoId, attribute: "rule_wait_for_answer", value: "Aspetta la mia risposta prima di proseguire", validFrom: "2026-07-01T00:00:00Z", now: "2026-07-01T00:00:00.000Z" });
      store.upsertFact({ entityId: lorenzoId, attribute: "rule_no_people_pleasing", value: "Non compiacere mai, sfida quando ho torto", validFrom: "2026-07-01T00:00:00Z", now: "2026-07-01T00:00:00.000Z" });

      const persona = projectPersonaBody(store as unknown as ProjectionStore, { namespace: NS });
      expect(persona).toContain("## Process & Working-Style Rules");
      // BOTH laws survive (distinct rule_* attributes do not self-supersede).
      expect(persona).toContain("Aspetta la mia risposta prima di proseguire");
      expect(persona).toContain("Non compiacere mai, sfida quando ho torto");
    });

    it("still drops a behavioral-law fact whose VALUE looks like a secret", () => {
      store.upsertFact({ entityId: lorenzoId, attribute: "rule_leak", value: SECRET_VALUE, validFrom: "2026-07-01T00:00:00Z", now: "2026-07-01T00:00:00.000Z" });
      const persona = projectPersonaBody(store as unknown as ProjectionStore, { namespace: NS });
      expect(persona).not.toContain(SECRET_VALUE);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // projectScenes
  // ──────────────────────────────────────────────────────────────────────────
  describe("projectScenes", () => {
    it("produces scene block(s) with valid META + index", () => {
      const { scenes } = projectScenes(store as unknown as ProjectionStore, { namespace: NS });
      expect(scenes.length).toBeGreaterThan(0);

      for (const scene of scenes) {
        // Filename is a safe basename under scene_blocks/.
        expect(scene.filename).toMatch(/^scene-.+\.md$/);
        expect(scene.filename).not.toContain("/");

        // META round-trips through the SAME parser the index sync uses.
        const block = parseSceneBlock(scene.content, scene.filename);
        expect(block.meta.summary).toBe(scene.index.summary);
        expect(block.meta.heat).toBe(scene.index.heat);
        expect(block.content.length).toBeGreaterThan(0);

        // Index metadata matches the META.
        expect(scene.index.filename).toBe(scene.filename);
        expect(scene.index.created).toBe(block.meta.created);
        expect(scene.index.updated).toBe(block.meta.updated);
      }
    });

    it("groups both bug events under the dominant (bug) entity scene", () => {
      const { scenes } = projectScenes(store as unknown as ProjectionStore, { namespace: NS });
      // Both seeded events list the bug entity first → one bug scene, heat=2.
      const bugScene = scenes.find((s) => s.index.summary.startsWith("postcall-42703"));
      expect(bugScene).toBeDefined();
      expect(bugScene!.index.heat).toBe(2);
      // created = oldest event ts, updated = newest event ts.
      expect(bugScene!.index.created).toBe("2026-06-02T09:00:00.000Z");
      expect(bugScene!.index.updated).toBe("2026-06-03T10:00:00.000Z");
      // Both events appear in the body timeline.
      expect(bugScene!.content).toContain("Bug 42703");
      expect(bugScene!.content).toContain("Fixed 42703");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // renderEntityPage
  // ──────────────────────────────────────────────────────────────────────────
  describe("renderEntityPage", () => {
    it("shows current facts, superseded history, related [[links]], and timeline", () => {
      const page = renderEntityPage(store as unknown as ProjectionStore, bugId, { namespace: NS });

      // Title.
      expect(page).toContain("# postcall-42703 (bug)");

      // Current facts: status=fixed is the HEAD.
      expect(page).toContain("## Current facts");
      expect(page).toMatch(/## Current facts[\s\S]*\*\*status\*\*: fixed/);

      // History: the superseded status=open row is under History (NOT current).
      expect(page).toContain("## History");
      expect(page).toMatch(/## History[\s\S]*status[\s\S]*open/);

      // Related: a [[Sofia]] wiki-link from the affects relation.
      expect(page).toContain("## Related");
      expect(page).toContain("[[Sofia]]");
      expect(page).toContain("affects");

      // Timeline: both events referencing the bug, newest first.
      expect(page).toContain("## Timeline");
      expect(page).toContain("Bug 42703");
      expect(page).toContain("Fixed 42703");
      // Newest-first ordering: the fix line precedes the bug line in the timeline.
      const tl = page.slice(page.indexOf("## Timeline"));
      expect(tl.indexOf("Fixed 42703")).toBeLessThan(tl.indexOf("Bug 42703"));
    });

    it("HEAD value 'fixed' does NOT appear in the History section", () => {
      const page = renderEntityPage(store as unknown as ProjectionStore, bugId, { namespace: NS });
      const history = page.slice(page.indexOf("## History"), page.indexOf("## Related"));
      expect(history).toContain("open");      // the superseded value
      expect(history).not.toContain("fixed"); // the current HEAD must not be here
    });

    it("returns '' for an unknown entity id", () => {
      const page = renderEntityPage(store as unknown as ProjectionStore, "ent_does_not_exist", { namespace: NS });
      expect(page).toBe("");
    });

    it("renders the Sofia project page with its bug relation backlink", () => {
      const page = renderEntityPage(store as unknown as ProjectionStore, sofiaId, { namespace: NS });
      expect(page).toContain("# Sofia (project)");
      // The affects edge points bug→Sofia, so Sofia's page shows the backlink.
      expect(page).toContain("[[postcall-42703]]");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // projectAll (IO runner)
  // ──────────────────────────────────────────────────────────────────────────
  describe("projectAll", () => {
    it("writes persona.md + scene_blocks/* + scene_index.json into the dataDir", async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-proj-out-"));
      try {
        const result = await projectAll(store as unknown as ProjectionStore, {
          dataDir,
          namespace: NS,
          locale: "en",
        });

        // persona.md exists, has the allow-listed content, NOT the secret, and the
        // scene-navigation section appended.
        const persona = fs.readFileSync(result.personaPath, "utf-8");
        expect(persona).toContain("Lorenzo");
        expect(persona).not.toContain(SECRET_VALUE);
        expect(persona).toContain("Scene Navigation"); // generateSceneNavigation header

        // scene_blocks/* written; at least one parses with a META summary.
        const blocksDir = path.join(dataDir, "scene_blocks");
        const files = fs.readdirSync(blocksDir).filter((f) => f.endsWith(".md"));
        expect(files.length).toBe(result.scenesWritten);
        expect(files.length).toBeGreaterThan(0);

        // scene_index.json is readable via the SAME loader the injection uses, and
        // has one entry per produced scene.
        const index = await readSceneIndex(dataDir);
        expect(index.length).toBe(result.scenesWritten);
        const bug = index.find((e) => e.summary.startsWith("postcall-42703"));
        expect(bug).toBeDefined();
        expect(bug!.heat).toBe(2);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("removes stale projector scene files no longer produced", async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-proj-stale-"));
      try {
        const blocksDir = path.join(dataDir, "scene_blocks");
        fs.mkdirSync(blocksDir, { recursive: true });
        // A stale projector file (scene-*.md) AND a hand-authored file.
        fs.writeFileSync(path.join(blocksDir, "scene-old-removed.md"), "stale", "utf-8");
        fs.writeFileSync(path.join(blocksDir, "hand-authored.md"), "keep me", "utf-8");

        await projectAll(store as unknown as ProjectionStore, { dataDir, namespace: NS });

        const remaining = fs.readdirSync(blocksDir);
        // Stale projector file removed; hand-authored file preserved.
        expect(remaining).not.toContain("scene-old-removed.md");
        expect(remaining).toContain("hand-authored.md");
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });
});
