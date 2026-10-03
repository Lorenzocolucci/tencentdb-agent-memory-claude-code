# Trovati, non toccati

> Things noticed during the 03/10/2026 repair (PR #15–#24) that were out of scope.
> Line numbers are as of `main` f1e9784. Severity: low / med / high.

| Where | What | Severity |
|---|---|---|
| vercel-mcp command lines (Claude Code MCP config) | `VERCEL_API_KEY` passed in plaintext on the command line, visible in process lists. Lorenzo must rotate it and move it to an env file. | high |
| `src/core/kb/bug-clusters.ts:142` | Embedding dims default to 1536; the live embedder is Qwen3-4B at 1024. | med |
| `src/core/store/sqlite.ts` ~4654 (`upsertKbFts`) | `DELETE FROM kb_fts WHERE owner_id = ?` is a full scan of the FTS table on every upsert. | med |
| live DB, `events.project` | Many Sinapsys events are labelled `Sofia-AI` or `''`; hard project scope then hides them. Caps achievable recall (~50% on the ledger ground truth). | med |
| `src/core/kb/auto-recall.ts:1361` | Type error reported by `tsc` (does not break the tsdown build). | med |
| worker process | RSS ~1 GB on a 16 GB machine that often has ~1 GB free. | med |
| banner / stable block | Re-sent after every gateway restart: the "already shown" tracker lives in memory only. | low |
| `src/core/store/sqlite.ts` ~1071 (`stmtL1FtsDelete`) | Same full-scan delete pattern as `upsertKbFts`. | low |
| `stmtKbVecReadOwner` | Full scan on the compact `kb_vec` table (no partition key). | low |
| gateway lock `isPidAlive` | PID reuse can make a dead gateway look alive. | low |
| tests using ports 18421 / 18431 | Fixed ports: parallel runs can collide. | low |
| `src/core/kb/auto-recall.ts:904` | Leftover Chinese regex `活动时间`. | low |
| `package.json` files | Package ships both `src/` and `dist/`; this is why the size ratchet had to go 1200 → 1260 KB. | low |
| distinctiveness real-vectors integration test | Opens the live DB read-write and times out when the gateway holds it. | low |
