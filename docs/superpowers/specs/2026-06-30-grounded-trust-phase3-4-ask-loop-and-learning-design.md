# Grounded Trust — Phase 3+4: the ask-loop (INTERRUPT) + learning

> Design + implementation note, 2026-06-30 (Lorenzo & Socio).
> **Status: IMPLEMENTED + DEPLOYED LIVE 2026-06-30.** Commits 8018dd1 (ask-loop +
> learning), 5614fc2 (perf index), 437b5c4 (bug fix: confirm clears the gate),
> f76594c (deterministic full-loop test) on `feat/memory-excellence`.
> Parent pillar: [the child and the fire](./2026-06-29-grounded-trust-child-and-fire-design.md).
> Builds on Phase 1 (provenance) + Phase 2 (stakes gate). This closes the loop.

## What these phases deliver

Phase 1 stamped every memory's trust; Phase 2 decided WHEN an uncertain, high-stakes
memory deserves to stop an action. Phase 3 makes Sinapsys **ask Lorenzo**, and Phase
4 makes it **learn** so it never asks the same thing twice. Together: *provenance →
if uncertain and it matters, ask the one who knows → learn forever.*

## Phase 3 — the ask-loop, INTERRUPT model (Lorenzo's choice)

Lorenzo chose the **interrupt** model over a soft note (2026-06-30): the question is
a block the agent MUST raise before acting on that memory, not a hint it may skip.
This is the stronger answer to the pillar's risk #1 ("it rides on the agent actually
asking"). The conservative-high stakes gate keeps these rare, so the interrupt
protects rather than nags.

**The architectural truth (honest):** a memory system does not intercept actions; it
sees only recall. So the loop is wired at recall:

1. **Mark** (`src/core/hooks/auto-recall.ts` → `runKbRecall`): after a KB recall, the
   recalled units pass through `store.gateRecalledUnits` — any unverified, high-stakes
   unit is marked `gate_state = pending_confirmation` (best-effort, off the critical
   path; the unit stays in the recall result unchanged — trust gates ACTION, not
   injection).
2. **Ask** (`src/core/tdai-core.ts` → `handleBeforeRecall`): after recall,
   `store.getPendingAsks` surfaces pending memories and `renderGroundedTrustInterrupt`
   (`src/core/kb/grounded-trust-ask.ts`) prepends a `<grounded-trust-interrupt
   priority="block-before-acting">` block to the turn context. Each line carries the
   exact tool calls to record Lorenzo's answer.
3. **Re-bind** (`index.ts` tools `tdai_confirm_memory` / `tdai_reject_memory` →
   `tdai-core.resolveGatedMemory`): when Lorenzo answers, the agent calls the tool
   with the memory's owner id. Confirm → `store.confirmMemory` (authoritative);
   reject → `store.rejectMemory` (tombstone).

The wiring reaches the live gateway: `POST /recall` (`server.ts:423`) calls
`handleBeforeRecall`, and `composeRecallContext` includes `prependContext`
(`server.ts:431`) — so the interrupt is delivered end to end. Verified live (`/recall`
= 200) and by `grounded-trust-loop.test.ts`.

## Phase 4 — learning (asked once; never act on a lie)

- **Confirm → authoritative, gate cleared.** `confirmProvenance` flips trust to
  trusted AND sets `gate_state = clear`, so a confirmed memory stops surfacing in
  `getPendingAsks`. **This is the bug the full-loop test caught:** the first cut
  raised trust but left the gate `pending`, so a confirmed memory would be re-asked
  forever — the opposite of "learned". Fixed in 437b5c4. (Lesson: per-step unit tests
  passed; only the whole-loop test exposed it.)
- **Reject → tombstone, suppressed from action.** `rejectMemory` marks the stamp
  `rejected` (kept, never hard-deleted — the burned child learns to discriminate, it
  does not forget the fire), drops a rejected FACT from HEAD (`valid_to`), and the
  recall path (`auto-recall.ts` → `store.rejectedOwnerKeys`) filters tombstoned
  units (incl. append-only events) out of injection. A rejected memory never drives
  action and is never re-asked.

## Performance (binding: memory must never slow the conversation)

`getPendingAsks` runs every recall turn. Its `json_extract(provenance_json,
'$.gate_state')` filter would full-scan `memory_lifecycle` (0 pending = scan to end).
Fixed with an expression index `idx_life_gate_state`
(`src/core/kb/foundations-schema.ts`); `EXPLAIN QUERY PLAN` confirms `SEARCH ... USING
INDEX`. Pending rows are rare (conservative gate), so the lookup is tiny.

## Security

The `<grounded-trust-interrupt>` boundary is added to `escapeXmlTags`
(`src/utils/sanitize.ts`) so memory text containing a closing tag cannot break out of
the block. Confirm/reject tools act only on an owner id; they call store methods that
swallow + log their own errors (never break a turn).

## What remains (non-blocking)

- Observe the interrupt firing on an **organic** recall (needs an uncertain
  high-stakes memory to resurface in real use). All logic is unit + full-loop tested
  and the deploy is healthy; the organic event will validate it in the wild.
- The vision branch at recall activates automatically once the recall path threads
  `eventType` + `distinctiveness` into `gateRecalledUnits` (today operative-only at
  recall; the classifier already supports both).
