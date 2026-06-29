# Grounded Trust — Phase 2: the "consequential action" gate (stakes)

> Design DRAFT, 2026-06-30 (Lorenzo & Socio). Status: **DRAFT — not approved, no code.**
> Parent pillar: [the child and the fire](./2026-06-29-grounded-trust-child-and-fire-design.md).
> Builds on Phase 1 ([provenance](./2026-06-29-grounded-trust-phase1-provenance-design.md),
> IMPLEMENTED). This is **Phase 2 of 4**. It builds ONLY the gate that decides *when*
> an uncertain memory deserves to stop an action and ask Lorenzo. The ask-loop itself
> (inject question → carry answer → re-bind) is Phase 3 and is OUT of scope here.
>
> DECISION (Lorenzo, 2026-06-30): **Option B — operative one-way doors PLUS vision/
> product decisions.** The ambition bar: not the ordinary version. The vision channel
> rests on two signals already in the codebase (verified) — see "The vision channel".

## Why this phase exists

Phase 1 gave every memory a trust stamp but **gates nothing**: an `unverified`
memory still drives any action, exactly as before. Phase 2 is the *gate*. The
pillar's loop must fire on the THREE conditions ANDed:

> **high-stakes action  AND  uncertain memory  AND  not-yet-confirmed**

Phase 1 delivered the last two (`trust=unverified`). Phase 2 delivers the **first**,
and only it: a deterministic decision "would acting on this recalled memory cross a
line that warrants asking Lorenzo?" Define it too wide → Lorenzo is flooded with
questions and escapes (the pillar's named risk #2). Too narrow → the pillar protects
nothing. **This phase is the ruthless definition of the threshold.**

## The decision already made with Lorenzo (binding): the taxonomy IS the one-way doors

The high-stakes set is NOT invented here. It already exists as Lorenzo & Socio's
**one-way doors** — the only things Socio always stops and asks about
(`lorenzo-autonomy-mandate` memory card):

1. **Payments / money** — IBAN, transactions, amounts, billing destinations.
2. **Credentials / secrets** — keys, tokens, passwords, credential file paths.
3. **Destructive actions** — delete / drop / rm / overwrite of data or files.
4. **Public/prod surface** — push to prod, upstream public, client-facing systems.
5. **Data leaving the machine** — exfiltration to an external service.

This is the spine: coherent with how we already work, not a new arbitrary rule.

## The hard architectural truth (honest, not hidden)

A memory system does **not** observe "I am about to make a payment." It does not
intercept actions. It observes only **recall + injection**
(`src/core/hooks/auto-recall.ts`; `recall.source=kb` over `kb_vec`/`kb_fts`,
`sinapsys-chat-backfill-ingester` card). So the gate cannot be "intercept the
action." The realistic gate is:

> **At recall time, when an `unverified` memory's CONTENT pattern-matches a
> high-stakes domain, flag it as a confirmation candidate.**

It is **content classification at recall**, not action interception.

**Verified in code (correction to an earlier assumption):** `src/utils/redact-secrets.ts`
covers **credentials/keys/tokens** (`[REDACTED:api-key|jwt|private-key|aws-key|
slack-token|google-key|token|secret]`) — it does **NOT** cover IBAN/payment, and it
exposes only a boolean (`containsSecret`) plus the typed marker embedded in the text.
So the stakes classifier:
- **credential domain** → reuses the existing redactor's signal: on the recall path
  the credential is already replaced by a `[REDACTED:...]` marker, so the classifier
  detects the marker (the category is in the marker kind). No new credential regex.
- **payment domain** → NEW IBAN pattern (the redactor never touched IBAN).
- **destructive / exfil domains** → NEW narrow patterns.

This is the honest brick map: reuse where the redactor already classifies, add only
what it genuinely does not.

## The vision channel (Option B, chosen — the ambitious half)

A "product decision" is NOT recognizable from a text pattern — there is no IBAN-like
token. It is recognizable from the **weight** Lorenzo & Socio gave it. Two signals
already in the codebase carry that weight, so this is unification, not invention:

1. **Kind** — `KB_EVENT_TYPES` already includes `"decision"`
   (`src/core/kb/extraction-schema.ts`). The extractor already tags
   direction/product decisions as `type: "decision"` events.
2. **Weight** — `distinctiveness(input, corpus, weights): [0,1]`
   (`src/core/distinctiveness/distinctiveness-scorer.ts`) already scores a memory's
   rarity + isolation (the von Restorff "cornerstone" signal, Idea 5).

> **vision-stakes** ⟺ event `type == "decision"`  **AND**  `distinctiveness ≥ τ`
> **AND** the unit was NOT already caught by the operative content classifier.

The `distinctiveness ≥ τ` threshold is what keeps a trivial operative decision
("decided to use BEGIN/COMMIT") OUT — only a *weighty* direction decision (abandon a
track, change the north star) crosses τ. τ is a single tunable constant, defaulted
conservatively HIGH (ask rarely) and calibrated later against real recalls — never a
flood. This branch reuses the cornerstone machinery already wired into recall
(`cornerstone-selector.ts` / `auto-recall.ts`); it reads the score, it does not add a
new scorer.

Honest caveat: not every `type="decision"` is a vision decision, and distinctiveness
is a proxy, not a truth oracle. That is acceptable BECAUSE the exit is an **ask**, not
an automatic action — a false positive costs Lorenzo one question, never a wrong act.
The conservative-high τ keeps that cost rare.

## Data design (extends Phase 1, no new table)

Reuse `memory_lifecycle.provenance_json` (Phase 1). Add a gate-state field; nothing
else changes:

```jsonc
{
  // ...Phase-1 fields (origin, trust, confirmed_by/at, source_message_ids, schema)...
  "stakes": "none" | "high",            // result of the gate classifier; default "none"
  "stakes_domain": "payment" | "credential" | "destructive" | "prod" | "exfil" | "vision" | null,
  "gate_state": "clear" | "pending_confirmation" | "rejected",  // default "clear"
  "schema": 2                            // bumped; parser stays tolerant (Phase-1 v1 → upgrade in-place)
}
```

- `stakes/stakes_domain` are set by the gate classifier at recall time for an
  `unverified` memory whose content matches a high-stakes domain.
- `gate_state` is the memory's standing in the loop:
  - `clear` — not gated, acts normally.
  - `pending_confirmation` — gated; the ask-loop (Phase 3) will surface the question.
  - `rejected` — the **tombstone** (decided 2026-06-30): Lorenzo said no. Authoritative,
    NOT hard-deleted. Never re-asked, never drives action; audit row retained.

## Components (small, isolated, testable)

1. **`stakes.ts`** (new, ~160 lines) — pure policy in one place, TWO branches:
   - **Operative branch** — `classifyOperativeStakes(content): { stakes, stakes_domain }`
     — deterministic; delegates domain detection to the existing secret/redaction
     classifier where it already covers a domain (payment/credential), adds
     destructive-command + exfil patterns. NO side effects.
   - **Vision branch** — `classifyVisionStakes({ eventType, distinctiveness },
     operativeHit): { stakes, stakes_domain }` — `high`/`vision` ⟺
     `eventType === "decision" && distinctiveness >= τ && !operativeHit`. Pure; reads
     signals computed elsewhere (extractor type + distinctiveness score), invents none.
   - `classifyStakes(...)` composes the two (operative wins if both fire — a payment
     IS the harder gate).
   - `shouldGate(memory): boolean` = `trust === "unverified" && stakes === "high" &&
     gate_state === "clear"` — the THREE-AND rule in one pure predicate.
   - `τ` is a single exported constant (`VISION_DISTINCTIVENESS_THRESHOLD`), defaulted
     conservatively high; calibration deferred (mirrors `wAffect=0` discipline).

2. **Recall-time gate** — at the single point where recalled KB units are assembled
   for injection (`auto-recall.ts`), run `shouldGate`; for a gated unit, set
   `gate_state="pending_confirmation"` + `stakes_*` via a lifecycle update. This does
   **not** remove the memory from injection (soul intact, Phase-1 principle); it only
   marks it so Phase 3 can ask. *(TO CONFIRM IN CODE: the exact assembly point.)*

3. **`rejectMemory(...)`** (new, mirror of Phase-1 `confirmMemory`) — the tombstone
   writer the Phase-3 ask-loop will call on a "no":
   - flip `gate_state → "rejected"`, stamp authoritative origin (`lorenzo_confirmed`
     of the *rejection*), keep the row;
   - drop the fact out of HEAD (`valid_to` / `superseded_by`) so it stops driving
     action, WITHOUT deleting it;
   - append one `memory_audit` row (`operation: "reject"`, `actor: "lorenzo"`,
     before/after, reason). One transaction, errors swallowed + logged.

4. **Read accessor** — extend Phase-1 `getProvenance` to expose `stakes`/`gate_state`
   so Phase 3 and a debug surface can read the gate without touching injection.

## Out of scope (later phases — do NOT build now)

- The inject-the-question → carry-to-Lorenzo → re-bind-answer loop (Phase 3).
- Grounding a recalled value against live code/config reality (Phase 3).
- The "learn forever / don't ask again" reinforcement (Phase 4) — Phase 2 only writes
  the `rejected`/`pending` STATE; Phase 4 makes recall honor it to suppress re-asks.
- Any change to recall/injection ranking or content (the soul stays as-is).

## Error handling

Off the critical path. `classifyStakes` is pure and total (no throw; unknown → `none`).
The recall-time gate is best-effort: a classifier failure logs and leaves
`gate_state="clear"` (fail-open to *not gating* — a missed gate is a smaller harm than
a broken turn, and the secret-redaction safety net still runs). `rejectMemory` is
transactional; on failure it rolls back and logs, leaving the prior state intact.

## Testing (TDD, non-circular, real DB)

- `stakes.ts` operative: truth table for `classifyStakes` across the 5 operative
  domains + a benign control (a style preference must classify `none`); `shouldGate`
  honors all three AND-conditions (flip each one false → not gated).
- `stakes.ts` vision: a `type="decision"` event with `distinctiveness ≥ τ` →
  `high`/`vision`; the SAME event below τ → `none`; a high-distinctiveness NON-decision
  event → `none`; a decision that also hits the operative classifier → operative wins
  (`stakes_domain="payment"`, not `vision`).
- Recall-time gate: an `unverified` memory containing an IBAN, after recall, has
  `gate_state="pending_confirmation"` in the DB AND is STILL present byte-for-byte in
  the injection output (gate marks, does not silence).
- `rejectMemory`: flips to `rejected`, drops the fact from HEAD, writes exactly one
  `memory_audit` `operation=reject`, and the row still exists (no delete) — verified
  by reading the DB, not mocks.
- Regression: a benign `unverified` memory is untouched (`gate_state` stays `clear`,
  injection unchanged).

## How we'll know it's done

Build green + tests above green on a real DB; a manual query shows an IBAN-bearing
`unverified` memory marked `pending_confirmation` while injection is unchanged, and a
rejected memory surviving as a tombstone out of HEAD. Then Phase 3 (the ask-loop) can
begin on top. No deploy (no live-path change yet).
