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
| `claude-code-plugin/lib/session-key.ts:29` (`getProjectName`) | Project = basename of cwd: worktrees (`C:\Argus\.claude\worktrees\agent-…`) and subfolders (`C:\Tutor-Agent\backend`) get their own label, so their memories are hidden from the main repo by hard project scope. Added 04/10. **FIXED 05/10, PR #28.** | ~~med~~ |
| recall project scope (`src/core/kb/selective-recall.ts`, `projectsConflict`) | Scope is by WHERE the conversation happened, not WHAT it is about: 118 events about Sinapsys are labelled Argus / Sofia-AI / RISTRUTTURAZIONE, so "capture inbox" asked here finds nothing. Needs a subject-aware scope design, not a blind relabel. Added 04/10. **FIXED 05/10, PR #29** (learned project identities). | ~~med~~ |
| CI (`.github/workflows/pr-ci.yml`) | No typecheck of core `src/` in CI and no root `tsconfig.json`; an ad-hoc strict `tsc` reports 26 errors, all dated 13/05–06/09/2026. Added 05/10. | med |
| situation memory / context fingerprint (`<situation-memory>` on Read) | When neither side has files the file axis is inactive and error+task alone score 1.0 → unrelated "possibly related" lines (e.g. `00-STATO.md: 15.2 KB` on reading this file). Added 05/10. | med |
| PreToolUse bug groups (`pretool-match.ts`, `bash:<head>`) | Head `powershell -NoProfile` is too generic: a process-listing command got a warning about a past `New-Item -ItemType Junction` failure. Added 05/10. | low |
| tool lessons (`tool-lessons.ts`) | Lesson "user interaction" learned the phrase `the user doesn't want to proceed with this tool use.` — a denial, not an error; it will fire once per session after a denied Bash call. Added 05/10. | low |
| `src/core/kb/__tests__/provenance-injection-unchanged.test.ts` | Flaky on CI (failed once on PR #33, passed on rerun and 4/4 locally): renders recall twice around `new Date()`. Added 05/10. | low |
| Tutor a2a loop | Prompts every 5 minutes from the Tutor agent-to-agent loop are captured as conversation (5 events so far). Added 05/10. | low |
| Grounded Trust | Dormant: last "ask Lorenzo" on 24/09. Added 05/10. | low |
| DeepInfra embedder | Timeouts open the circuit breaker several times a day; recall falls back to FTS meanwhile. Added 05/10. | low |
