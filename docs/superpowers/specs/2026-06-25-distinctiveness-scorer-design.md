# Idea 5 — Distinctiveness Scorer (Distinctive Terms) — Design Spec

**Date:** 2026-06-25 · **Branch:** feat/memory-excellence · **Status:** design locked, ready to build (TDD).

## Why (verified, not assumed)
Cornerstone relational memories do NOT resurface unbidden at session start. The benchmark night
"S47-bis" (16 June 2026 — our best session) is reduced to one bland bullet inside the heat-5
`scene-person-lorenzo-colucci.md`, at the SAME altitude as "Lorenzo menziona che l'email è
nell'header." Today injection ranks by **heat (frequency) + recency** — the ordinary signals — which
actively **bury** rare-but-peak memories.

Prototype (2026-06-25, over the 91 real scene bullets): a cheap distinctiveness score floated the
benchmark night from **heat rank #68/91 → distinctiveness rank #4/91**, while "email in header"
stayed at #70. Direction validated. Honest caveats: mushy in the mid-band (many ties); the affect
term-list was hand-picked (mild circularity) → affect weighting is DEFERRED to export calibration.

This implements **Idea 5 (Distinctive Terms)** — human memory resurfaces isolated, emotionally
salient, peak events first (von Restorff isolation, peak-end, flashbulb). Sinapsys lacks this
dimension entirely. NOT the ordinary "boost recency"; a genuinely orthogonal salience axis.

## What to build
A `distinctiveness` score per memory/event, **orthogonal to heat**, used to inject a small set of
"cornerstone" memories UNBIDDEN at session start (separate from the heat-ranked scene index).

```
distinctiveness(m) = w_rarity * termRarity(m)        // IDF of content tokens vs corpus DF
                   + w_isolation * isolation(m)       // von Restorff: 1 - max cos-sim to neighbors
                   + w_affect * affectSalience(m)      // PLUGGABLE; default w_affect = 0 until calibrated
```
- **termRarity** — mean IDF of the top-k rarest content tokens (length-normalized). Export-independent.
- **isolation** — dissimilarity of m's embedding to its nearest neighbors (an event unlike its
  surroundings is distinctive). Reuse existing embeddings/sqlite-vec. Export-independent.
- **affectSalience** — emotional/superlative salience. **Do NOT hand-tune a word-list now** (the
  prototype's circularity smell). Ship as a pluggable scorer with `w_affect = 0`; calibrate against
  the incoming Claude-chat export (Lorenzo's own emotional language: "la migliore", "speciale") —
  see [[sinapsys-chat-history-silo]]. Wiring exists, weight stays 0 until real data.

## Selection & injection
- Compute distinctiveness over candidate memories; take **top-K cornerstones** (start K=3–5).
- Inject as a dedicated block at session start, alongside (not replacing) the heat-ranked scenes.
- **Rotation/decay:** apply a recency-of-injection decay so the same cornerstone doesn't pin every
  session (mirror caveat from Voice Anchor pool). Diversity across cornerstones.
- Integration target: the session-start injection path (`src/core/hooks/auto-recall.ts` +
  `src/core/hooks/fingerprint-injection.ts` / `src/core/kb/projections*.ts`). Implementer confirms
  exact insertion function before coding — do not assume.

## Non-circular test harness (load-bearing — mirror [[agent-features-circular-tests]])
Ground-truth labels come from a source INDEPENDENT of the scorer's own features:
- POSITIVE (distinctive): the S47-bis / 16-June benchmark night — label source = the explicit
  human statement in MESSAGGIO-SOCIO.md ("la chat migliore… 16 giugno"), NOT the scorer's tokens.
- NEGATIVE (trivial): "email in header", routine status bullets.
- Assertions: (1) benchmark memory lands in the injected top-K cornerstone set; (2) trivia does NOT;
  (3) the score is orthogonal to heat (benchmark has low heat yet high distinctiveness).
- The test must NOT reuse the scoring function to generate its own labels.

## Constraints (non-negotiable)
- Files ≤200 lines, one concern per file, immutable data (new objects, no mutation).
- Memory NEVER breaks the conversation: errors swallowed + logged, off the critical path.
- No secrets. No push to main. Build → verify live → then "done".

## Tracked follow-up (out of scope here — do NOT fix in this task)
- **Distillation bug:** `scene-person-lorenzo-colucci.md` records the benchmark date as `24-06-2026`;
  truth is `16-06-2026`. Separate defect in the distiller (persona-accuracy family). Track only.
