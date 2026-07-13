# Grounded Trust — Phase 1: Provenance & Trust foundation

> Design, 2026-06-29 (Lorenzo & Socio). Status: IMPLEMENTED 2026-06-30 — built TDD
> per the plan (`docs/superpowers/plans/2026-06-29-grounded-trust-phase1-provenance.md`),
> commits b805f60 / e036912 / afb0c27 / 75a497d on `feat/memory-excellence` (NOT pushed).
> All Phase-1 tests green; build green; suite 7 pre-existing failures (daemon/hook,
> Windows). See memory card `sinapsys-grounded-trust-phase1-done`.
> Parent pillar: [the child and the fire](./2026-06-29-grounded-trust-child-and-fire-design.md).
> This is **Phase 1 of 4** (foundation). Phases 2-4 (stakes policy, grounding,
> ask-Lorenzo loop, learning) rest on this and are explicitly OUT of scope here.

## Why this phase exists

The pillar needs a trust spine: before a memory can drive a **consequential**
action it must be "looked in the face" — grounded against its origin and reality,
or confirmed by Lorenzo. None of that is possible until every memory carries a
**provenance + trust** stamp. This phase builds only that stamp and the machinery
to upgrade it. It changes **nothing the user observes day-to-day** — it is the
load-bearing foundation the next phases plug into.

## Two decisions already made with Lorenzo (binding)

1. **Foundation-first.** Build provenance across all memory before the
   grounding/ask/learn layers (Lorenzo's call, 2026-06-29).
2. **Conservative default: unknown origin = UNTRUSTED.** A memory is `unverified`
   until it is either confirmed by Lorenzo or matches an authoritative source. This
   matches the pillar's security origin (the burned child treats unfamiliar fire as
   dangerous until told otherwise).

## The hard truth (verified in code, not assumed)

At the L0 capture boundary a memory carries only `{role, messageText, sessionKey,
sessionId, timestamp}` (`src/core/store/types.ts` `L0Record`; written in
`src/core/hooks/auto-capture.ts`). **There is no provenance field, and the Claude
Code transcript cannot distinguish text Lorenzo TYPED from text he PASTED** from a
third party. So perfect provenance is impossible to infer. The design lives with
this: provenance is **coarse and channel-level**, and real trust is **earned** via
confirmation/grounding — never assumed from content we cannot verify.

## The principle that keeps the soul alive (non-negotiable)

**Trust gates ACTION, not INJECTION.** An `unverified` memory still surfaces in
Proactive Injection exactly as today — the associative soul is untouched. Trust
matters ONLY when a memory would drive a **consequential** action; there, an
`unverified` memory triggers the "look it in the face" (the ask, built in a later
phase). The conservative default therefore does NOT silence Sinapsys.

## What already exists (reuse, do not reinvent)

From `src/core/kb/foundations-schema.ts`:
- **`memory_lifecycle`** — one row per memory unit (fact/event/lesson), already has
  `provenance_json TEXT DEFAULT '{}'` (today always empty). This is the home for the
  stamp: universal, per-unit, no new table.
- **`memory_audit`** — append-only mutation trail (`actor`, `before_json`,
  `after_json`, `reason`, `operation`, `ts`). This is where a confirmation is
  recorded — the "learn forever" ledger.
- The `facts` table (`src/core/store/sqlite.ts`) carries `confidence` (default 0.7),
  `valid_from` / `valid_to`, and `superseded_by` / `superseded_at` — the exact
  machinery to raise confidence and let a confirmed memory supersede the uncertain
  one (HEAD = `superseded_by IS NULL AND valid_to IS NULL`, per `kb/retrieval.ts`).

## Data design

Give `memory_lifecycle.provenance_json` a real, validated shape (was `{}`):

```jsonc
{
  "origin": "conversation" | "tool_output" | "lorenzo_confirmed" | "authoritative_source",
  "trust":  "unverified" | "trusted",        // default "unverified"
  "confirmed_by": "lorenzo" | null,
  "confirmed_at": "<iso8601>" | null,
  "source_message_ids": ["l0_..."],          // already linkable from extraction
  "schema": 1                                  // versioned for forward migration
}
```

Trust derivation (deterministic):
- `trusted` ⟺ `origin ∈ {lorenzo_confirmed, authoritative_source}`.
- everything else ⟹ `unverified` (the conservative default).

`origin` at write time is best-effort and coarse:
- conversation-extracted facts/events ⟹ `origin: "conversation"`, `trust: "unverified"`.
- (future hook) confirmed by Lorenzo ⟹ `origin: "lorenzo_confirmed"`, `trust: "trusted"`.
- We do NOT attempt to classify "pasted third-party inside a user turn" — unprovable
  from the transcript. `tool_output` is stamped only if/when a tool-sourced unit is
  written (no such path is added in this phase; the enum value is reserved).

## Components (small, isolated, testable)

1. **`provenance.ts`** (new, ~120 lines) — the trust model in one place:
   - `ProvenanceStamp` type + a Zod schema (validate at the boundary).
   - `defaultProvenance(sourceMessageIds): ProvenanceStamp` → conversation/unverified.
   - `deriveTrust(stamp): "unverified" | "trusted"` (pure).
   - `serialize/parse` helpers (round-trip `provenance_json`), tolerant of legacy
     `{}` (legacy ⟹ treated as conversation/unverified, never crashes).

2. **Write-time stamping** — where `memory_lifecycle` rows are created for a new
   fact/event, write `defaultProvenance(...)` instead of `'{}'`. (Locate the single
   lifecycle-insert path in the KB writer; one focused change, follow existing code.)

3. **`confirmMemory(...)` hook** (new, in the KB store/writer layer) — the API the
   later ask-phase will call. Given an `owner_id`/`owner_kind`:
   - flip `provenance_json` → `origin: lorenzo_confirmed`, `trust: trusted`,
     `confirmed_by/at` set;
   - raise the fact's `confidence` (e.g. → 0.99) and, when a superseded id is given,
     set `superseded_by` on the old uncertain unit;
   - append a `memory_audit` row (`operation: "confirm"`, `actor: "lorenzo"`,
     before/after, reason). All in one transaction. Errors swallowed + logged
     (memory must never break a turn).

4. **Read accessor** — `getProvenance(owner_id, owner_kind): ProvenanceStamp` so the
   later phases (and a debug surface) can read trust. No injection path changes here.

## Out of scope (later phases — do NOT build now)

- The "consequential action" / stakes policy (Phase 2).
- Grounding a recalled value against live code/config reality (Phase 3).
- The inject-the-question → carry-to-Lorenzo → re-bind-answer loop (Phase 3).
- Any change to recall/injection ranking or content (the soul stays as-is).

## Error handling

Every new path is off the critical conversation path: parse failures on a legacy or
malformed `provenance_json` degrade to conversation/unverified (never throw into a
turn). `confirmMemory` is transactional; on failure it rolls back and logs, leaving
the prior stamp intact.

## Testing (TDD, non-circular, real DB)

- `provenance.ts`: default stamp is conversation/unverified; `deriveTrust` truth
  table; parse tolerates `'{}'` and garbage → unverified.
- Write-time: a freshly written fact/event has `provenance_json` with
  `trust=unverified` (real temp `VectorStore`, query the row back).
- `confirmMemory`: flips to trusted, writes exactly one `memory_audit` row with
  `actor=lorenzo`, raises confidence, and (when given) sets `superseded_by` on the
  old unit — all verified by reading the DB, not mocks.
- Regression: Proactive Injection output is byte-for-byte unchanged for an
  `unverified` memory (trust gates action, not injection).

## How we'll know it's done

Build green + the tests above green on a real DB, and a manual DB query shows new
memories carrying a real provenance stamp while injection is unchanged. Then Phase 2
(stakes) can begin on top.
