/**
 * Tests for the reindex CLI's live-gateway safety guard (security M1).
 *
 * The guard refuses to run `reindex` while a gateway is listening on the
 * vector-store port, because reindex's init() can DROP + recreate the vec0
 * tables out from under the live gateway's cached prepared statements.
 *
 * We test the underlying TCP probe directly:
 *  - a listening socket on 127.0.0.1:<port> → probe returns true ("running")
 *  - no listener on the port → probe returns false ("down")
 *
 * Ephemeral OS-assigned ports (listen(0)) are used so this never touches the
 * real gateway port.
 */

import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probeGatewayRunning } from "../reindex.js";

describe("reindex gateway guard — probeGatewayRunning", () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("returns true when a gateway is listening on the probed port", async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        if (addr && typeof addr === "object") {
          server = s;
          resolve(addr.port);
        } else {
          reject(new Error("Failed to obtain ephemeral port"));
        }
      });
    });

    await expect(probeGatewayRunning(port)).resolves.toBe(true);
  });

  it("returns false when nothing is listening on the probed port", async () => {
    // Grab an ephemeral port, then immediately release it so the probe target
    // is closed/refused.
    const port = await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        if (addr && typeof addr === "object") {
          const p = addr.port;
          s.close(() => resolve(p));
        } else {
          reject(new Error("Failed to obtain ephemeral port"));
        }
      });
    });

    await expect(probeGatewayRunning(port)).resolves.toBe(false);
  });
});
