/**
 * Gateway entry script — wraps TdaiGateway with parent-process liveness
 * binding for the Claude Code plugin daemon lifecycle.
 *
 * Spawned by lib/daemon.ts with env:
 *   TDAI_GATEWAY_TOKEN  — Bearer token (required by gateway middleware)
 *   TDAI_GATEWAY_PORT   — Port to bind
 *   TDAI_DATA_DIR       — Data root
 *   TDAI_CC_PID         — Parent cc process pid; we self-exit when it dies
 */

import { TdaiGateway } from "../../src/gateway/server.js";

async function main(): Promise<void> {
  const gateway = new TdaiGateway();
  await gateway.start();

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await Promise.race([
        gateway.stop(),
        new Promise<void>((r) => setTimeout(r, 5_000)),
      ]);
    } catch {
      // ignore — best effort
    }
    process.exit(reason === "error" ? 1 : 0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const ccPid = parseInt(process.env.TDAI_CC_PID ?? "0", 10);
  if (Number.isFinite(ccPid) && ccPid > 0) {
    const timer = setInterval(() => {
      try {
        process.kill(ccPid, 0);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ESRCH") {
          clearInterval(timer);
          void shutdown("parent-exit");
        }
      }
    }, 60_000);
    timer.unref();
  }
}

main().catch((err) => {
  process.stderr.write(`gateway-entry failed: ${String(err)}\n`);
  process.exit(1);
});
