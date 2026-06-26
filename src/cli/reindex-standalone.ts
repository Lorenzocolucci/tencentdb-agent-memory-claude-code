#!/usr/bin/env node
/**
 * Standalone `node` reindex entry — re-embed all L0 + L1 texts with chunking
 * and rebuild the vector index, WITHOUT requiring the `openclaw` host CLI.
 *
 * Why this exists: the `reindex` command is registered under the openclaw CLI
 * namespace (`cli/index.ts` → `registerReindexCommand`). On hosts where
 * `openclaw` is not installed (e.g. Claude Code + a standalone node gateway),
 * `openclaw memory-tdai reindex` is not runnable. This entry exposes the SAME
 * core logic (`runReindexCommand`) behind a plain `node ...` invocation.
 *
 * Config parity (CRITICAL): the embedding provider/model/dimensions/apiKey are
 * resolved through the EXACT same path the live gateway uses at startup —
 * `loadGatewayConfig()` (gateway/config.ts) — and its `memory` block is passed
 * as the plugin config to `runReindexCommand`. This guarantees, by construction,
 * that reindex embeds with the same model + dimensions the gateway wrote with.
 * It also means the same prerequisites apply: the gateway config file
 * (tdai-gateway.yaml/json, resolved from TDAI_GATEWAY_CONFIG → CWD →
 * ~/.memory-tencentdb/memory-tdai) must declare `embedding.provider`, and any
 * `${OPENAI_API_KEY}` placeholder in it must resolve from this process's env.
 * If the key is absent, the existing LOUD apiKey-missing refusal in
 * `runReindexCommand` fires — this entry never silently substitutes a key.
 *
 * The `--data-dir` argument controls where the STORE (`vectors.db`) lives. This
 * is intentionally separate from the gateway-config lookup dir, mirroring the
 * live setup where TDAI_DATA_DIR (store) and ~/.memory-tencentdb/memory-tdai
 * (config file) differ.
 *
 * Safety preserved: the live-gateway TCP probe guard and the apiKey-missing
 * refusal both live inside `runReindexCommand` and still fire here.
 */

import { runReindexCommand } from "./commands/reindex.js";
import type { ReindexCommandOptions } from "./commands/reindex.js";
import type { SeedCliContext } from "./index.js";
import { loadGatewayConfig } from "../gateway/config.js";
import { getEnv } from "../utils/env.js";

const USAGE = `
Usage:
  node dist/src/cli/reindex-standalone.mjs --data-dir <dir> [--config <file>] [--force]

Options:
  --data-dir <dir>   Directory that holds the SQLite store (vectors.db).
                     Defaults to the TDAI_DATA_DIR environment variable when set.
                     Required — never guessed.
  --config <file>    Optional config override file (JSON, deep-merged on top of
                     the gateway memory config).
  --force            Reindex even if the gateway appears to be running on the
                     same DB (UNSAFE — can lose vectors / crash the gateway).

Notes:
  - Embedding config (provider/model/dimensions/apiKey) is resolved exactly like
    the live gateway via loadGatewayConfig(); set the same env (e.g.
    OPENAI_API_KEY) the gateway uses, or reindex will refuse with apiKey MISSING.
  - Idempotent: re-running produces the same vectors.
`;

interface ParsedArgs {
  dataDir?: string;
  configFile?: string;
  force: boolean;
  resume: boolean;
}

/**
 * Minimal argv parser. We deliberately avoid `commander` here: it is only a
 * transitive dependency (via the openclaw host) and is NOT guaranteed to be
 * installed in the standalone environment this entry targets.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { force: false, resume: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--data-dir":
        out.dataDir = argv[++i];
        break;
      case "--config":
        out.configFile = argv[++i];
        break;
      case "--force":
        out.force = true;
        break;
      case "--resume":
        out.resume = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        // Support `--data-dir=<dir>` / `--config=<file>` forms too.
        if (arg.startsWith("--data-dir=")) {
          out.dataDir = arg.slice("--data-dir=".length);
        } else if (arg.startsWith("--config=")) {
          out.configFile = arg.slice("--config=".length);
        } else {
          process.stderr.write(`\n❌ Unknown argument: ${arg}\n${USAGE}`);
          process.exit(1);
        }
    }
  }
  return out;
}

/**
 * Small console-backed logger. Writes diagnostics to stderr (so progress on
 * stdout stays clean) and never logs secrets or memory content — only counts,
 * paths, and provider names already surfaced by the core command.
 */
function createConsoleLogger(): SeedCliContext["logger"] {
  return {
    debug: (msg: string) => process.stderr.write(`${msg}\n`),
    info: (msg: string) => process.stderr.write(`${msg}\n`),
    warn: (msg: string) => process.stderr.write(`${msg}\n`),
    error: (msg: string) => process.stderr.write(`${msg}\n`),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const dataDir = args.dataDir ?? getEnv("TDAI_DATA_DIR");
  if (!dataDir || !dataDir.trim()) {
    process.stderr.write(
      "\n❌ --data-dir is required (or set TDAI_DATA_DIR).\n" +
        "   Point it at the directory that holds vectors.db.\n" +
        USAGE,
    );
    process.exit(1);
  }

  const logger = createConsoleLogger();

  // Resolve embedding/memory config through the SAME path the live gateway uses
  // at startup. We do NOT re-implement config parsing — parity is by construction.
  const gatewayConfig = loadGatewayConfig();
  // The gateway feeds `config.memory` (a parsed MemoryTdaiConfig) to the store;
  // runReindexCommand re-parses its `pluginConfig` via parseConfig(), which
  // round-trips this object back to the identical embedding config.
  const pluginConfig = gatewayConfig.memory as unknown as Record<string, unknown>;

  const ctx: SeedCliContext = {
    // openclaw host config is unused on the reindex path (no host LLM calls);
    // an empty object keeps the type satisfied without inventing a host.
    config: {},
    pluginConfig,
    // stateDir is unused by reindex (it only reads vectors.db under dataDir),
    // but SeedCliContext requires it; use the same store dir for coherence.
    stateDir: dataDir,
    logger,
  };

  const opts: ReindexCommandOptions = {
    dataDir,
    configFile: args.configFile,
    force: args.force,
    resume: args.resume,
  };

  await runReindexCommand(opts, ctx);
}

main().catch((err) => {
  process.stderr.write(`reindex-standalone failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
