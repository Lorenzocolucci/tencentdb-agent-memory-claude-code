/**
 * HTTP client for the TDAI Gateway, with Bearer token authentication and
 * silent-failure semantics suitable for cc hook handlers (any error returns
 * an empty / no-op response rather than throwing). Failures are also
 * appended to an optional log file so the daemon's health can be diagnosed
 * via /memory-status without re-attaching a debugger.
 *
 * RESILIENCE NOTES (Phase 3):
 * - Timeouts are named constants (see below) so they are easy to tune.
 * - The capture/write path (POST /capture) gets a separate, more generous
 *   timeout than recall, so transient gateway slowness during session save
 *   does not silently drop the session.
 * - On 401 (stale token after gateway restart) the client re-reads the token
 *   file once and retries the request automatically.
 * - On any capture failure the caller (hook.ts) emits a loud stderr warning
 *   visible in the Claude Code UI — not just a hidden log file.
 */

import http from "node:http";
import { appendFile, readFile } from "node:fs/promises";
import { URL } from "node:url";

// --- Named timeout constants (Phase 3: HOOK CLIENT TIMEOUT) ---
/** Recall timeout: must not hang the prompt; kept short and non-blocking. */
export const RECALL_TIMEOUT_MS = 4_000;
/** Capture timeout: session save is more important; allow extra time for a
 *  slow gateway write-through before declaring the save lost. */
export const CAPTURE_TIMEOUT_MS = 12_000;
/** Default timeout for all other requests (health, search, sessionEnd). */
export const DEFAULT_TIMEOUT_MS = 5_000;

export interface GatewayClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** If set, every fallthrough error is appended here as one line. */
  logPath?: string;
  /**
   * Path to the token file on disk. When provided, the client reads the CURRENT
   * token from file on every request (Phase 3: TOKEN/AUTH — no cached token at
   * process start). On 401 it re-reads this file once and retries.
   */
  tokenPath?: string;
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
  private logPath?: string;
  /** Path to the token file; when set, token is always read fresh from disk. */
  private tokenPath?: string;

  constructor(config: GatewayClientConfig) {
    this.baseUrl = new URL(config.baseUrl);
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logPath = config.logPath;
    this.tokenPath = config.tokenPath;
  }

  /**
   * Read the current token from disk (Phase 3: TOKEN/AUTH — no cached token).
   * Falls back to the in-memory token if the file cannot be read.
   */
  private async freshToken(): Promise<string> {
    if (!this.tokenPath) return this.token;
    try {
      const t = (await readFile(this.tokenPath, "utf-8")).trim();
      if (t) {
        // Keep in-memory copy in sync so callers that depend on it stay consistent.
        this.token = t;
        return t;
      }
    } catch {
      // file missing / unreadable → use the last known token
    }
    return this.token;
  }

  private async logFailure(method: string, path: string, detail: string): Promise<void> {
    if (!this.logPath) return;
    try {
      await appendFile(
        this.logPath,
        `[${new Date().toISOString()}] gateway-client ${method} ${path}: ${detail}\n`,
      );
    } catch {
      // unable to log — nothing else we can do from a hook handler
    }
  }

  private describeStatus(status: number, body: string): string {
    const trimmed = body.length > 200 ? body.slice(0, 200) + "…" : body;
    return `HTTP ${status} ${trimmed}`;
  }

  async health(): Promise<boolean> {
    try {
      const token = await this.freshToken();
      const { status, body } = await this.rawRequest("GET", "/health", undefined, token);
      if (status === 200) return true;
      await this.logFailure("GET", "/health", this.describeStatus(status, body));
      return false;
    } catch (err) {
      await this.logFailure("GET", "/health", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async recall(query: string, sessionKey: string): Promise<RecallResult> {
    // Recall uses RECALL_TIMEOUT_MS — short, non-blocking (Phase 3: HOOK CLIENT TIMEOUT).
    try {
      const token = await this.freshToken();
      const { status, body } = await this.rawRequest(
        "POST", "/recall", { query, session_key: sessionKey }, token, RECALL_TIMEOUT_MS,
      );
      if (status !== 200) {
        await this.logFailure("POST", "/recall", this.describeStatus(status, body));
        return { context: "" };
      }
      const parsed = JSON.parse(body) as RecallResult;
      return {
        context: parsed.context ?? "",
        strategy: parsed.strategy,
        memory_count: parsed.memory_count,
      };
    } catch (err) {
      await this.logFailure("POST", "/recall", err instanceof Error ? err.message : String(err));
      return { context: "" };
    }
  }

  /**
   * POST /capture — uses CAPTURE_TIMEOUT_MS (generous) so slow gateway writes
   * are not falsely treated as failures (Phase 3: HOOK CLIENT TIMEOUT).
   *
   * Returns null on failure; the caller (handleStop in hook.ts) is responsible
   * for emitting a LOUD user-visible warning in that case (Phase 3: NO SILENT
   * FAILURE).
   */
  async captureTurn(payload: CaptureTurnPayload): Promise<CaptureTurnResult | null> {
    const result = await this.captureTurnOnce(payload);
    if (result !== null) return result;

    // Phase 3: RETRY — wait 2 s, then try once more before giving up.
    await new Promise<void>((r) => setTimeout(r, 2_000));
    return this.captureTurnOnce(payload);
  }

  /** Single attempt at POST /capture; returns null (and logs) on any error. */
  private async captureTurnOnce(payload: CaptureTurnPayload): Promise<CaptureTurnResult | null> {
    try {
      const token = await this.freshToken();
      const { status, body } = await this.rawRequest(
        "POST", "/capture", payload, token, CAPTURE_TIMEOUT_MS,
      );

      // Phase 3: TOKEN/AUTH — on 401 re-read the token file once and retry.
      if (status === 401 && this.tokenPath) {
        // Force re-read by clearing the cached value so freshToken() hits disk.
        this.token = "";
        const freshTok = await this.freshToken();
        const retry = await this.rawRequest(
          "POST", "/capture", payload, freshTok, CAPTURE_TIMEOUT_MS,
        );
        if (retry.status === 200) {
          return JSON.parse(retry.body) as CaptureTurnResult;
        }
        await this.logFailure("POST", "/capture", `401 after token refresh: ${this.describeStatus(retry.status, retry.body)}`);
        return null;
      }

      if (status !== 200) {
        await this.logFailure("POST", "/capture", this.describeStatus(status, body));
        return null;
      }
      return JSON.parse(body) as CaptureTurnResult;
    } catch (err) {
      await this.logFailure("POST", "/capture", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async searchMemories(
    query: string,
    opts?: { limit?: number; type?: string; scene?: string },
  ): Promise<SearchResult> {
    try {
      const token = await this.freshToken();
      const { status, body } = await this.rawRequest("POST", "/search/memories", {
        query,
        limit: opts?.limit,
        type: opts?.type,
        scene: opts?.scene,
      }, token);
      if (status !== 200) {
        await this.logFailure("POST", "/search/memories", this.describeStatus(status, body));
        return { results: "", total: 0 };
      }
      return JSON.parse(body) as SearchResult;
    } catch (err) {
      await this.logFailure("POST", "/search/memories", err instanceof Error ? err.message : String(err));
      return { results: "", total: 0 };
    }
  }

  async searchConversations(
    query: string,
    opts?: { limit?: number; sessionKey?: string },
  ): Promise<SearchResult> {
    try {
      const token = await this.freshToken();
      const { status, body } = await this.rawRequest("POST", "/search/conversations", {
        query,
        limit: opts?.limit,
        session_key: opts?.sessionKey,
      }, token);
      if (status !== 200) {
        await this.logFailure("POST", "/search/conversations", this.describeStatus(status, body));
        return { results: "", total: 0 };
      }
      return JSON.parse(body) as SearchResult;
    } catch (err) {
      await this.logFailure("POST", "/search/conversations", err instanceof Error ? err.message : String(err));
      return { results: "", total: 0 };
    }
  }

  async sessionEnd(sessionKey: string): Promise<void> {
    try {
      const token = await this.freshToken();
      const { status, body } = await this.rawRequest("POST", "/session/end", { session_key: sessionKey }, token);
      if (status !== 200) {
        await this.logFailure("POST", "/session/end", this.describeStatus(status, body));
      }
    } catch (err) {
      await this.logFailure("POST", "/session/end", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Low-level HTTP request. Accepts an explicit token and optional timeout so
   * callers can override per-operation (Phase 3: named timeout constants).
   */
  private rawRequest(
    method: string,
    path: string,
    bodyObj: unknown,
    token: string,
    timeoutMs?: number,
  ): Promise<{ status: number; body: string }>;
  private rawRequest(
    method: string,
    path: string,
    bodyObj?: undefined,
    token?: string,
    timeoutMs?: number,
  ): Promise<{ status: number; body: string }>;
  private rawRequest(
    method: string,
    path: string,
    bodyObj?: unknown,
    token: string = this.token,
    timeoutMs: number = this.timeoutMs,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined;
      const opts: http.RequestOptions = {
        protocol: this.baseUrl.protocol,
        hostname: this.baseUrl.hostname,
        port: this.baseUrl.port,
        method,
        path,
        headers: {
          Authorization: `Bearer ${token}`,
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

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
      });

      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}
