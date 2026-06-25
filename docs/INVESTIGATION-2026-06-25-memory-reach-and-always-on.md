# Investigation — Memory reach across projects & the always-on question

**Date:** 2026-06-25
**Branch:** feat/memory-excellence
**Status:** Investigation closed. No code changed. Decisions parked (see end).

This doc captures a verified investigation into three questions Lorenzo raised, so the
findings survive the session. Everything below is verified against real data (logs,
config, conversation history) unless explicitly marked NOT VERIFIED.

---

## Q1 — Does Sinapsys memory reach Lorenzo's other projects? (Sofia-AI, TutorAI, IMMIGRATO…)

**VERIFIED — YES for interactive Claude Code sessions, read + write.**

Evidence:
- The injection is driven by the plugin `tdai-memory@tdai-local`, **enabled globally** in
  `C:\Users\lo\.claude\settings.json:151` (`enabledPlugins`). Its hooks live in
  `C:\Users\lo\.claude\plugins\tdai-mkt\plugin\hooks\hooks.json`:
  - `SessionStart` → prepares memory
  - `UserPromptSubmit` → *"Recalling memories…"* (the injection)
  - `Stop` → writes memory
  A globally-enabled plugin's hooks fire in **every** project folder, not just this repo.
- Recall is already project-aware: `src/core/hooks/auto-recall.ts:149-150` derives
  `projectName` from the **basename of cwd**, and loads per-project principles
  (`loadPrinciples(pluginDataDir, projectName)`, `auto-recall.ts:269`).
- Decisive proof on the WRITE path: `scene_blocks/scene-project-sofia-ai.md` holds 21 real
  Sofia-AI events (PR #99, branch `fix/s54b-surgical-fixes`, circuit breaker, ElevenLabs
  costs, Twilio SIDs) that were **never discussed in this repo** — they were written by
  sessions running *inside* Sofia-AI. The shared KB spans projects.

**Architectural note (worth knowing):** the raw L0 conversation store is a **global,
date-keyed timeline** with no per-record project tag. Conversation records carry only
`sessionKey, sessionId, recordedAt, id, role, content, timestamp` (verified from
`conversations/2026-06-24.jsonl`); `sessionKey` is an opaque hash, not a project name.
Project attribution happens at the **scene/distillation layer**, not at L0. This is the
same mechanism behind the "persona that lies" / mis-attribution findings: a session that
*talks about* project X from another repo can be attributed by content rather than cwd.

---

## Q2 — Does the nightly `sofia-qa` Routine feed Sinapsys?

**VERIFIED — NO. The routine's work is invisible to Sinapsys.**

The routine ("Sofia qa daily") runs from the Claude **desktop app → Routine** section,
folder `C:\Sofia-AI`, daily ~03:30, once/day.

Evidence it does not reach Sinapsys:
- The routine ran **today at 03:34** (per the app's Cronologia).
- Sinapsys conversation records today: entries at 00:54 (our prior session), then a gap
  until the afternoon. **Nothing at 03:3x.**
- `gateway.out.log`: **zero** lines between 03:00–04:00 today.
- Corroboration from the routine's own instructions: **"FASE 0 — MEMORIA"** reads three
  hand-rolled files — `C:/Sofia-AI/nightly-memory/{history,learnings,watchlist}.md`. The
  nightly agent has its **own separate markdown memory**, built precisely because Sinapsys
  doesn't reach it.

### Root cause

**The gateway is not a 24/7 service — it boots with Lorenzo's interactive session.**
- `gateway.out.log` today has activity only in hours **11, 12, 13**, with a fresh
  *"Gateway listening on 8421"* banner → it (re)started ~11:00 today.
- At 03:34 the current gateway instance did not yet exist.
- Deploy model confirms it: started/stopped by hand via
  `C:\Users\lo\tdai-gateway\start-gateway.ps1` / `stop-gateway.ps1`. Not a Windows service.

So: **at night the gateway sleeps → the 03:30 routine has no one to talk to → its learnings
stay siloed in the markdown files.** This applies to *anything* that runs while Lorenzo
isn't actively working, not just the routine.

NOT VERIFIED: whether desktop-app Routines fire the plugin hook pipeline *at all* even when
the gateway IS up. Decisive test available in one click: with the gateway alive, press
**"Esegui ora"** on the routine and watch `gateway.out.log` for traffic. (Deferred — Lorenzo
chose not to run it now.)

---

## The "daemonless" proposal — recalled and re-judged

Proposed 2026-06-22, **never built** (zero occurrences in the codebase; lives only in the
22–23 June conversations).

**What it was:** kill the gateway, keep the whole KB/retrieval/projections, swap only the
*transport* — "daemonless", short processes managed by Claude Code itself:
- Recall: hook opens SQLite+vec **in-process** (~150ms) instead of hook→HTTP:8421 (4s timeout)
- Search: an **MCP stdio** server CC spawns per session — no port
- Extraction (Kimi): **detached fire-and-forget** process — born, extracts, dies

**Why it was parked (23 June, my own words):** the gateway's *fragility* causes were already
fixed (portproxy ghost removed, resilient embedding client, runs invisible, 15h up). So
daemonless became "an optional optimization, not a rescue. Don't do it now."

**Correction logged today:** that walk-back judged the wrong problem. Daemonless was assessed
against *fragility*; the real unmet need was *always-on / multi-agent*. I had even named that
gap myself on 22 June ("daemonless puro vive solo quando Code è aperto… → cloud") and then
buried it under "fragility fixed." Today's Q2 finding is the receipt.

**Key point: daemonless does NOT solve the routine problem.** It makes recall in-process for
*interactive Claude sessions only*. The nightly routine and Sofia-on-Render are **not inside
Claude Code**, so daemonless gives them nothing — in fact it removes even the local server
they could call. Wrong tool for this target.

---

## Why cloud / Supabase pgvector was discarded (exact reasons, recalled)

1. **Privacy (decisive).** Memory contains client PII (immigration consultancy) and the
   *locations of credentials*. pgvector means that data **leaves the machine** for Frankfurt.
   GDPR-serious.
2. **Latency.** Every recall becomes a network round-trip to Frankfurt **on the critical path**.
3. **Lorenzo's explicit choice (2026-06-22, verbatim):** *"NO a supabase. Preferisco avere
   tutto qui nella mia macchina."* Local control over PC-off resilience.

Still valid. Not reopened.

---

## Is "a 24/7 gateway will crash and never reopen" a real risk?

**Grounded, not paranoia — but the historical causes were external and are fixed.**
- The gateway **has wedged before** ("wedged, auto-restart blocked", 2026-06-22);
  `hook.log` shows real failures (*socket hang up*, *session not saved*, *recall Timeout 4000ms*).
- Those causes were external (portproxy ghost, MCP `cmd`/`npx` shims, scheduled tasks) and
  were closed.
- **NOT VERIFIED:** that the gateway survives multi-day **unsupervised**. A 24/7 Node process
  that crashes at 3am with no supervisor **stays dead** until manually restarted.

---

## The insight that resolves the trade-off

Lorenzo confirmed a hard constraint: **on Windows ARM the routine does not run if the PC is
off** (already investigated; OS limitation). Therefore:

- The routine is **already bound to "PC on."**
- A **local gateway can run whenever the PC is on** — the *same* condition as the routine.
- The cloud's only real advantage (surviving PC-off) is **moot for the routine**, since the
  routine can't run PC-off either.
- The only genuinely always-on client would be Sofia-on-Render — which already has its own
  production memory and is **not** a Sinapsys client today.

**Conclusion: the cloud is not required to close the routine gap.** What closes it is a
**supervised local gateway** — auto-starts with the PC, auto-restarts on crash. A supervision
problem, not an architecture-cloud problem. Small.

---

## Decisions (parked — not built this session, by Lorenzo's instruction)

- **D1 — Memory stays LOCAL.** pgvector/cloud remains rejected (privacy + latency + explicit choice).
- **D2 — The always-on fix is a *supervised local gateway*** (auto-start on PC boot + auto-restart
  on crash), NOT cloud, NOT pure daemonless. To be designed/built when chosen, not now.
- **D3 — Daemonless** stays parked: it's an interactive-session optimization, irrelevant to the
  routine/multi-agent need.
- **D4 — Accepted constraint:** nightly autonomous memory is inherently bounded to "PC on"
  (Windows ARM). Sinapsys cannot make the routine PC-independent without cloud, which D1 rejects.
- **Open test (cheap, deferred):** "Esegui ora" on the routine with gateway up → confirm whether
  desktop-app Routines fire plugin hooks at all.
