/**
 * situation-cue.ts — dalla SITUAZIONE ai semi dello spreading activation.
 *
 * Sinapsys NON cerca per parole: ricorda per situazione. Il recall associativo-first
 * parte dalla situazione in cui ci troviamo (dove eravamo + i match di contesto +
 * i file su cui lavoriamo) e da lì l'attivazione si propaga sul grafo. Questo modulo
 * traduce quella situazione in entity-id-semi PESATI, che il chiamante passa a
 * `associativeExpand` (spread → vicinato → memoria per entità).
 *
 * Puro sui read dello store, immutabile, best-effort: ogni sorgente è in try/catch,
 * quindi una che fallisce NON azzera le altre; se tutto è vuoto → []. Mai throw
 * (regola vincolante: la memoria non rompe MAI la conversazione).
 *
 * Fondato su misura live (Task 0, 2026-07-07): i `session_recap` NON portano entità
 * (0/41) → i semi "dove eravamo" nascono dagli EVENTI recenti (26-27/30 ne portano);
 * ~20 semi raggiungono 39-728 entità a 1 hop → l'associazione rende davvero.
 */
import type { IMemoryStore, KbEvent } from "../store/types.js";
import type { SessionSituation } from "../hooks/session-situation.js";
import { resolveFileOwnerId } from "../hooks/situation-injection.js";

const TAG = "[memory-tdai][situation-cue]";

/** Massimo numero di semi restituiti (i più forti). */
const MAX_SEEDS = 24;
/** Quanti eventi recenti (per ts) leggere per estrarne le entità-seme. */
const RECENT_EVENTS = 30;
/** Quanti fingerprint recenti considerare. */
const FINGERPRINT_LIMIT = 5;

/** Logger minimale (structural typing — accetta qualsiasi logger più ricco). */
interface Logger {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Un seme pesato per lo spreading activation. */
export interface SituationSeed {
  /** Entity id (il seme dell'attivazione). */
  readonly id: string;
  /** Peso in (0,1]: quanto la sorgente descrive "dove siamo ORA". */
  readonly weight: number;
  /** Da quale sorgente-situazione proviene (per log/tuning). */
  readonly source: "recap" | "fingerprint" | "recent-file";
}

export interface SituationCueContext {
  readonly sessionKey: string;
  readonly namespace: string;
  /**
   * Rolling situation (mid-session): file/errori/tool recenti. Vuota all'apertura
   * sessione — lì i semi vengono da eventi recenti + fingerprint (corretto).
   */
  readonly situation?: SessionSituation;
  readonly logger?: Logger;
}

/**
 * Peso base per sorgente (tarabile — vedi §7 dello spec). "recap" (dove eravamo)
 * è il segnale più forte; i file recenti il più debole (contesto, non intento).
 */
const WEIGHT = { recap: 1.0, fingerprint: 0.7, "recent-file": 0.4 } as const;

/**
 * I K eventi più recenti (per ts) sotto il session_key — la "coda" di ciò che
 * stavamo facendo, ATTRAVERSO il confine di sessione. Misurato live: all'apertura
 * la sessione corrente è quasi vuota, quindi filtrare per session_id perderebbe
 * "dove eravamo"; i K-più-recenti-per-ts prendono la coda della sessione precedente.
 */
function recentEventsByTs(events: readonly KbEvent[]): readonly KbEvent[] {
  return [...events]
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, RECENT_EVENTS);
}

/** Aggiunge/aggiorna un seme tenendo il peso MASSIMO per entità (immutabile sul valore). */
function addSeed(
  map: Map<string, SituationSeed>,
  id: string,
  weight: number,
  source: SituationSeed["source"],
): void {
  if (!id) return;
  const cur = map.get(id);
  if (!cur || weight > cur.weight) map.set(id, { id, weight, source });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Raccoglie gli entity-id-semi pesati dalla situazione. Best-effort, mai throw.
 * Ritorna al più MAX_SEEDS semi, ordinati per peso decrescente.
 */
export function buildSituationSeeds(store: IMemoryStore, ctx: SituationCueContext): SituationSeed[] {
  const seeds = new Map<string, SituationSeed>();

  // (1) "Dove eravamo" + lavoro recente: entità dei K eventi più recenti sotto il session_key.
  try {
    if (typeof store.listEventsBySession === "function") {
      const recent = recentEventsByTs(store.listEventsBySession(ctx.sessionKey));
      for (const e of recent) {
        for (const eid of e.entities ?? []) addSeed(seeds, eid, WEIGHT.recap, "recap");
      }
    }
  } catch (err) {
    ctx.logger?.warn?.(`${TAG} recap seeds failed (non-fatal): ${msg(err)}`);
  }

  // (2) Context Fingerprint: owner risolti a entità (situazione file/errori/task già "vista").
  try {
    const fps = store.queryContextFingerprints?.(ctx.namespace, FINGERPRINT_LIMIT) ?? [];
    for (const fp of fps) {
      for (const ownerId of fp.matchedOwnerIds ?? []) {
        const ent = store.queryEntityById?.(ownerId);
        if (ent) addSeed(seeds, ent.id, WEIGHT.fingerprint, "fingerprint");
      }
    }
  } catch (err) {
    ctx.logger?.warn?.(`${TAG} fingerprint seeds failed (non-fatal): ${msg(err)}`);
  }

  // (3) File recenti (mid-session): fileKey → entity id.
  try {
    for (const fileKey of ctx.situation?.fileKeys ?? []) {
      const id = resolveFileOwnerId(store, fileKey);
      if (id) addSeed(seeds, id, WEIGHT["recent-file"], "recent-file");
    }
  } catch (err) {
    ctx.logger?.warn?.(`${TAG} recent-file seeds failed (non-fatal): ${msg(err)}`);
  }

  return [...seeds.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_SEEDS);
}
