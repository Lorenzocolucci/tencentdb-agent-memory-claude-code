/**
 * Real IO: `POST /digest` against the gateway using raw `node:http`, NOT
 * `fetch`/undici. Copied deliberately from `b3-backfill-copy/_digest_all_chat.mjs`
 * (July driver): "Uses raw node:http (NOT fetch) so a long-running /digest
 * response is never aborted by undici's 300s client headersTimeout." A
 * `/digest` call can legitimately run for minutes (the gateway's own
 * `requestTimeout` is 60 min specifically to allow this — `server.ts:61-66`).
 *
 * Response shape confirmed at `src/gateway/server.ts` `handleDigest`
 * (`sendJson(res, 200, { digested: true, processedCount: result.processedCount })`)
 * and `src/core/tdai-core.ts` `digestBacklogSession`.
 */
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import type { DigestAttemptOutcome } from "./digest-driver.js";

export async function readToken(tokenFilePath: string): Promise<string> {
  return (await readFile(tokenFilePath, "utf-8")).trim();
}

export interface PostDigestParams {
  baseUrl: string;
  token: string;
  sessionKey: string;
  /** Hard socket timeout, independent of the caller's stall watchdog. */
  socketTimeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_SOCKET_TIMEOUT_MS = 55 * 60 * 1000; // just under the gateway's 60-min requestTimeout

interface DigestHttpResponse extends DigestAttemptOutcome {
  digested: boolean;
}

export function postDigest(params: PostDigestParams): Promise<DigestHttpResponse> {
  const url = new URL("/digest", params.baseUrl);
  const body = JSON.stringify({ session_key: params.sessionKey });
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new Error("aborted before request started"));
      return;
    }

    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf-8");
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as DigestHttpResponse);
          } catch (err) {
            reject(new Error(`invalid JSON response: ${(err as Error).message}`));
          }
        });
      },
    );

    req.setTimeout(params.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS, () => {
      req.destroy(new Error("socket timeout"));
    });
    req.on("error", reject);

    const onAbort = (): void => {
      req.destroy(new Error("aborted by stall watchdog"));
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });

    req.write(body);
    req.end();
  });
}
