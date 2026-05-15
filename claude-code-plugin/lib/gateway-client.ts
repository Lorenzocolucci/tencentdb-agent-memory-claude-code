/**
 * HTTP client for the TDAI Gateway, with Bearer token authentication and
 * silent-failure semantics suitable for cc hook handlers (any error returns
 * an empty / no-op response rather than throwing).
 */

import http from "node:http";
import { URL } from "node:url";

export interface GatewayClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export interface RecallResult {
  context: string;
  strategy?: string;
  memory_count?: number;
}

export interface CaptureTurnPayload {
  user_content: string;
  assistant_content: string;
  session_key: string;
  session_id?: string;
  messages?: Array<{ role: string; content: string }>;
}

export interface CaptureTurnResult {
  l0_recorded: number;
  scheduler_notified: boolean;
}

export interface SearchResult {
  results: string;
  total: number;
  strategy?: string;
}

export class GatewayClient {
  private baseUrl: URL;
  private token: string;
  private timeoutMs: number;

  constructor(config: GatewayClientConfig) {
    this.baseUrl = new URL(config.baseUrl);
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 5_000;
  }

  async health(): Promise<boolean> {
    try {
      const { status } = await this.request("GET", "/health");
      return status === 200;
    } catch {
      return false;
    }
  }

  async recall(query: string, sessionKey: string): Promise<RecallResult> {
    try {
      const { status, body } = await this.request("POST", "/recall", {
        query,
        session_key: sessionKey,
      });
      if (status !== 200) return { context: "" };
      const parsed = JSON.parse(body) as RecallResult;
      return {
        context: parsed.context ?? "",
        strategy: parsed.strategy,
        memory_count: parsed.memory_count,
      };
    } catch {
      return { context: "" };
    }
  }

  async captureTurn(payload: CaptureTurnPayload): Promise<CaptureTurnResult | null> {
    try {
      const { status, body } = await this.request("POST", "/capture", payload);
      if (status !== 200) return null;
      return JSON.parse(body) as CaptureTurnResult;
    } catch {
      return null;
    }
  }

  async searchMemories(
    query: string,
    opts?: { limit?: number; type?: string; scene?: string },
  ): Promise<SearchResult> {
    try {
      const { status, body } = await this.request("POST", "/search/memories", {
        query,
        limit: opts?.limit,
        type: opts?.type,
        scene: opts?.scene,
      });
      if (status !== 200) return { results: "", total: 0 };
      return JSON.parse(body) as SearchResult;
    } catch {
      return { results: "", total: 0 };
    }
  }

  async searchConversations(
    query: string,
    opts?: { limit?: number; sessionKey?: string },
  ): Promise<SearchResult> {
    try {
      const { status, body } = await this.request("POST", "/search/conversations", {
        query,
        limit: opts?.limit,
        session_key: opts?.sessionKey,
      });
      if (status !== 200) return { results: "", total: 0 };
      return JSON.parse(body) as SearchResult;
    } catch {
      return { results: "", total: 0 };
    }
  }

  async sessionEnd(sessionKey: string): Promise<void> {
    try {
      await this.request("POST", "/session/end", { session_key: sessionKey });
    } catch {
      // silent
    }
  }

  private request(
    method: string,
    path: string,
    bodyObj?: unknown,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const bodyStr = bodyObj ? JSON.stringify(bodyObj) : undefined;
      const opts: http.RequestOptions = {
        protocol: this.baseUrl.protocol,
        hostname: this.baseUrl.hostname,
        port: this.baseUrl.port,
        method,
        path,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(bodyStr
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bodyStr).toString(),
              }
            : {}),
        },
      };

      const req = http.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`Timeout after ${this.timeoutMs}ms`));
      });

      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}
