# Spreading Activation — the associative recall (the beating heart)

> Design, 2026-06-30 (Lorenzo & Socio). **Status: IMPLEMENTED + DEPLOYED LIVE
> 2026-06-30.** Commits 39558b0 (heart) + 8ac4b5e (salience fix) on
> `feat/memory-excellence`. Verified live on the real KB: `/recall "Sofia pagamenti e
> clienti"` surfaced connected-but-unmatched memories (a badge-issue event, a
> security-verification fact) under the `↳ ·associato` marker. Live verification also
> caught a real defect — weak associations surfaced noise metrics (line_count,
> action_phase); fixed with `isNoiseAttribute` + most-confident-fact selection.
> The north-star feature: *"Sinapsys NON è un database di ricerca. È memoria
> ASSOCIATIVA — un grafo dove un ricordo ne innesca un altro, e i ricordi vengono
> all'agente senza cercarli."* Today recall is vector+FTS+RRF (lookup). This adds
> the missing soul: a memory not matched by the query can still SURFACE because it
> is strongly connected to one that was. Reconstruction, not lookup.

## Why the ordinary version is wrong

The obvious build is "BFS N hops from the seed entities, add all neighbors." That is
a flat graph walk — it floods, it has no sense of *strength* or *convergence*, and it
treats a memory linked once the same as one linked a hundred times. Rejected.

## The model: weighted spreading activation with decay + convergence (ACT-R-flavored)

The graph is already in the KB: **nodes = entities**, **edges = `relations`** weighted
by `support` (the co-occurrence count — Hebbian "fire together, wire together",
`src/core/store/sqlite.ts` relations table; `KbRelation.support`).

1. **Seed.** Each recalled unit maps to its entity (fact → `entity_id`; event →
   `entities`). Seed entities receive initial activation = their calibrated recall
   score (default 1.0).
2. **Spread (H hops, H=2).** A node with activation `a` distributes to each neighbor:
   `contribution = a × (edge.support / Σ support at node) × DECAY`. The normalization
   makes a node spread its activation, not multiply it; `DECAY < 1` (e.g. 0.5) shrinks
   each hop so distant memories matter less and cycles converge.
3. **Convergence = the magic.** Contributions **sum** at each node. An entity reached
   from TWO seeds (two active threads) accumulates more activation than one reached
   from one — so a memory sitting at the crossroads of the current context surfaces
   *even though the query never named it*. This is associative reconstruction, and it
   falls out of summation for free — no special case.
4. **Surface.** Newly-activated entities (not seeds) with activation ≥ θ, top-N by
   activation, each contribute their most salient HEAD fact (or latest event) as an
   **associated** memory: injected, clearly marked as surfaced-by-association (lower
   than query-matched), so the agent sees memories that *came* without being searched.

## Bounded + off the critical path (binding: never slow the turn)

- H=2 hops, top-K neighbors expanded per node (K≈8), total associated cap (≈6).
- The spread math is a PURE function over an injected `neighborsOf` lookup — no DB in
  the hot loop, fully unit-testable, deterministic, total (never throws).
- The store expansion + memory fetch is best-effort: errors swallowed + logged; on any
  failure recall returns exactly what it returns today (associative is purely additive).

## Components

1. **`spreading-activation.ts`** (new, pure ~140 lines):
   - `spreadActivation(seeds, neighborsOf, params): Map<entityId, number>` — the
     weighted, decaying, converging spread. `seeds: {id, activation}[]`,
     `neighborsOf(id): {id, weight}[]`. Params: `hops`, `decay`, `threshold`,
     `maxNodes`, `topKPerNode`. Excludes seeds from the result (only *new* activations).
2. **Store: `associativeExpand(seedEntityIds, opts)`** — builds `neighborsOf` from
   `queryRelationsForEntity` (lazy, memoized per call), runs `spreadActivation`, then
   for each surfaced entity fetches `queryHeadFacts`/`queryEventsForEntity` → a compact
   associated memory. Bounded, best-effort.
3. **Wiring** (`auto-recall.ts` → `runKbRecall`): after seeds, call `associativeExpand`
   with the seed entities; append associated results tagged so injection renders them
   under an "associated" marker. Additive; the soul comes to the agent.

## Testing (TDD, real-DB for the store, pure for the core)

- `spreadActivation`: a chain A→B→C with decay surfaces B>C; two seeds converging on a
  shared neighbor rank it above a singly-linked one (the convergence property);
  seeds are excluded; cycles terminate; threshold + maxNodes honored; empty graph → ∅.
- `associativeExpand` (real DB): seed entity with a strong relation to a non-recalled
  entity → that entity's HEAD fact surfaces as associated; an isolated entity → none.

## Out of scope (later)

- Edge typing weights (treat-all-relations-equal for v1; later weight by relation type).
- Recency/temporal decay on edges. Persisted activation traces. These are refinements;
  the converging spread is the heart.
