/**
 * IL GUASTO CHE QUESTI TEST NOMINANO
 * ==================================
 * «Un fatto su README.md del progetto A non deve comparire leggendo README.md
 *  del progetto B.»
 *
 * Il 13–14 luglio 2026 una prova di collaudo scrisse in memoria che README.md
 * "contiene la riga <!-- argus canary: pipeline OK -->". Quel fatto finì su
 * un'entità con `canonical_key = "file:readme.md"` e `project = ""`: una chiave
 * GLOBALE, costruita sul solo nome base. Da allora, aprire un qualunque
 * README.md — in Argus, in RISTRUTTURAZIONE, ovunque — faceva iniettare quei
 * fatti di luglio come se fossero istruzioni correnti.
 *
 * L'identità di un file è PROGETTO + PERCORSO, mai il solo nome base.
 * (L'associatività NON è ciò che cola: le lezioni e i principi restano
 * trasversali, passano dal recall, non da qui. Cola l'identità dei file.)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { _resetUlidStateForTest } from "../../kb/kb-queries.js";
import { buildFileInjection, resolveFileOwnerId } from "../situation-injection.js";

const DIMS = 4;
const NOW = "2026-07-13T17:14:43.671Z";

describe("file injection is project-scoped (README canary leak)", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    _resetUlidStateForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-projscope-"));
    store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
    store.init({ provider: "openai", model: "text-embedding-3-small" });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("un fatto su README.md del progetto A NON compare leggendo README.md del progetto B", () => {
    const ent = store.resolveOrCreateEntity!({
      type: "file",
      name: "README.md",
      project: "Sofia-AI",
      now: NOW,
    });
    store.upsertFact!({
      entityId: ent.id,
      attribute: "canary_line",
      value: "<!-- argus canary: pipeline OK -->",
      now: NOW,
    });

    // Stesso nome base, ALTRO progetto → silenzio.
    expect(
      buildFileInjection(store, "C:\\RISTRUTTURAZIONE\\README.md", { project: "RISTRUTTURAZIONE" }),
    ).toBeNull();
    expect(
      buildFileInjection(store, "C:\\Argus\\docs\\README.md", { project: "Argus" }),
    ).toBeNull();

    // …e nello stesso progetto il fatto si vede ancora (non abbiamo spento la memoria).
    const same = buildFileInjection(store, "C:\\Sofia-AI\\README.md", { project: "Sofia-AI" });
    expect(same).not.toBeNull();
    expect(same).toContain("canary_line");
  });

  it("l'entità globale di luglio (project vuoto, chiave sul solo nome base) resta MUTA ovunque", () => {
    // Esattamente la riga viva: ent_5df45b96cfdb8ed5 | file | README.md |
    // canonical_key 'file:readme.md' | project ''.
    const ent = store.resolveOrCreateEntity!({ type: "file", name: "README.md", now: NOW });
    expect(ent.canonical_key).toBe("file:readme.md");
    store.upsertFact!({
      entityId: ent.id,
      attribute: "canary_pipeline_status",
      value: "line added",
      now: NOW,
    });

    for (const [file, project] of [
      ["C:\\Argus\\docs\\README.md", "Argus"],
      ["C:\\RISTRUTTURAZIONE\\README.md", "RISTRUTTURAZIONE"],
      ["C:\\Users\\lo\\tencentdb-agent-memory\\README.md", "tencentdb-agent-memory"],
    ] as const) {
      expect(buildFileInjection(store, file, { project })).toBeNull();
      expect(resolveFileOwnerId(store, file, project)).toBeNull();
    }
  });

  it("il nome base NON attraversa i progetti nemmeno per file di codice omonimi", () => {
    // Misurato sul DB vivo: 'file:types.ts' era condiviso fra
    // tencentdb-agent-memory, Sofia-AI e Argus.
    const ent = store.resolveOrCreateEntity!({
      type: "file",
      name: "src/core/store/types.ts",
      project: "tencentdb-agent-memory",
      now: NOW,
    });
    store.upsertFact!({ entityId: ent.id, attribute: "owner", value: "KB", now: NOW });

    expect(buildFileInjection(store, "C:\\Sofia-AI\\src\\types.ts", { project: "Sofia-AI" })).toBeNull();
  });

  it("nemmeno un ALIAS fa attraversare il confine di progetto a un file", () => {
    // L'entità viva ent_5df45b96cfdb8ed5 porta l'alias "sofia-ai:README.md".
    // Un alias è l'altra porta della stessa stanza: se cattura per nome, la
    // chiave scoped non serve a niente.
    const a = store.resolveOrCreateEntity!({
      type: "file",
      name: "note.md",
      aliases: ["appunti.md"],
      project: "Sofia-AI",
      now: NOW,
    });
    const b = store.resolveOrCreateEntity!({
      type: "file",
      name: "appunti.md",
      project: "Argus",
      now: NOW,
    });
    expect(b.id).not.toBe(a.id);
    expect(b.project).toBe("Argus");
  });

  it("un percorso ASSOLUTO identifica il file da solo: resta visibile senza tag progetto", () => {
    // Le entità con percorso assoluto nominano UN file su questa macchina:
    // non c'è ambiguità da risolvere, quindi non le zittiamo.
    const abs = "C:\\Sofia-AI\\src\\services\\circuit-breaker.ts";
    const ent = store.resolveOrCreateEntity!({ type: "file", name: abs, now: NOW });
    store.upsertFact!({ entityId: ent.id, attribute: "owner", value: "Sofia", now: NOW });

    const out = buildFileInjection(store, "c:/sofia-ai/src/services/circuit-breaker.ts");
    expect(out).not.toBeNull();
    expect(out).toContain("owner");
  });

  it("il nome base dentro LO STESSO progetto continua a fare match (fallback conservato, ma scoped)", () => {
    const ent = store.resolveOrCreateEntity!({
      type: "file",
      name: "whatsapp-sofia.ts",
      project: "Sofia-AI",
      now: NOW,
    });
    store.upsertFact!({ entityId: ent.id, attribute: "channel", value: "WhatsApp", now: NOW });

    const out = buildFileInjection(store, "C:\\Sofia-AI\\src\\services\\whatsapp-sofia.ts", {
      project: "Sofia-AI",
    });
    expect(out).not.toBeNull();
    expect(out).toContain("channel");
  });

  it("un'entità legacy (chiave non scoped) TAGGATA con questo progetto resta visibile", () => {
    // Continuità: le 535 entità file già taggate col progetto non perdono i loro fatti.
    const ent = store.resolveOrCreateEntity!({ type: "file", name: "argus-guardian.mjs", now: NOW });
    expect(ent.canonical_key).toBe("file:argus-guardian.mjs"); // chiave legacy, non scoped
    // Riproduce la riga viva: chiave legacy MA `project` valorizzato.
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE entities SET project = ? WHERE id = ?")
      .run("Sofia-AI", ent.id);
    store.upsertFact!({ entityId: ent.id, attribute: "role", value: "guardian", now: NOW });

    const out = buildFileInjection(store, "C:\\Sofia-AI\\scripts\\argus-guardian.mjs", {
      project: "Sofia-AI",
    });
    expect(out).not.toBeNull();
    expect(out).toContain("guardian");
    // …e resta muta altrove.
    expect(
      buildFileInjection(store, "C:\\Argus\\scripts\\argus-guardian.mjs", { project: "Argus" }),
    ).toBeNull();
  });
});
