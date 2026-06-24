# Context Fingerprint (Idea 1) — Design Spec

**Date:** 2026-06-24
**Track:** A (daily memory made revolutionary now)
**Status:** Approved design, pending implementation
**Owner of technical decisions:** Claude. Owner of product/experience: Lorenzo.

## 1. Purpose

Today proactive injection reacts to **one file at a time, in the present moment**
(`situation-injection.ts` → `buildFileInjection`). The Context Fingerprint makes
memory react to the **shape of the whole situation** — which files are in play
*together*, what kind of error is being hit, what kind of task — and learns,
**across sessions**, which memories mattered in situations of that shape. Re-enter
a *similar* (not identical) shape later and the relevant memory surfaces unbidden.

This is the "expert recognizes the picture from early cues" mechanism validated by
the round-2 medical illness-script research (PMC4795084): experts activate the right
script from early situational cues, below awareness, without explicit search — and
fall back to deliberate search on ambiguous fit (premature-closure guard).

This is **Idea 1** of the five soul ideas. It is the sellable originality angle #3:
proactive injection from a situation fingerprint, no explicit query.

## 2. Non-goals (YAGNI)

- **No embeddings in v1.** The signals (files, error signatures, task type) are
  discrete sets; weighted overlap is the correct similarity tool and stays fast on
  the hot path. Embeddings can enrich later — not now.
- **No LLM on the hot path.** Task-type inference is deterministic from the tool mix.
- **No true "which memory actually helped" usage tracking in v1.** We store what was
  *surfaced* as the proxy. The existing lifecycle `reinforce` already tracks access
  and can refine the link later.
- **No spreading activation / graph traversal** (that is Phase D, premature — graph
  still sparse).

## 3. Experience decisions (Lorenzo's calls)

1. **Match sensitivity: also medium matches.** Lorenzo chose more suggestions over
   strict silence, against the default recommendation. Honored via **two-tier voice**
   rather than a single lowered threshold:
   - **Strong match** → assertive block: "last time you were in a situation like this,
     this mattered."
   - **Medium match** → explicitly tentative block: "possibly related — from a loosely
     similar past situation."
   A medium match never masquerades as a confident one. Thresholds are configurable so
   the bar can rise as data accumulates.
2. **Silent below medium.** Weak/ambiguous matches inject nothing; explicit `/recall`
   covers them. This is the premature-closure guard.

## 4. Architecture

Additive, errors swallowed, never on the critical path — the same discipline as the
existing Track A slices. New files are small (~one responsibility each, project rule).

### 4.1 Data (already exists — `context_fingerprints` table, foundations brick 4)

```
context_fingerprints(
  id, session_key, ts,
  files_json,             -- the set of file keys in play
  error_signatures_json,  -- coarse error signatures seen
  task_type,              -- 'debug' | 'implement' | 'explore' | ''
  tool_sequence_json,     -- recent tool names (bounded)
  matched_owner_ids_json, -- entity ids whose memory was surfaced in this situation
  namespace
)
```
No schema change needed. Indexes on `(session_key, ts)` and `task_type` already present.

### 4.2 New modules

| File | Responsibility | Pure? |
|------|----------------|-------|
| `src/core/hooks/session-situation.ts` | Per-session rolling situation: bounded window of recent file keys, error signatures, tool names; `updateSituation(prev, event)` returns a new immutable situation. | pure |
| `src/core/hooks/task-type.ts` | `inferTaskType(situation)` → deterministic: any error in window → `debug`; else Write/Edit/MultiEdit present → `implement`; else mostly Read/Grep/Glob → `explore`; else `''`. | pure |
| `src/core/hooks/fingerprint-similarity.ts` | `scoreFingerprint(current, stored)` → number in [0,1] via weighted overlap (files Jaccard dominant + error-signature overlap + task-type match bonus); `classifyMatch(score)` → `'strong' \| 'medium' \| 'none'` against configurable thresholds. | pure |
| `src/core/kb/fingerprint-writer.ts` | `insertFingerprint(store, row)` and `queryRecentFingerprints(store, namespace, limit)` — thin persistence over store primitives. | impure (DB) |
| `src/core/hooks/fingerprint-injection.ts` | `buildSituationInjection(store, current, alreadyInjectedOwnerIds)` → `{ block, ownerIds } \| null`: score current vs stored fingerprints, pick best tier, build the two-tier `<situation-memory>` block, dedup owners against what single-file injection already showed this session. | impure (reads store) |

### 4.3 Store primitives (extend `IMemoryStore` + sqlite)

- `insertContextFingerprint(row)` — INSERT one row (via `db.prepare().run()`,
  never `db.exec` — node:sqlite security-hook false positive noted in build-state).
- `queryContextFingerprints(namespace, limit)` — recent rows, newest first, bounded.

Both optional on the interface (like the other KB read primitives) so non-KB
backends degrade to silence.

### 4.4 Wiring (`tdai-core.ts`)

- **State:** add `sessionSituationByKey: Map<string, Situation>` alongside the existing
  `injectedFilesBySession`. Bounded; cleared in `handleSessionEnd`.
- **`handleToolObservation`** (after the existing single-file injection):
  1. `updateSituation` with this event → store new rolling situation for the session.
  2. **MATCH:** `buildSituationInjection(store, current, alreadyInjectedOwners)`. If a
     block is produced, append it to the returned `inject` (or return it when the
     single-file path was silent). Dedup so the same owner is not shown twice.
  3. **WRITE (salient moment):** when memory was actually surfaced this turn
     (`surfacedNow.length > 0`), persist a fingerprint capturing the current
     situation + `matched_owner_ids` (the owners surfaced). Best-effort, swallowed.
- **`handleSessionEnd`:** drop `sessionSituationByKey[sessionKey]` +
  `injectedOwnersBySession[sessionKey]` (state cleanup only).

> **Implementation refinement (vs the first draft):** the fingerprint is written
> **per-turn at the salient moment**, not once at session-end. Writing the moment a
> memory is surfaced captures the situation shape *exactly when that memory mattered*
> — richer than one coarse end-of-session snapshot, and it avoids storing empty
> (owner-less) fingerprints that could never surface anything. A situation with no
> associated memory teaches nothing, so it is not stored. Session-end is cleanup only.

### 4.5 Gateway

`/observe` already returns `{ inject }`. No new endpoint — the situation block rides
the same field. The PostToolUse hook already forwards observations.

## 5. Data flow

```
PostToolUse → /observe → handleToolObservation
   ├─ extractSituation (existing)
   ├─ single-file injection (existing)           ──► owners A
   ├─ updateSituation(prev, event) → current
   ├─ MATCH: score current vs queryRecentFingerprints
   │     strong → assertive <situation-memory>
   │     medium → tentative <situation-memory>    ──► owners B (minus A)
   │     none   → silent
   └─ WRITE (if salient): insertContextFingerprint(current → owners A∪B)
session/end → handleSessionEnd → final insertContextFingerprint + cleanup
```

## 6. Error handling

Every new path is wrapped: a throw is logged at `warn` and swallowed, returning
silence. Memory must never break the conversation (binding principle). No new code on
the synchronous response critical path beyond bounded in-memory map updates and one
indexed SELECT (recent fingerprints, capped).

## 7. Testing (TDD, write tests first)

- `task-type.test.ts` — each branch of the deterministic inference.
- `session-situation.test.ts` — immutability, window bounding, dedup of file keys.
- `fingerprint-similarity.test.ts` — Jaccard math, tier classification at threshold
  boundaries, empty-set edge cases.
- `fingerprint-writer.test.ts` — round-trip insert/query on a real temp SQLite DB.
- `fingerprint-injection.test.ts` — strong vs medium framing, silent below medium,
  owner dedup against already-injected, null when nothing stored.
- `tdai-core` wiring test — observation updates situation, salient event writes a
  fingerprint, session-end writes final + cleans up. On the real store.
- Full KB/engine suite stays green; `tsc --noEmit` clean.

## 8. Honest limitations

- **Blooms with data.** Table is empty today; early matches are rare. Correct — better
  silent than false. Compounds with use.
- **Error signatures are coarse in v1.** The current `/observe` payload carries only an
  `isError` flag, not the error text. v1 signature = presence + the erroring tool name.
  A later extension can thread a truncated error string through the hook payload for
  richer signatures; the design does not depend on it.
- **Medium-tier false matches are possible by construction** (Lorenzo's choice). Mitigated
  by tentative framing + configurable threshold, not eliminated.

## 9. Deploy

Additive. Lands on the live gateway at the next `build:plugin` + gateway restart,
same as prior Track A slices. Nothing destructive; no migration.
