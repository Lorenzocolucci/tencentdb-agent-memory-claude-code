# Track B — Deep Mistake Notebook (L3) — Design Spec

> Date: 2026-06-24 · Branch: `feat/memory-excellence` · Status: DESIGN (no code until approved)
> Scope decided with Lorenzo: design the full arc **B1 + B2 + B3** in one spec, build in slices starting B1.
> Read first: blueprint Idea 3 / Fase 4 (`C:\Sinapsys\01-vision-and-plan\MEMORIA-BLUEPRINT.md`),
> cards `sinapsys-phase-b-direction`, `sinapsys-dual-track-direction`.

---

## 0. The one-line thesis

A lesson is emitted **only** when the same *kind* of failure recurs across **different sessions**.
Cluster by domain/pattern (semantic + shared files/entities + caused/fixed-by), never by timeline.
The lesson's trigger **is** a Context Fingerprint, so it resurfaces *unbidden* when the agent
re-enters a similar situation. Confidence grows on recurrence **and** on successful avoidance.
One incident → no lesson. Ever. (That is an anecdote — the thing we are explicitly killing.)

## 1. Non-goals (what this is NOT)

- NOT a per-incident summarizer / changelog. "build failed on June 10" is banned output.
- NOT intra-session bug→fix temporal pairing (the scrapped version — see `lessons-candidates.ts` today).
- NO LLM in the clustering path (must stay deterministic + unit-testable offline).
- NOT real-time. Runs inside the consolidation engine (Phase A, already live), additive, best-effort,
  **never throws on the critical path** — clustering failure ⇒ zero candidates ⇒ recall untouched.

## 2. Verified data reality (live KB, 2026-06-24 — measured, read-only)

| Signal | Value | Consequence for the design |
|---|---|---|
| `bug` events | **11 across 4 distinct sessions** | Few/zero lessons *today* — and that is CORRECT. |
| `caused` / `fixed-by` relations | 13 / 7 (= 20 real edges) | The relation signal (γ) is thin but **alive**, not zero. |
| `project` on bug events | all empty (`(none)`) | No "group-by-project" shortcut — domain MUST emerge from semantics/entities/relations. |
| `lessons` / `context_fingerprints` rows | 0 / 0 | Greenfield. Fingerprint injection (Idea 1) activates next CC session. |
| `memory_lifecycle` rows | 265 | Phase A is live and tracking. |
| Embeddings | OpenAI 1536 in `kb_vec` | **Precondition to confirm in code at B1 start**: every `bug` event has a vector. Documented, not yet line-verified. |

**Verdict:** build the right architecture; it sleeps until data grows. Better zero than anecdotes.

## 3. File map (every NEW code file ≤200 lines, one responsibility, mapped)

### B1 — cross-session clustering (deterministic, no LLM) — ✅ AS BUILT (2026-06-24)
- `src/core/kb/bug-similarity.ts` (104) — pure edge-weight: `w = α·cos(emb) + β·jaccard(entities) + γ·[caused/fixed-by]`.
- `src/core/kb/bug-embeddings.ts` (90) — `EmbeddingReader` type + `createKbVecEmbeddingReader(db, dims=1536)`
  + `fakeEmbeddingReader(map)`. **Single swap-point** for sqlite-vec alpha storage; key `event:<id>#0` (verified 11/11).
- `src/core/kb/union-find.ts` (44) — connected-components primitive.
- `src/core/kb/bug-cluster-graph.ts` (138) — PURE graph build + cluster emission (EVIDENCE_MIN/SESSION_MIN gate).
- `src/core/kb/bug-clusters.ts` (163) — DB I/O only: load bugs/relations/file-entities, inject reader, delegate to graph.
- DELETED the old intra-session `lessons-candidates.ts`. Embedding read is **dependency-injected** (tests pass a fake map).
- Verified: `npm run build:plugin` green; full suite 260 pass / 1 skip; anti-anecdote + cross-session + evidence_count tests green.

### B2 — trigger = Context Fingerprint (injection-ready)
- `src/core/kb/lesson-trigger.ts` *(new, ~110)* — pure: `FailureCluster → triggerFingerprint`
  (canonical JSON of union(files), union(error-signatures), dominant task_type). Reuses the Idea-1
  fingerprint shape (`context_fingerprints` columns). This becomes `lessons.trigger_pattern`.
- `src/core/kb/lesson-injection.ts` *(new, ~120)* — given a *current* situation fingerprint, return
  HEAD lessons whose trigger overlaps (file/error/task), ranked. Hook for the live proactive-injection
  path (`situation-injection.ts` / recall) — silent unless a match clears a relevance floor.
- MODIFY `lessons-runner.ts` — `trigger_pattern` now comes from `lesson-trigger` (deterministic),
  **not** from the distiller's free text.
- MODIFY `lessons-distiller.ts` — drop `trigger_pattern` from its output contract; the LLM only writes
  the human lesson (`domain`, `lesson_text`, `anti_patterns`, `confidence`). Prompt reviewed by
  lo-llm-architect before the cadence goes automatic.

**B2 carry-over from B1 (do NOT lose these — flagged in B1 review):**
- `errorSignatures` on `FailureCluster` is intentionally `[]` in B1 — **B2 must populate it** (it is the
  raw material for the trigger fingerprint, alongside `files`).
- **Distiller semantics bug:** `lessons-runner.ts toDistillable()` currently maps `bugTexts[0]`→bug and
  `bugTexts.slice(1)`→"fixes". In a cross-session cluster these are all **recurrences of the same
  failure, NOT fixes.** B2's distiller rework must feed the LLM "N recurrences of one failure" (+ the
  resolved fixes pulled from `fixed-by` relations), not bug-as-fix. Otherwise the LLM distills garbage.

### B3 — confidence on recurrence AND avoidance (the step beyond the paper)
- `src/core/kb/lesson-confidence.ts` *(new, ~90)* — pure: `confidence = f(evidence_count,
  distinct_sessions, avoidance_count, recency)`. Monotone-up on recurrence and on avoidance; gentle
  staleness decay (ties to Phase A). Clamp [0,1].
- `src/core/kb/lesson-feedback.ts` *(new, ~140)* — runs in consolidation: find lessons that **fired**
  (were injected) and check whether the *same domain* recurred afterward. No recurrence ⇒ +1 avoidance;
  recurrence ⇒ no avoidance credit (the lesson didn't save us). Requires recording "a lesson fired"
  (see §6).
- MODIFY `lessons-writer.ts` + `lessons-runner.ts` — fix evidence semantics (§5).

### Tooling / tests
- KEEP `tools/lessons-run.mts` (DRY default, `--write` to persist) — manual trials.
- Tests mirror each module 1:1 under `src/core/kb/__tests__/` (seeded temp DB, offline).

## 4. Data flow (one consolidation tick)

```
events + relations + kb_vec
        │  bug-clusters.selectFailureClusters(db)      ── B1, deterministic
        ▼
FailureCluster[]  (each: ≥N bugs, ≥M sessions, shared domain)
        │  for each new/grown cluster:
        ├─ lesson-trigger.fingerprint(cluster) ───────── B2 → triggerPattern
        ├─ distiller(cluster) ─────────────────────────── LLM → {domain, lessonText, antiPatterns}
        ├─ lesson-confidence(cluster, history) ────────── B3 → confidence
        └─ runner: accept-if-improves vs HEAD(trigger) ── writer.insert / supersede
        ▼
lessons (HEAD per trigger)
        │  on situation (PostToolUse / session start):
        ▼  lesson-injection.match(currentFingerprint) → surfaced UNBIDDEN
        │  later ticks:
        ▼  lesson-feedback: fired & no-recurrence → confidence++   ── B3 loop closed
```

## 5. evidence_count — the anecdote-killer (correctness fix)

Today `lessons-writer.ts:70` sets `evidence_count = evidenceEventIds.length || 1`, where
`evidenceEventIds` = bug + its fixes **in one session**. That counts *events in one incident*, which is
exactly an anecdote dressed up as evidence. **Fix:**
- `evidence_count` = number of **distinct bug events** in the cross-session cluster.
- A lesson is written **only if** `evidence_count ≥ EVIDENCE_MIN` **AND** `distinct_sessions ≥ SESSION_MIN`.
- `evidence_event_ids_json` stores the cluster's bug event ids (dedup key for the runner stays valid).

## 6. Recording "a lesson fired" (needed by B3)

When `lesson-injection` surfaces a lesson, log it so feedback can later judge avoidance. Reuse
`context_fingerprints.matched_owner_ids_json` (append the lesson id) — no new table if it fits.
Fallback: a tiny `lesson_fires(lesson_id, session_key, ts)` table (additive, IF NOT EXISTS) if the
fingerprint row isn't the right home. Decide at B3 implementation.

## 7. Starting parameters (tunable; NOT asking Lorenzo — tuned on a KB-derived eval set)

| Param | Start | Why this start |
|---|---|---|
| `EVIDENCE_MIN` (distinct bugs) | 2 | Blueprint Fase 4 test says "after 3 similar failures"; start at 2 to bloom on sparse data, raise as data grows. |
| `SESSION_MIN` (distinct sessions) | 2 | Cross-session is the whole point — 1 session can never qualify. |
| `α` semantic / `β` file-entity / `γ` relation | 0.6 / 0.3 / 0.1 | γ thin today (sparse graph) — honest; rises as relations densify. |
| `τ` edge threshold | tuned on real KB | Picked so an i18n bug never links a payment fix (the old version's garbage). |

## 8. Confidence model (B3)

`confidence` rises with `evidence_count`, with `distinct_sessions`, and with `avoidance_count`
(successful avoidances), and decays gently with staleness (delegated to Phase A's lifecycle, not
recomputed here). Pure function, fully unit-tested for monotonicity and clamping. This is the
"learn from successes AND failures" the `lessons` schema comment already promises.

## 9. Error handling & invariants

- Every new module that touches I/O is best-effort and **never throws** on the consolidation path
  (matches `lessons-distiller.ts` and `foundations-schema.ts`).
- Immutability: pure functions return new objects; no mutation of loaded rows.
- `events` append-only and `facts` no-delete invariants untouched — we only write to `lessons`
  (+ optional `lesson_fires`) and read everything else.

## 10. Testing (TDD, offline, the RED comes first)

1. **Anti-anecdote guard (the headline test):** seed an i18n bug and a payment bug+fix in the SAME
   session → assert they **never** cluster. The old `lessons-candidates.ts` failed exactly here.
2. **Cross-session gate:** 2 semantically-similar bugs in 2 sessions → one cluster, `evidence_count=2`,
   `distinct_sessions=2`. Same 2 bugs in 1 session → **no** cluster.
3. **Trigger determinism:** same cluster → identical trigger fingerprint, every run.
4. **Confidence monotonicity:** more evidence / more avoidances ⇒ never-decreasing confidence.
5. **Feedback loop:** lesson fired + no same-domain recurrence ⇒ `avoidance_count` increments.
6. **accept-if-improves:** new lesson supersedes HEAD only when its eval-set score is higher.
7. Reuse the 20 held tests where still valid; rewrite the candidate tests for the cross-session axis.

## 11. Eval set (for accept-if-improves)

Built **by me** from the live KB's real bug/fix history (held-out), **not** requested from Lorenzo.
It replaces "v1 score = confidence" (`lessons-runner.ts:101`) with a measured score.

## 12. Build & verify (live)

`npm run build:plugin` (NOT full `npm run build` — broken at `build:scripts`) → stop/start gateway →
`/health` green → manual `tools/lessons-run.mts` DRY (expect ~0 lessons today, by design) → only then "done".

## 13. Open knobs deferred to implementation (flagged, not hidden)

- The exact "no-recurrence" attribution window in `lesson-feedback` (§6).
- Whether `kb-vec-read.ts` is new or an existing reader suffices (§3).
- Where "lesson fired" is recorded (fingerprint column vs `lesson_fires` table) (§6).
- Final `τ`, `α/β/γ`, `EVIDENCE_MIN` after eval-set tuning (§7).

## 14. Build order (slices)

1. **B1** — `bug-similarity` + `bug-clusters` (rewrite) + tests. Deterministic core. Yields ~0 today.
2. **B2** — `lesson-trigger` + runner/distiller changes + `lesson-injection` + tests. Injection-ready.
3. **B3** — evidence fix + `lesson-confidence` + `lesson-feedback` + tests. Closes the avoidance loop.
4. Wire the consolidation cadence + manual DRY trial. Commit per slice (local branch only — never upstream).
