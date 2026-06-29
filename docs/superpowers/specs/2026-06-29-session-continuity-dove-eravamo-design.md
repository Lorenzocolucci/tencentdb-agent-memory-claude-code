# Design — "Dove eravamo" (session-continuity reawakening)

**Date:** 2026-06-29
**Status:** Approved (design), pending implementation plan
**Author:** Socio (with Lorenzo)
**Roadmap slot:** Sinapsys point #1 (see memory card `sinapsys-roadmap`)

---

## 1. Problem

When a new session opens on a project we worked on before, the agent does **not** reconstruct *where we left off* — neither the open thread nor the explicit next step. The associative layer works (recall runs every turn: persona + scenes + KB hits), but **session-to-session task continuity has no injection path**. The "next step" lives only in hand-written `docs/HANDOFF-*.md` files, which recall never reads. Diagnosed and verified 2026-06-26 (see memory card `sinapsys-session-continuity-gap`).

The naive fix — "inject the latest handoff doc" — is **lookup, not reconstruction**, and violates the north star. Continuity must be **reconstructed from the KB**, as a first-class memory atom, and surfaced situation-shaped.

## 2. Goal & success criteria

Reawaken the agent into the *scene*, not just hand it a reminder. On session open, the agent surfaces a "Dove eravamo" block for the current project containing:

- **Facts** (rock-solid, taken not interpreted): branch, commits made last session, files touched, the explicit next step.
- **The thread** (anchored): the decisions and *why* — pulled as near-quotes from what was actually said, each carrying provenance to its source message. Never free abstraction.

**Chosen approach: B — "Facts + the real sentences"** (decided with Lorenzo 2026-06-29). The user's binding constraint: **every line must be anchored** to something that actually happened (a commit, a file, a confirmed decision). No confidently-wrong summaries. This rules out an abstractive LLM distiller (the known "wrong dates" failure mode, ref `agent-features-circular-tests`).

**Success is measured non-circularly:** existing handoff docs (`HANDOFF-2026-06-24-trackB.md`, `-25`, `-26`) are the ground-truth of the real "next steps". The captured recap's next-step is checked against them. Labels are independent of the scorer.

## 3. Non-goals (YAGNI)

- **Semantic / cross-session recap matching** ("reawaken similar scenes from other moments") — deferred. The MVP retrieval is deterministic (latest recap for project+branch) and needs **no embeddings**, so this feature ships *before* the reindex. Cross-project association is already Context Fingerprint's job (live) — we do **not** duplicate it.
- Multi-session merge / summarization of many past recaps — out of scope.
- Editing or garbage-collecting old recaps beyond normal consolidation/decay.

## 4. Architecture

Two halves, reusing existing foundations (append-only `events`, `handleSessionEnd`, the `performAutoRecall` stable-injection surface, `escapeXmlTags`).

### Half 1 — Capture (session end)

Hook point: `tdai-core.ts` `handleSessionEnd(sessionKey)` (currently flushes the pipeline + runs `scheduleConsolidation`). Add a recap step that is **fire-and-forget, error-swallowed, off the critical path** (identical discipline to `scheduleConsolidation`): a failure must never break session-end.

The recap is stored as a **first-class `KbEvent`** (NOT a doc):
- `type: "session_recap"`
- `project`: current project
- `text`: the structured recap (see §5)
- `entities`: include a branch tag (e.g. `branch:<name>`) so retrieval can filter by branch (the `KbEvent` schema has `project` but no `branch` column — branch is carried in `entities` + the text header)
- `source_message_ids`: union of the provenance of every "thread" line included
- high salience (so consolidation reinforces, not decays, it)

**Facts** are deterministic:
- branch, commits-this-session, files-touched — from git.
- next step — explicitly authored at session end (deliberate, not inferred).

**The thread** is *extractive, not abstractive*: reuse the decision/choice `KbEvent`s the extraction pipeline **already produced for this session** (filter this session's events to decision-like types), each of which already carries `source_message_ids`. We select and quote them; we do not re-summarize. This is what makes "every line anchored" true by construction.

### Half 2 — Injection (session open)

Hook point: `auto-recall.ts` `performAutoRecall`, in the `stableParts` assembly (alongside persona / scene-navigation / principles), **gated to the first turn of a session** like the session-open banner (once per session, not every turn).

- **Retrieval:** most-recent `session_recap` event for the current `project` (+ matching branch tag when available), via `listRecentEvents` filtered by type+project. Deterministic; no embeddings.
- **Render:** a `<session-recap>` block — a "Dove eravamo" header, then the **Facts** section, then the **Thread** section explicitly labelled as reconstructed-from-your-words with its anchors.
- **Safety:** content escaped via `escapeXmlTags`; `session-recap` added to the allow-list in `sanitize.ts` (same pattern as `cornerstone-memories`). Wrapped in try/catch → returns `""` on any error.

## 5. Recap text format (the atom's `text`)

```
DOVE ERAVAMO — <project> @ <branch> (<session date>)

FATTI:
- Commit: <hash> <subject>            [anchor: git]
- File toccati: <path>, <path>        [anchor: git]
- Prossimo passo: <explicit next step>

FILO (ricostruito dalle nostre parole reali):
- <decision/why, near-quote>          [anchor: msg <source_message_id>]
- <discarded option + reason>         [anchor: msg <source_message_id>]
```

Every line ends with an anchor. A line with no valid anchor is **omitted** rather than guessed.

## 6. Components (small files, one purpose each)

| File | Purpose | Depends on |
|------|---------|-----------|
| `src/core/continuity/recap-builder.ts` | Pure: assemble recap text from {git facts, next-step, selected decision-events}. Testable in isolation. | types only |
| `src/core/continuity/recap-capture.ts` | Session-end glue: gather inputs, build, insert `KbEvent`. Fire-and-forget, error-swallowed. | store, recap-builder |
| `src/core/continuity/recap-retrieval.ts` | Fetch most-recent recap for project(+branch). | store |
| `src/core/continuity/recap-injection.ts` | Format the `<session-recap>` block (mirror of `cornerstone-injection.ts`). | sanitize |
| wiring | `tdai-core.ts` handleSessionEnd (capture) + `auto-recall.ts` (inject, session-open-gated) | above |
| `src/utils/sanitize.ts` | add `session-recap` to `escapeXmlTags` allow-list | — |

## 7. Open technical question (to resolve in the plan)

**How does the gateway learn the git facts?** The commits/files/branch belong to the Claude Code session's working directory (cwd), which the **cc-plugin side** knows, not the long-lived gateway. Two candidate resolutions for the plan:
1. The cc-plugin `SessionEnd` hook gathers git facts (it has cwd) and passes them to the gateway in the `/session/end` payload.
2. The gateway is told the repo path per session and runs git itself.

Option 1 is preferred (keeps git access where cwd is authoritative; gateway stays repo-agnostic), but the exact payload extension is a plan-level decision.

## 8. Error handling & invariants

- Capture and injection are both **off the critical path**: any error is logged and swallowed; memory never breaks the conversation.
- **Immutable**: builders return new strings/objects; events are append-only.
- **No secrets**: recap text passes through the existing secret-redaction before storage (same path as other events) — verify in the plan.
- **No anchor → no line.** Determinism over completeness.

## 9. Testing

- Unit: `recap-builder` produces correct anchored text from fixture inputs; omits unanchored lines.
- Unit: `recap-injection` escapes boundary tags; empty input → `""`.
- Integration: capture→retrieve round-trip on a real store; injection gated to first turn only.
- **Non-circular eval:** feed real past sessions; compare the builder's extracted next-step against the hand-written `HANDOFF-*.md` next-steps as independent ground truth.

## 10. Sequencing

Ships now as Sinapsys point #1, *before* the reindex (point #3), because MVP retrieval is deterministic. Semantic recap-matching is a later enhancement once embeddings are reindexed.
