/**
 * Resilience tests for the remote (OpenAI-compatible) embedding client.
 *
 * These cover the operational bug that broke recall after hours of uptime:
 * a pooled keep-alive TLS socket goes stale, the next embed reuses the dead
 * socket and fails, and with the old MAX_RETRIES=0 it was a hard failure.
 *
 * We drive the failure path with injected dispatchers (real undici MockAgents
 * configured with replyWithError, which surfaces a UND_ERR_SOCKET-shaped error
 * exactly like a stale socket), and assert:
 *   (a) the client RETRIES on a FRESH dispatcher (recycle between attempts),
 *   (b) after K consecutive failures the circuit OPENS (getHealth().healthy=false),
 *   (c) on the next success the circuit CLOSES (healthy again),
 *   (d) genuine 4xx client errors do NOT open the breaker (the socket is fine).
 */

import { describe, it, expect } from "vitest";
import { MockAgent } from "undici";
import type { Dispatcher } from "undici";
import { OpenAIEmbeddingService } from "../embedding.js";

const DIMS = 4;

/** A MockAgent whose POST /v1/embeddings always rejects with a socket error. */
function makeFailingAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const err = new Error("other side closed") as Error & { code?: string };
  err.code = "UND_ERR_SOCKET";
  agent
    .get("https://api.test")
    .intercept({ path: "/v1/embeddings", method: "POST" })
    .replyWithError(err)
    .persist();
  return agent;
}

/** A MockAgent that replies 200 with one vector per input (healthy backend). */
function makeOkAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get("https://api.test")
    .intercept({ path: "/v1/embeddings", method: "POST" })
    .reply(200, (opts) => {
      const body = JSON.parse(String(opts.body ?? "{}")) as { input: string[] };
      return {
        data: body.input.map((_t, index) => ({
          index,
          embedding: Array.from({ length: DIMS }, (_v, i) => (i + 1) / 10),
        })),
      };
    })
    .persist();
  return agent;
}

/** Track destroy() calls so we can prove old dispatchers are retired on retry. */
interface TrackedAgent {
  dispatcher: Dispatcher;
  destroyed: boolean;
}

function trackDestroy(agent: MockAgent): TrackedAgent {
  const tracked: TrackedAgent = { dispatcher: agent as unknown as Dispatcher, destroyed: false };
  const origDestroy = agent.destroy.bind(agent);
  // recycleDispatcher() calls .destroy() on the OLD dispatcher.
  (agent as unknown as { destroy: () => Promise<void> }).destroy = async () => {
    tracked.destroyed = true;
    return origDestroy();
  };
  return tracked;
}

function makeService(
  dispatcherFactory: () => Dispatcher,
  overrides: Record<string, unknown> = {},
): OpenAIEmbeddingService {
  return new OpenAIEmbeddingService(
    {
      provider: "openai",
      baseUrl: "https://api.test/v1",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: DIMS,
      timeoutMs: 1_000,
      ...overrides,
    },
    undefined,
    dispatcherFactory,
  );
}

describe("OpenAIEmbeddingService resilience (retry + circuit breaker)", () => {
  it("retries on a FRESH dispatcher (recycles between attempts)", async () => {
    const created: TrackedAgent[] = [];
    const svc = makeService(() => {
      const t = trackDestroy(makeFailingAgent());
      created.push(t);
      return t.dispatcher;
    });

    await expect(svc.embed("hello")).rejects.toThrow();

    // MAX_RETRIES=2 → 3 total attempts. The first dispatcher is created in the
    // constructor; each retry recycles to a brand-new dispatcher. So at least
    // 3 dispatchers were created (1 initial + 2 recycled).
    expect(created.length).toBeGreaterThanOrEqual(3);
    // Every recycled (non-current) dispatcher must be destroyed — proving the
    // retry did NOT reuse the stale socket pool.
    const destroyedCount = created.filter((t) => t.destroyed).length;
    expect(destroyedCount).toBeGreaterThanOrEqual(2);

    for (const t of created) await (t.dispatcher as unknown as MockAgent).close().catch(() => {});
  });

  it("opens the circuit after K consecutive failures (getHealth().healthy false)", async () => {
    const agents: MockAgent[] = [];
    const svc = makeService(() => {
      const a = makeFailingAgent();
      agents.push(a);
      return a as unknown as Dispatcher;
    });

    expect(svc.getHealth().healthy).toBe(true);

    // One embed() makes 3 attempts (all failing) → 3 failures, which meets the
    // threshold of 3. One failing call is enough to open the breaker.
    await expect(svc.embed("a")).rejects.toThrow();

    const health = svc.getHealth();
    expect(health.healthy).toBe(false);
    expect(health.consecutiveFailures).toBeGreaterThanOrEqual(3);

    for (const a of agents) await a.close().catch(() => {});
  });

  it("does NOT open the circuit on a 4xx client error (socket is fine)", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("https://api.test")
      .intercept({ path: "/v1/embeddings", method: "POST" })
      .reply(400, { error: "bad request" })
      .persist();

    const svc = makeService(() => agent as unknown as Dispatcher);
    await expect(svc.embed("a")).rejects.toThrow(/HTTP 400/);
    // A 400 means the connection worked — breaker must stay closed.
    expect(svc.getHealth().healthy).toBe(true);
    expect(svc.getHealth().consecutiveFailures).toBe(0);
    await agent.close();
  });

  it("recovers on the SAME instance after the backend comes back", async () => {
    // Phase "fail": dispatchers reject. Phase "ok": healthy backend. The first
    // embed() opens the breaker; after flipping to "ok", the constructor-built
    // failing dispatcher makes attempt 0 fail, the retry recycles to the ok
    // agent, and the call succeeds — closing the breaker on ONE instance.
    let phase: "fail" | "ok" = "fail";
    const okAgent = makeOkAgent();
    const failAgents: MockAgent[] = [];
    const svc = makeService(() => {
      if (phase === "ok") return okAgent as unknown as Dispatcher;
      const a = makeFailingAgent();
      failAgents.push(a);
      return a as unknown as Dispatcher;
    });

    await expect(svc.embed("a")).rejects.toThrow();
    expect(svc.getHealth().healthy).toBe(false);

    phase = "ok";
    const vec = await svc.embed("hello");
    expect(vec).toHaveLength(DIMS);
    expect(svc.getHealth().healthy).toBe(true);
    expect(svc.getHealth().consecutiveFailures).toBe(0);

    for (const a of failAgents) await a.close().catch(() => {});
    await okAgent.close();
  });
});
