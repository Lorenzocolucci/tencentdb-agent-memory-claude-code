/**
 * `openclaw memory-tdai reindex` command definition.
 *
 * Re-embeds ALL existing L0 + L1 texts through the new chunking pipeline and
 * rewrites the vec0 tables, using the store's `reindexAll()` machinery.
 *
 * Why this exists: long inputs used to be silently truncated before embedding.
 * After upgrading to the chunked embedding schema, existing vectors only cover
 * the truncated head of each record.  Running `reindex` rebuilds every vector
 * from the preserved metadata text (`l1_records.content` /
 * `l0_conversations.message_text`), splitting long texts into overlapping
 * chunks so the full text becomes searchable again.
 *
 * Idempotency: `reindexAll()` does delete-all-chunks-then-insert-N per record,
 * so re-running the command yields the same result.
 *
 * Registration mirrors the `seed` command: cli/index.ts → registerMemoryTdaiCli()
 * → registerReindexCommand().
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Command } from "commander";
import type { SeedCliContext } from "../index.ts";
import { parseConfig } from "../../config.js";
import { createStoreBundle } from "../../core/store/factory.js";
import { loadGatewayConfig } from "../../gateway/config.js";

const TAG = "[memory-tdai] [reindex-cmd]";

/** Best-effort TCP probe timeout for the live-gateway guard. */
const GATEWAY_PROBE_TIMEOUT_MS = 300;

interface ReindexCommandOptions {
  /** Directory containing the store (vectors.db). Required — never guessed. */
  dataDir: string;
  /** Path to a config override file (JSON, deep-merged on top of plugin config). */
  configFile?: string;
  /** Override the live-gateway safety guard and reindex anyway. */
  force: boolean;
}

/**
 * Register the `reindex` subcommand under the memory-tdai CLI namespace.
 */
export function registerReindexCommand(parent: Command, ctx: SeedCliContext): void {
  parent
    .command('reindex')
    .description('Re-embed all existing L0 + L1 texts with chunking and rebuild the vector index (idempotent)')
    .requiredOption('--data-dir <dir>', 'Plugin data directory that contains vectors.db')
    .option('--config <file>', 'Path to memory-tdai config override file (JSON, deep-merged on top of current plugin config)')
    .option('--force', 'Reindex even if the gateway appears to be running on the same DB (UNSAFE — can lose vectors / crash the gateway)', false)
    .addHelpText('after', `
Examples:
  openclaw memory-tdai reindex --data-dir ~/.openclaw/memory-tdai
  openclaw memory-tdai reindex --data-dir ./seed-output --config ./reindex-config.json

Notes:
  - Re-reads text from l1_records.content / l0_conversations.message_text.
  - Long texts are split into overlapping chunks (embedding.chunkSize/chunkOverlap).
  - Idempotent: re-running produces the same vectors.
  - Refuses to run if the gateway is detected on 127.0.0.1:<port> (default 8420);
    stop it first, or pass --force to override.
`)
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts: ReindexCommandOptions = {
        dataDir: rawOpts.dataDir as string,
        configFile: rawOpts.config as string | undefined,
        force: rawOpts.force === true,
      };
      await runReindexCommand(opts, ctx);
    });
}

// ============================
// Command handler
// ============================

async function runReindexCommand(opts: ReindexCommandOptions, ctx: SeedCliContext): Promise<void> {
  const { logger } = ctx;

  const dataDir = path.resolve(opts.dataDir);
  logger.info(`${TAG} Starting reindex command...`);
  logger.info(`${TAG}   dataDir: ${dataDir}`);
  logger.info(`${TAG}   config:  ${opts.configFile ?? '(default)'}`);

  if (!fs.existsSync(dataDir)) {
    console.error(`\n❌ Data directory not found: ${dataDir}\n`);
    process.exit(1);
  }
  const dbPath = path.join(dataDir, 'vectors.db');
  if (!fs.existsSync(dbPath)) {
    console.error(
      `\n❌ No vectors.db found in data directory: ${dbPath}\n` +
      '   Point --data-dir at the directory that holds the SQLite store.\n',
    );
    process.exit(1);
  }

  // ── Live-gateway safety guard ──
  // reindex opens its own connection and init() can DROP + recreate the vec0
  // tables. If the live gateway is up on the same vectors.db, its cached
  // prepared statements point at the old table — concurrent writes are lost and
  // the gateway can crash mid-conversation. Best-effort TCP probe the gateway
  // port; if it answers, refuse unless --force is passed. Probe failure (port
  // closed / error) is treated as "gateway down" → proceed normally.
  const gatewayPort = resolveGatewayPort(logger);
  const gatewayRunning = await probeGatewayRunning(gatewayPort);
  if (gatewayRunning && !opts.force) {
    console.error(
      `\n❌ Gateway appears to be running on 127.0.0.1:${gatewayPort}. ` +
      `Stop it first (memory-tencentdb-ctl stop), then re-run reindex. ` +
      `Re-running while the gateway is live can lose vectors and crash it. ` +
      `Use --force to override.\n`,
    );
    process.exit(1);
  }
  if (gatewayRunning && opts.force) {
    logger.warn(
      `${TAG} Gateway detected on 127.0.0.1:${gatewayPort} but --force was passed — ` +
      `proceeding anyway. This can lose vectors and crash the live gateway.`,
    );
  }

  // Merge optional config override on top of the plugin config, then parse.
  const mergedPluginConfig = loadAndMergePluginConfig(
    ctx.pluginConfig as Record<string, unknown> | undefined,
    opts.configFile,
    logger,
  );
  const cfg = parseConfig(mergedPluginConfig);

  // The reindex path only makes sense for a local sqlite store with a real
  // remote embedding provider — server-side (TCVDB) backends embed on upsert.
  if (cfg.storeBackend !== 'sqlite') {
    console.error(
      `\n❌ reindex is only supported for the sqlite backend (got: ${cfg.storeBackend}).\n` +
      '   Server-side embedding backends rebuild vectors on upsert.\n',
    );
    process.exit(1);
  }
  if (cfg.embedding.provider === 'none' || cfg.embedding.provider === 'local' || !cfg.embedding.apiKey) {
    console.error(
      '\n❌ reindex requires a configured remote embedding provider with an API key.\n' +
      `   provider="${cfg.embedding.provider}", apiKey ${cfg.embedding.apiKey ? 'set' : 'MISSING'}.\n`,
    );
    process.exit(1);
  }

  // Build the store + embedding service exactly like the live runtime does.
  const bundle = createStoreBundle(cfg, { dataDir, logger });
  const vectorStore = bundle.store;
  const embeddingService = bundle.embedding;

  if (!embeddingService || typeof embeddingService.embedChunks !== 'function') {
    console.error('\n❌ Embedding service unavailable — cannot reindex.\n');
    process.exit(1);
  }

  const providerInfo =
    typeof embeddingService.getProviderInfo === 'function'
      ? embeddingService.getProviderInfo()
      : undefined;

  // init() may itself migrate the legacy vec schema (drop + recreate empty).
  const initResult = await vectorStore.init(providerInfo);
  if (vectorStore.isDegraded()) {
    console.error('\n❌ Store is in degraded mode (sqlite-vec failed to load?). Aborting reindex.\n');
    process.exit(1);
  }
  if (initResult.needsReindex) {
    logger.info(`${TAG} init reported needsReindex (${initResult.reason ?? 'no reason'}) — proceeding.`);
  }

  console.log(`\n🔁 Reindexing vectors in: ${dbPath}`);
  console.log('   (long texts are split into overlapping chunks; this re-runs safely)\n');

  let lastLayer: 'L1' | 'L0' | '' = '';
  const { l1Count, l0Count } = await vectorStore.reindexAll(
    // Chunk-returning embed function: one vector per chunk, all linked to the
    // same record id by reindexAll().
    (text: string) => embeddingService.embedChunks(text),
    (done, total, layer) => {
      if (layer !== lastLayer) {
        if (lastLayer !== '') process.stdout.write('\n');
        lastLayer = layer;
      }
      const pct = total > 0 ? ((done / total) * 100).toFixed(0) : '100';
      process.stdout.write(`\r  [${layer}] ${done}/${total} ${pct}%    `);
    },
  );

  // Release resources.
  try {
    vectorStore.close();
  } catch {
    /* best-effort */
  }
  if (typeof embeddingService.close === 'function') {
    try {
      await embeddingService.close();
    } catch {
      /* best-effort */
    }
  }

  console.log('\n');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║             Reindex Summary              ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  L1 records: ${String(l1Count).padStart(12)}              ║`);
  console.log(`║  L0 records: ${String(l0Count).padStart(12)}              ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n📁 Store: ${dbPath}\n`);
}

// ============================
// Gateway guard helpers
// ============================

/**
 * Resolve the port the gateway would bind on, using the exact same resolution
 * as the running daemon (`TDAI_GATEWAY_PORT` env → config-file `server.port` →
 * default 8420). This keeps the guard accurate regardless of how the live
 * gateway was configured. Falls back to the hardcoded default if config
 * loading throws for any reason.
 */
function resolveGatewayPort(logger: { debug?: (msg: string) => void }): number {
  try {
    return loadGatewayConfig().server.port;
  } catch (err) {
    logger.debug?.(
      `${TAG} Could not resolve gateway port from config (${err instanceof Error ? err.message : String(err)}); ` +
      `defaulting to 8420.`,
    );
    return 8420;
  }
}

/**
 * Best-effort TCP probe of the gateway on 127.0.0.1:<port>.
 *
 * Resolves `true` only when a TCP connection succeeds (gateway is up).
 * A connection refusal, timeout, or any socket error resolves `false`
 * ("gateway not running" — these are EXPECTED outcomes, not errors, so they
 * are not thrown). The socket is always destroyed before resolving.
 *
 * Exported for unit testing the guard.
 */
export function probeGatewayRunning(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (running: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(running);
    };

    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(GATEWAY_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// ============================
// Helpers
// ============================

/**
 * Load an optional config override file and deep-merge it on top of the base
 * plugin config.  Mirrors the helper used by the `seed` command.
 */
function loadAndMergePluginConfig(
  base: Record<string, unknown> | undefined,
  configFile: string | undefined,
  logger: { info: (msg: string) => void },
): Record<string, unknown> | undefined {
  if (!configFile) return base;

  const resolved = path.resolve(configFile);
  if (!fs.existsSync(resolved)) {
    console.error(`\n❌ Config override file not found: ${resolved}\n`);
    process.exit(1);
  }

  let override: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    override = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `\n❌ Failed to parse config override file: ${resolved}\n` +
      `   ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  if (typeof override !== 'object' || override === null || Array.isArray(override)) {
    console.error(`\n❌ Config override file must contain a JSON object: ${resolved}\n`);
    process.exit(1);
  }

  logger.info(`${TAG} Config override loaded from: ${resolved}`);
  return deepMerge(base ?? {}, override);
}

/** Two-level deep merge (sufficient for the memory-tdai config shape). */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overVal = override[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = { ...baseVal, ...overVal };
    } else {
      result[key] = overVal;
    }
  }
  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
