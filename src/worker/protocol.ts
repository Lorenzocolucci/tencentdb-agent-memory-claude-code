/**
 * Gateway <-> worker IPC protocol (child_process.fork channel, JSON messages).
 *
 * Requests flow gateway -> worker and carry an id; the worker answers each with
 * one `res`. Events (`ready`, heartbeat, kb-owner changes, nav snapshot published)
 * flow worker -> gateway and are fire-and-forget.
 *
 * Payloads are validated with zod on the receiving side: the channel is a process
 * boundary, so the worker never trusts a message shape it did not parse.
 */
import { z } from "zod";

export const WORKER_OPS = [
  "ping",
  "capture-kick",
  "build-cornerstone",
  "distill",
  "session-end",
  "digest",
  "kb-write",
  "resolve-gated",
  "seed",
] as const;
export type WorkerOp = (typeof WORKER_OPS)[number];

/** Per-op payload schemas (ops absent from the map take no payload). */
export const PAYLOAD_SCHEMAS = {
  "build-cornerstone": z.object({ key: z.string().min(1) }),
  "session-end": z.object({ sessionKey: z.string().min(1) }),
  digest: z.object({ sessionKey: z.string().min(1) }),
  "kb-write": z.object({
    delta: z.unknown(),
    opts: z.object({
      namespace: z.string().optional(),
      project: z.string().optional(),
      sessionKey: z.string().optional(),
      sessionId: z.string().optional(),
    }),
  }),
  "resolve-gated": z.object({
    ownerId: z.string().min(1),
    ownerKind: z.enum(["fact", "event"]),
    decision: z.enum(["confirm", "reject"]),
  }),
  seed: z.object({ body: z.unknown() }),
} as const;

/** Default per-op timeout (ms) the supervisor waits for the answer. */
export const OP_TIMEOUT_MS: Record<WorkerOp, number> = {
  ping: 10_000,
  "capture-kick": 5_000,
  "build-cornerstone": 10 * 60_000,
  distill: 10_000,
  "session-end": 30 * 60_000,
  digest: 60 * 60_000,
  "kb-write": 5 * 60_000,
  "resolve-gated": 30_000,
  seed: 60 * 60_000,
};

export interface WorkerRequest {
  readonly t: "req";
  readonly id: number;
  readonly op: WorkerOp;
  readonly payload?: unknown;
}

export interface WorkerShutdown {
  readonly t: "shutdown";
}

export type GatewayToWorker = WorkerRequest | WorkerShutdown;

export type WorkerResponse =
  | { readonly t: "res"; readonly id: number; readonly ok: true; readonly result?: unknown }
  | {
      readonly t: "res";
      readonly id: number;
      readonly ok: false;
      readonly error: string;
      readonly code?: string;
      readonly details?: unknown;
    };

export interface WorkerHeartbeat {
  readonly t: "hb";
  readonly at: number;
  readonly rss: number;
  readonly heapUsed: number;
  /** Names of the heavy tasks running right now. */
  readonly active: readonly string[];
  /** Worker event-loop lag over the rolling window, ms. */
  readonly lagP99Ms: number;
  readonly lagMaxMs: number;
}

export type WorkerEvent =
  | { readonly t: "ready"; readonly pid: number }
  | WorkerHeartbeat
  /** kb_vec owners the worker just wrote (batched, deduped): the gateway re-syncs its nav index. */
  | { readonly t: "kb-owners"; readonly owners: readonly string[] }
  /** The worker rewrote the nav snapshot file: the gateway reloads its index from it. */
  | { readonly t: "nav-published" };

export type WorkerToGateway = WorkerResponse | WorkerEvent;

const RequestSchema = z.object({
  t: z.literal("req"),
  id: z.number().int(),
  op: z.enum(WORKER_OPS),
  payload: z.unknown().optional(),
});

/** Parse an untrusted message from the gateway; null when it is not a request/shutdown. */
export function parseGatewayMessage(msg: unknown): GatewayToWorker | null {
  if (msg && typeof msg === "object" && (msg as { t?: unknown }).t === "shutdown") return { t: "shutdown" };
  const r = RequestSchema.safeParse(msg);
  return r.success ? (r.data as WorkerRequest) : null;
}

/** True for a message that is a worker answer (has `t:"res"` and a numeric id). */
export function isWorkerResponse(msg: unknown): msg is WorkerResponse {
  return !!msg && typeof msg === "object" && (msg as { t?: unknown }).t === "res" && typeof (msg as { id?: unknown }).id === "number";
}

export function isWorkerEvent(msg: unknown): msg is WorkerEvent {
  if (!msg || typeof msg !== "object") return false;
  const t = (msg as { t?: unknown }).t;
  return t === "ready" || t === "hb" || t === "kb-owners" || t === "nav-published";
}
