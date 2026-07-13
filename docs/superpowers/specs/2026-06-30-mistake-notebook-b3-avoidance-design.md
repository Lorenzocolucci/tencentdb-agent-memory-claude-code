# Mistake Notebook B3 — confidence grows on successful avoidance

> Design + implementation, 2026-06-30 (Lorenzo & Socio).
> **Status: IMPLEMENTED + DEPLOYED LIVE 2026-06-30.** Commit 1372d44 on
> `feat/memory-excellence`. Migration applied live (4 columns on `lessons`), recall 200.
> Closes the last piece of the Mistake Notebook (Track B). Parent:
> `2026-06-24-track-b-mistake-notebook-design.md`.

## The idea (beyond the published MNL paper)

MNL grows a lesson's confidence when the failure RECURS (more evidence). Lorenzo's
original step: confidence should also grow when the lesson is **successfully
AVOIDED** — a lesson that keeps you out of trouble has earned trust, not just one
that has failed often.

## How an avoidance is credited (Lorenzo's B→A design — mirrors Grounded Trust)

Demand explicit proof while uncertain; trust inference once earned.
- **Phase B (young lesson, `avoidance_count < τ=3`):** credit ONLY on an EXPLICIT
  confirmation — the agent calls `tdai_lesson_helped(lesson_id)` after it followed a
  resurfaced ⚠️ lesson and the failure did not happen.
- **Phase A (mature lesson, `avoidance_count ≥ τ`):** credit IMPLICITLY at session
  end — if the lesson resurfaced this session and did NOT relapse, infer the avoidance.

The switch is automatic: each credited avoidance bumps `avoidance_count`, and crossing
τ flips the lesson from explicit to implicit. The threshold τ is the same trust idea as
the burned child: chiedi prova finché incerto, fidati dell'inferenza quando maturo.

## The signals (no guessing)

- **Exposure** = the lesson RESURFACED into a matching situation. This is exactly when
  `buildFileInjection` surfaces a ⚠️ lesson (B2b); it stamps `recordExposure`
  (`exposure_count++`, `last_exposed_session_id/at`). Best-effort, off the critical path.
- **Relapse** = a `bug` event THIS session whose entities intersect the lesson's
  `trigger_pattern.$.files`. Relapse → `temperOnRecurrence` (the lesson did not fully
  protect); no relapse → `creditAvoidance`.

## Confidence dynamics (`lesson-reinforcement.ts`, pure/total)

- `confidenceAfterAvoidance(c) = c + 0.25·(CAP − c)` — diminishing returns; first
  confirmations matter most; never exceeds CAP=0.99 (a lesson never becomes certainty).
- `confidenceAfterRecurrence(c) = c·(1 − 0.2)`, floored at 0.1 — one relapse tempers
  but never discredits.
- `phaseFor(avoidanceCount)` — explicit below τ, implicit at/above.

## Wiring

- `lessons-writer.ts`: recordExposure / creditAvoidance / temperOnRecurrence /
  queryLessonsExposedInSession + LessonRow extended.
- `sqlite.ts`: recordLessonExposure, creditLessonAvoidance (explicit),
  creditSessionAvoidances (implicit, session-scoped) — all best-effort.
- `tdai-core.ts`: confirmLessonHelped (tool path) + a 4th session-end bg task firing
  creditSessionAvoidances (fire-and-forget, drained on shutdown like the others).
- `index.ts`: tool `tdai_lesson_helped`.
- `situation-injection.ts`: exposure stamp at lesson surfacing.

## Testing

TDD: lesson-reinforcement (5, pure), lessons-reinforce (5, real-DB writer),
credit-session-avoidances (3, real-DB: credit on no-relapse, temper on relapse, skip
Phase-B). consolidation-wiring updated 3→4 bg tasks. Build green, 0 new regressions.

## Honest status

Built + deployed, but like the rest of the Mistake Notebook it cannot bloom until a
lesson EXISTS (today 0 — no recurring cross-session failure cluster, correct by
anti-anecdote design). The B3 machine is verified by tests; its organic effect waits on
the first distilled lesson.
