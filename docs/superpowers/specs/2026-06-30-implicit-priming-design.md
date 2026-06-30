# Implicit Priming (Idea 2) — sub-threshold memories bias what surfaces

> Design, 2026-06-30 (Lorenzo & Socio). Status: IN PROGRESS (TDD).
> Idea 2 of the five. Blueprint §185 ("Attivazione a Cascata"): a weak/sub-threshold
> match does NOT surface itself, but AMPLIFIES the score of graph-connected memories
> so one of them crosses the threshold and IS shown — "l'agente trova il contesto
> giusto senza aver cercato le parole giuste." The primer stays invisible. This is
> distinct from the spreading-activation already built (which surfaces NEW connected
> memories from ABOVE-threshold seeds and marks them ·associato); priming RE-RANKS the
> existing candidate set, invisibly.

## The blocker we faced honestly (and the deeper fix)

Measured live: 679 entities, 240 relations → **0.35 rel/entity, 59% of entities
isolated**. On the explicit relation graph, recall candidates almost never share an
edge, so textbook priming would be a **no-op** (the circular-test trap). So priming
does NOT rest on the explicit graph alone. It rests on a denser, more cognitively
faithful edge layer:

**Co-occurrence edges.** Entities that appear in the SAME event/fact are
associatively linked — Hebbian "fire together, wire together", literally. Events carry
`entities_json`; every pair co-occurring in an event is an implicit edge, weight =
shared-event count. This densifies the graph for free from existing data and makes
priming (and the prior spreading activation) actually fire.

## Mechanism (reuses the spreading-activation engine)

Inside `kbRecall`, AFTER the full candidate list is ranked and BEFORE the
`slice(0, maxResults)` cut (`retrieval.ts`) — the cut tail is exactly the
sub-threshold population:

1. **Edges among candidates** = explicit `relations` ∪ co-occurrence, restricted to the
   candidate entity set (≤ maxResults·FANOUT entities, so bounded).
2. **Prime.** Seed every candidate with its current ranking and spread activation over
   those edges. The activation a candidate RECEIVES from the others is its priming
   boost (a candidate central in the recall sub-graph — connected to many co-recalled
   things — gets amplified). Reuses `spreadActivation` with a new `includeSeeds` option
   (so seeds collect the activation that flows into them).
3. **Re-rank.** `ranking' = ranking + λ · boost` (λ small — relevance stays primary,
   priming only nudges, blueprint's +0.15 spirit). Re-sort, THEN slice.
4. A previously-cut candidate that got primed now crosses into the top-K and surfaces —
   with NO marker (priming is IMPLICIT; the agent just gets better context). The primer
   that did the amplifying may itself stay in the cut tail, invisible.

## Components

1. **`spreadActivation` (+`includeSeeds`)** — when true, seeds are not excluded from the
   result, so each seed's value is the activation it RECEIVED from the network (its
   initial activation is never added to the accumulator). Default false = unchanged.
2. **`implicit-priming.ts`** (pure) — `computePrimingBoosts(candidates, neighborsOf,
   params): Map<id, boost>` over candidate entities; `applyPriming(rankings, boosts,
   lambda)`. Pure, total, deterministic.
3. **Store `coOccurringEntities(entityIds, namespace)`** — adjacency among the given
   entities by shared-event count (from `events.entities_json`), unioned by the caller
   with `queryRelationsForEntity`. Bounded to the candidate set.
4. **Wiring** in `kbRecall` — build candidate-entity adjacency, prime, re-rank, slice.
   Best-effort: any failure leaves the un-primed order (recall never breaks).

## Testing

- `spreadActivation includeSeeds`: a seed connected to another seed receives its
  activation (boost > 0); isolated seed → 0.
- `implicit-priming`: a weak candidate connected (co-occurrence) to a strong one is
  boosted above an equally-weak ISOLATED candidate; λ keeps a strong match on top.
- store `coOccurringEntities` (real DB): two entities sharing an event are neighbors
  with weight = shared events; non-co-occurring → not neighbors.
- end-to-end (real DB): a sub-threshold candidate that co-occurs with the query's
  strong match crosses into the returned top-K; the primer itself need not appear.

## Out of scope

- Persisted co-occurrence edges (computed on the fly per recall for now; materialize
  later if hot). Weighting co-occurrence vs explicit relations differently (treat
  union, explicit + shared-event-count for now).
