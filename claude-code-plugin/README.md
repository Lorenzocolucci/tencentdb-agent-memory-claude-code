# TencentDB Agent Memory — Claude Code plugin (Windows-ready fork)

> Persistent, semantic long-term memory for **Claude Code**: relevant past memories are recalled before every prompt, and your turns are captured and distilled (facts → scenes → persona) after every reply. This is my fork that makes the whole stack actually run on **Windows 11, including ARM64**.

**Maintained fork by [Lorenzo Colucci](https://github.com/Lorenzocolucci).** Built on Tencent's [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) and its Claude Code plugin adapter by 李冠辰 (liguanchen) — see [Credits](#credits--attribution).

---

## What is this? (30 seconds)

- **What:** a Claude Code plugin that gives Claude long-term memory. It recalls relevant history before each prompt and, after each turn, stores the conversation and extracts structured facts, scenes, and a persona profile in the background.
- **Who it's for:** Claude Code users — especially on **Windows 11 / ARM64** — who want memory that survives across sessions and projects.
- **Why this fork:** upstream targets Linux/macOS; on Windows (ARM64 in particular) the gateway wouldn't stay alive, semantic search degraded silently, and `/memory-search` returned empty. I fixed those. *(Other platforms should work too, but Windows 11 ARM64 is what I run and test.)*

## Why this fork exists

I wanted persistent memory for Claude Code, and I work on **Windows 11 ARM64**. The upstream project is excellent, but the moment I tried to run it on my machine I hit a wall:

- The memory **gateway is session-bound**: the plugin spawns it with a watchdog that kills the process ~15 seconds after the spawning session ends. On Windows the spawn also goes through `cmd.exe → npx`, so the tracked PID is a throwaway wrapper and the gateway suicided almost immediately.
- **`sqlite-vec` has no `win32-arm64` build**, so the vector extension that powers semantic search can't load on ARM64 out of the box.
- **Provider API keys set with `setx` weren't reaching the running gateway**, so it silently started with embeddings disabled and every search quietly fell back to keyword matching.
- `/memory-search` and `/memory-status` returned **empty** whenever another plugin was installed, because the data directory was resolved from an environment variable that Claude Code populates with a *different* plugin's path.

So I fixed each of these. This fork is the result: the first setup I know of where TencentDB Agent Memory + Claude Code runs end-to-end on Windows 11 ARM64.

## What this fork adds

Everything below is in this repository (see the commit history for exact diffs):

- **Robust data-directory resolution.** `/memory-search` and `/memory-status` no longer trust the (often wrong) `CLAUDE_PLUGIN_DATA` env var that Claude Code injects into shell commands. The plugin now locates its own data directory from the script's real path and picks the one whose gateway PID is actually alive (most-recent state as fallback) — so the manual skills work even with other plugins installed.
- **A permanent Windows gateway.** `windows/start-gateway.ps1` runs the gateway directly with `node`, **without** the watchdog PID, so it stays up until you stop it or reboot. `windows/install-autostart.ps1` registers a hidden Scheduled Task (`TDAI Memory Gateway`) that starts it at logon — no admin rights needed.
- **Windows-specific plugin fixes:** `spawn` with `shell: true` so `npx.cmd` resolves on win32; correct main-module detection for Windows drive-letter paths; an *externally-managed gateway* guard so the launcher-owned gateway is never killed or re-spawned by a session; and stale-state recovery on session start.
- **Reliable L3 persona generation.** The persona prompt now names the file tools the *active* runner actually exposes (`write_to_file`/`replace_in_file` vs `write`/`edit`), forces the write via tool call, and falls back to persisting the model's text answer if it replies with text instead of a tool call — so weaker tool-callers (Kimi/Moonshot, DeepSeek) reliably produce `persona.md`.
- **A loud warning instead of a silent footgun.** When an embedding provider is configured but the embedding service fails to initialize (typically an unresolved API key), the gateway now logs a clear WARN explaining that search will fall back to keyword-only — instead of degrading silently.
- **Network resilience:** extra retry headroom for transient DNS/network blips during LLM calls.

## Requirements

- **Windows 11** — tested on **ARM64**. (x64 Windows, Linux, and macOS should work, but ARM64 is what I test.)
- **Node.js 22.16+** — the gateway uses the built-in `node:sqlite`, which requires Node 22+.
- **Claude Code**.
- An **OpenAI-compatible LLM API key** for the L1/L2/L3 extraction. I use **Kimi/Moonshot**; **DeepSeek** or any OpenAI-compatible endpoint works just as well.
- An **OpenAI embeddings key** for semantic search. I use **`text-embedding-3-small`** (1536 dims); any OpenAI-compatible embeddings endpoint works.
- **On ARM64:** nothing extra — the `vec0` (sqlite-vec) extension for `win32-arm64` is **bundled** and installed automatically (see [Semantic search on ARM64](#semantic-search-on-arm64)).

## Installation

```powershell
# 1. Clone the fork
git clone https://github.com/Lorenzocolucci/tencentdb-agent-memory-claude-code.git
cd tencentdb-agent-memory-claude-code

# 2. Build the gateway from this fork (it carries my core fixes).
#    The plugin's own dist/ is committed, so the plugin runs without this step,
#    but the gateway (dist/src/gateway/cli.mjs) is produced here.
npm install
npm run build
```

Then install the plugin in Claude Code (from this local clone / your marketplace), and on Windows start the gateway:

```powershell
cd claude-code-plugin\windows

# Configure provider keys (gitignored, never committed)
copy gateway.secrets.env.example gateway.secrets.env
notepad gateway.secrets.env        # set OPENAI_API_KEY=...

# Start the permanent gateway (idempotent: a no-op if already healthy)
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-gateway.ps1

# Optional: auto-start it at every logon
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
```

Full plugin install/config details (Claude Code marketplace, all env vars, data layout, security model, Codex CLI status) live in **[PLUGIN-REFERENCE.md](./PLUGIN-REFERENCE.md)**.

## Configuration

Provider keys live in `claude-code-plugin/windows/gateway.secrets.env` (gitignored) and are injected into the gateway process by `start-gateway.ps1`:

```ini
# Embeddings (semantic search). Any OpenAI-compatible embeddings endpoint.
OPENAI_API_KEY=sk-...

# Extraction LLM for L1/L2/L3. Any OpenAI-compatible endpoint —
# e.g. Kimi/Moonshot or DeepSeek:
# TDAI_LLM_BASE_URL=https://api.moonshot.cn/v1
# TDAI_LLM_API_KEY=sk-...
# TDAI_LLM_MODEL=kimi-k2-...
```

- **Extraction LLM (L1/L2/L3):** I use Kimi/Moonshot; DeepSeek or any OpenAI-compatible API works. Set `TDAI_LLM_BASE_URL`, `TDAI_LLM_API_KEY`, `TDAI_LLM_MODEL`.
- **Embeddings:** I use OpenAI `text-embedding-3-small` (1536 dims) via `OPENAI_API_KEY`. Any OpenAI-compatible embeddings endpoint works.

**Why a secrets file and not `setx`?** On Windows, a key set *after* the gateway (or its Scheduled Task) has started is not inherited by the running process — the gateway would come up with embeddings disabled and search would silently fall back to keyword. The launcher reads the file and injects the keys explicitly. See [windows/README.md](./windows/README.md).

## How it works

Memory is built in four tiers, all extracted in the background so they never block your conversation:

```
L0  raw conversation   ← captured after every turn
L1  facts / atoms      ← extracted by the LLM
L2  scenes             ← clustered episodes
L3  persona            ← a rolling profile of you
```

Before each prompt the plugin recalls the most relevant memories (semantic vector search + keyword) and injects them into Claude's context. Memory is partitioned per project by default (a hash of the working directory). The gateway is a local HTTP service on `127.0.0.1`, protected by a Bearer token.

## Semantic search on ARM64

`sqlite-vec` (the vector extension behind semantic search) ships **no `win32-arm64` prebuilt binary** — upstream publishes only macOS, Linux, and Windows x86_64. So this fork **includes a precompiled `vec0.dll` for Windows ARM64**:

- **Binary:** [`vendor/win32-arm64/vec0.dll`](./vendor/win32-arm64/vec0.dll) — sqlite-vec `v0.1.7-alpha.2`, compiled with `zig` `0.14.1` for the `aarch64-windows` target (SHA-256 `d1e996e5…09f89b`).
- **Wired automatically:** it's declared as a `file:` optional dependency in the root `package.json`, so `npm install` places it exactly where the sqlite-vec loader looks (`node_modules/sqlite-vec-windows-arm64/`). No manual step.
- **Provenance & verification:** [`vendor/win32-arm64/BUILD.md`](./vendor/win32-arm64/BUILD.md) documents the exact source, version, target, full SHA-256, how to verify it (`vec_version()` + a KNN round-trip), and how to rebuild an equivalent binary yourself with zig. It is sqlite-vec (MIT OR Apache-2.0, © Alex Garcia) — see [`vendor/win32-arm64/NOTICE`](./vendor/win32-arm64/NOTICE).

You still need a **remote embedding provider** on ARM64 (set `OPENAI_API_KEY`); the bundled *local* embedding option (`node-llama-cpp`) also has no `win32-arm64` build.

**Prefer to compile your own?** Follow [BUILD.md](./vendor/win32-arm64/BUILD.md) and drop your `vec0.dll` into `node_modules/sqlite-vec-windows-arm64/`.

Confirm embeddings are live with the health check in [windows/README.md](./windows/README.md) (`stores.embeddingService` should be `true`).

## Rebuilding from source

```powershell
npm install
npm run build             # builds the gateway / core (dist/)
npm run build:cc-plugin   # builds the Claude Code plugin (claude-code-plugin/dist/)
```

The plugin's `claude-code-plugin/dist/` is committed so the plugin works the moment you clone it — rebuild only if you change the source.

## Known limitations

- **Early-adopter software.** It works on my machine (Windows 11 ARM64) and I use it daily, but it's young — expect rough edges.
- **Based on an unmerged upstream PR.** This fork builds on the upstream `feat/claude-code-plugin` work (PR #7), which is not yet merged into TencentDB Agent Memory.
- **ARM64 semantic search relies on a bundled, unofficial `vec0.dll`** (sqlite-vec has no official ARM64 build). If you'd rather not trust a precompiled binary, verify or rebuild it via [BUILD.md](./vendor/win32-arm64/BUILD.md).
- **No support guarantee.** Provided **as-is**, with no warranty and no guaranteed support. Issues and PRs are welcome, but please don't expect SLA-style help.
- **Codex CLI support is partial** — see [PLUGIN-REFERENCE.md](./PLUGIN-REFERENCE.md#codex-cli).

## Credits & attribution

This fork stands entirely on the work of others:

- **[TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory)** by Tencent — the memory engine, the L0–L3 pipeline, and the gateway.
- The **Claude Code plugin adapter** by **李冠辰 (liguanchen)** — the upstream `feat/claude-code-plugin` work (PR #7) this fork is based on.

My contribution is the Windows/ARM64 enablement and the fixes listed in [What this fork adds](#what-this-fork-adds). All original copyright and the MIT license are preserved.

## License

MIT — inherited from the upstream project. See [LICENSE](../LICENSE). Original copyright remains with the TencentDB Agent Memory authors.
