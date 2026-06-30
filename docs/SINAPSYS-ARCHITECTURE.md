# Sinapsys — Architecture Map

> **What it is.** Sinapsys is **associative long-term memory for AI agents**. Not a
> vector database you query — a graph where one memory *triggers* another and the
> relevant memories *come to the agent unbidden* (proactive injection). Reconstruction,
> not lookup. It runs as a local sidecar (the "gateway") that any agent host talks to
> over HTTP, with a 100% local SQLite + `sqlite-vec` store.
>
> This document is the source-grounded map of the whole system: every subsystem, who
> does what, the data model, the request flows, and the six original ideas mapped to
> code. Generated from the real tree (not memory).
>
> **Scale (measured):** 160 source files · ~44,600 LOC · 86 test files · 585 tests.
> **Status:** all six pillars built, wired, and live; full suite green except 7
> pre-existing Windows-only daemon/hook env failures.

---

## Legend

| Symbol | Meaning |
| :-- | :-- |
| 🧠 | A "pillar" — one of the original ideas that make Sinapsys distinctive |
| ⚙️ | Infrastructure / plumbing (storage, gateway, adapters) |
| 📥 | Capture path (writing memory) |
| 📤 | Recall path (reading / injecting memory) |
| 🔬 | Pure module (no I/O, deterministic, unit-tested in isolation) |
| 🗄️ | Owns or writes a DB table |
| 🤖 | Calls an LLM |
| **Phase A–E** | Foundations build phases (Consolidation → Lessons → Fingerprints → Spreading → local embeddings) |
| **L0–L5** | The memory layers (raw → structured → persona → procedural → consolidated → injected) |

---

## The memory layers (L0 → L5)

Sinapsys is a **Complementary Learning Systems** design: a fast episodic store and a
slow semantic/procedural store that consolidate over time, like hippocampus + neocortex.

| Layer | What lives there | Where |
| :-- | :-- | :-- |
| **L0** | Raw conversation messages (append-only JSONL + `l0_vec`) | `core/conversation`, `core/record` |
| **L1** | Structured memories extracted from L0 (facts/events) | `core/record`, `core/kb` |
| **L2/L3** | Persona + procedural memory (who the user is; lessons) | `core/persona`, `core/kb/lessons-*` |
| **L4** | Consolidated state (reinforcement, decay, promotion) | `core/kb/consolidation-*`, `lifecycle-*` |
| **L5** | What actually gets injected into the agent each turn | `core/hooks`, `core/distinctiveness`, `core/continuity` |

---

## Directory tree (annotated)

```
src/
├── index.ts ……………………………… ⚙️ plugin entry: registers hooks + agent tools
├── gateway/ ………………………………… ⚙️ HTTP sidecar daemon (the process agents talk to)
│   ├── server.ts ……………………… routes /capture /recall /observe /session/end …
│   ├── recall-context.ts ……… composes the single injected `context` string
│   ├── config.ts · types.ts · cli.ts
├── adapters/ ……………………………… ⚙️ host-neutral bridge (one core, many hosts)
│   ├── openclaw/ ………………………… OpenClaw plugin API ↔ TDAI Core
│   └── standalone/ ……………………… Gateway/Hermes sidecar ↔ TDAI Core (Vercel AI SDK runner)
├── core/
│   ├── tdai-core.ts ………………… ⚙️ THE ORCHESTRATOR — owns the lifecycle hooks
│   ├── kb/ (31 files) ……………… 🧠 the entity-centric brain (graph + ideas)
│   ├── store/ (10 files) ……… ⚙️ storage abstraction (SQLite+sqlite-vec / Tencent VDB)
│   ├── hooks/ (11 files) ……… 📤 capture + recall + proactive injection
│   ├── distinctiveness/ (7) … 🧠 Idea 5 (cornerstone / von Restorff)
│   ├── continuity/ (6) ………… "Dove eravamo" session continuity
│   ├── record/ · conversation/  📥 L0/L1 capture + extraction
│   ├── scene/ · persona/ · profile/  L2/L3 projections of who the user is
│   ├── prompts/ · seed/ · tools/ · report/
├── offload/ (17 files) ……… ⚙️ context-window offload (token tracking, state)
├── cli/ ……………………………………… reindex, chat-export backfill, maintenance
└── utils/ (15 files) ………… redaction, sanitization, secrets, shared helpers
```

---

## Subsystem reference — who does what

### 🧠 `core/kb` — the entity-centric brain (the heart)
The graph: **entities** (people, projects, files, concepts) with **facts** and **events**
hanging off them, linked by **relations**. The six ideas live here.

| File | Role |
| :-- | :-- |
| `kb-extractor.ts` 🤖 | Turn one conversation window into a validated `KbDelta` |
| `extraction-schema.ts` 🔬 | The KbDelta shape (zod) |
| `kb-writer.ts` 🗄️ | Apply a KbDelta deterministically (entities/facts/events/relations) |
| `kb-queries.ts` 🗄️ | The read data layer (HEAD facts, events, relations, entity pages) |
| `retrieval.ts` 📤 | The recall read path: FTS + vector + RRF → calibrate → **prime** → cut |
| **`provenance.ts`** 🧠🔬 | Trust model (Grounded Trust P1): every memory's origin + trust + gate state |
| **`stakes.ts`** 🧠🔬 | Grounded Trust P2: the "consequential action" gate (payment/credential/…) |
| **`grounded-trust-ask.ts`** 🧠🔬 | Grounded Trust P3: renders the INTERRUPT that asks Lorenzo |
| **`spreading-activation.ts`** 🧠🔬 | The associative core: weighted, decaying, converging activation |
| **`implicit-priming.ts`** 🧠🔬 | Idea 2: sub-threshold memories re-rank connected ones (invisible) |
| `lifecycle-writer.ts` 🗄️ | The "living" state of each memory (reinforcement, tier, gate, provenance) |
| `lifecycle-decay.ts` 🔬 | The "forget the noise" half of consolidation |
| `consolidation-runner.ts` · `consolidation-scheduler.ts` | Phase A "sleep-time" pass (reinforce + decay + promote) |
| `memory-audit.ts` 🗄️ | Append-only trail of every automatic mutation (self-evolution without corruption) |
| `fingerprint-writer.ts` 🗄️ | Idea 1: persist the situation signature of a moment |
| **Mistake Notebook (Idea 3):** | |
| `bug-clusters.ts` · `bug-similarity.ts` · `bug-embeddings.ts` · `bug-cluster-graph.ts` · `union-find.ts` 🔬 | Cross-session failure clustering (B1) — semantic, never anecdotal |
| `lesson-trigger.ts` · `error-signature-extractor.ts` 🔬 | B2a: the trigger = a Context Fingerprint of the failure |
| `lessons-distiller.ts` 🤖 | Turn a recurring cluster into a generalizable lesson |
| `lessons-runner.ts` · `lessons-runner-db.ts` | Orchestrate clusters → trigger → distill → write (idempotent) |
| `lessons-writer.ts` 🗄️ | Versioned lessons (supersede-if-improves) + B3 exposure/avoidance |
| **`lesson-reinforcement.ts`** 🧠🔬 | B3: confidence grows on successful AVOIDANCE (beyond the paper) |
| `projections.ts` · `projections-writer.ts` 🔬🗄️ | Deterministic render of the persona/scene docs from the KB |
| `foundations-schema.ts` 🗄️ | The structural schema (all the tables below) |

### ⚙️ `core/store` — storage abstraction
| File | Role |
| :-- | :-- |
| `types.ts` | `IMemoryStore` — the interface every backend implements |
| `sqlite.ts` 🗄️ | Default backend: SQLite + `sqlite-vec` (100% local, no cloud) |
| `tcvdb.ts` · `tcvdb-client.ts` | Optional Tencent Cloud VectorDB backend |
| `embedding.ts` | Text → vector (OpenAI `text-embedding-3-small`, 1536-d) |
| `bm25-local.ts` · `bm25-client.ts` | Sparse keyword vectors (hybrid recall) |
| `chunking.ts` · `search-utils.ts` · `factory.ts` | Long-text chunking, shared search, backend selection |

### 📤 `core/hooks` — capture, recall, proactive injection
| File | Role |
| :-- | :-- |
| `auto-capture.ts` 📥 | Record each turn to L0 |
| `auto-recall.ts` 📤 | The per-turn recall: assemble + inject relevant memory + persona |
| `situation.ts` · `situation-injection.ts` 🧠 | Track A 3+4: observe the touched file → surface what memory knows |
| `session-situation.ts` · `fingerprint-similarity.ts` · `fingerprint-injection.ts` 🧠 | Idea 1 (Context Fingerprint): match the *situation*, inject cross-session |
| `task-type.ts` 🔬 | Deterministic task-type inference for the fingerprint |
| `session-banner.ts` | The "🧠 Sul pezzo" proof-of-memory banner at session open |
| `principles.ts` | Inject per-project binding principles |
| `recall-display.ts` | The templates for everything injected |

### 🧠 `core/distinctiveness` — Idea 5 (Distinctive / von Restorff)
`term-rarity.ts` (IDF) + `isolation-scorer.ts` (von Restorff) + `distinctiveness-scorer.ts`
→ `cornerstone-selector/runner/cache/injection.ts`: surface the rare, peak memories that
human memory resurfaces unbidden — computed once/session, cached off the critical path.

### `core/continuity` — "Dove eravamo"
`recap-selector → recap-builder → recap-capture` (session end) and `recap-retrieval →
recap-injection` (session open): a first-class `session_recap` so a new session knows
exactly where the last one stopped.

### 📥 `core/record` + `core/conversation`
`l0-recorder.ts` (raw JSONL) → `l1-extractor.ts` 🤖 → `l1-dedup.ts` (conflict handling) →
`l1-writer.ts`/`l1-reader.ts`. The capture pipeline that feeds the KB.

### `core/persona` · `core/scene` · `core/profile`
Project the KB into human-readable "who the user is" docs (persona.md, scene blocks,
navigation) — deterministically, so the injected identity never drifts or lies.

### ⚙️ `core/tools` — agent-callable tools
`memory-search.ts`, `conversation-search.ts`, plus the Grounded Trust + B3 tools
registered in `index.ts`: `tdai_memory_search`, `tdai_conversation_search`,
`tdai_confirm_memory`, `tdai_reject_memory`, `tdai_lesson_helped`.

### ⚙️ `gateway` + `adapters`
The gateway is a long-lived local HTTP daemon; the adapters keep TDAI Core
host-neutral (OpenClaw plugin **or** standalone sidecar) — one core, many hosts. This
is the seam that makes Sinapsys embeddable in any agent runtime.

### ⚙️ `offload`
Context-window offload: token tracking, per-session state, MMD injection, reclaiming
stale data. Keeps long agent sessions within the model's context budget.

---

## Data model (10 tables)

| Table | Holds | Written by |
| :-- | :-- | :-- |
| `entities` | Graph nodes (people/projects/files/concepts) | `kb-writer` |
| `facts` | Versioned attributes of an entity (HEAD = valid_to NULL) | `kb-writer` |
| `events` | Time-stamped happenings, with `entities_json` (co-occurrence) | `kb-writer` |
| `relations` | Weighted edges between entities (`support`, `weight`) | `kb-writer` |
| `memory_lifecycle` | Living state: reinforcement, tier, **provenance + gate** | `lifecycle-writer` |
| `lessons` | Mistake Notebook: versioned lessons + **exposure/avoidance** | `lessons-writer` |
| `context_fingerprints` | Idea 1: situation signatures (files/errors/task) | `fingerprint-writer` |
| `memory_audit` | Append-only trail of every automatic mutation | `memory-audit` |
| `embedding_meta` | Embedding provider/model/dim bookkeeping | `sqlite` |
| `l0_vec / kb_vec / kb_fts / l1_vec` | Vector + FTS shadow tables (sqlite-vec / FTS5) | `sqlite` |

---

## Request flows (the live HTTP API)

| Endpoint | What happens |
| :-- | :-- |
| `POST /capture` 📥 | Record a turn to L0 (+ scheduled L1 extraction) |
| `POST /recall` 📤 | FTS+vector+RRF → calibrate → **implicit priming** re-rank → cut → **spreading activation** appends associatives → **grounded-trust** gates high-stakes → compose `context` |
| `POST /observe` 🧠 | PostToolUse: fold the touched file into the session situation; surface file memory + cross-session fingerprint matches; record lesson exposure |
| `POST /session/end` | Flush + 4 deferred bg tasks: consolidation, recap, lesson distillation, B3 avoidance crediting |
| `GET /health` | Liveness |
| `/recall-context`, `/session-filter` | Internal compose/scope helpers |

---

## The six pillars → code

| Pillar | Idea | Core files | Status |
| :-- | :-- | :-- | :-- |
| **Context Fingerprint** | 1 | `session-situation`, `fingerprint-*`, `task-type`, `fingerprint-writer` | live |
| **Implicit Priming** | 2 | `implicit-priming`, `spreading-activation`, `candidateAdjacency` | live |
| **Mistake Notebook** | 3 | `bug-*`, `lessons-*`, `lesson-trigger`, `lesson-reinforcement` (B1+B2+B3) | live (dormant until a failure recurs) |
| **Proactive Injection** | 4 | `auto-recall`, `situation-injection`, `recall-display`, `session-banner` | live |
| **Distinctive Terms** | 5 | `distinctiveness/*` (cornerstone) | live |
| **Grounded Trust** | 6 | `provenance`, `stakes`, `grounded-trust-ask`, lifecycle gate | live |
| *(heart)* | — | **`spreading-activation`** — the graph that triggers one memory from another | live |

---

## Portability — from "perfect for us" to "perfect for anyone"

Honest map of what is portable today vs coupled to the current setup (the work the
product version must do). **No claim is made that the coupled items work elsewhere —
they are unverified off Windows-ARM.**

| Concern | Today | For a product |
| :-- | :-- | :-- |
| **OS** | Verified on Windows 11 ARM64 | Must verify Linux / macOS / Windows x64; CI matrix |
| **Native dep** | `sqlite-vec` via Node `node:sqlite` (experimental) | Pin/bundle per-platform prebuilds; fallback path |
| **Embeddings** | OpenAI `text-embedding-3-small` (network + key) | Local ONNX option (Phase E, 100% TODO) for privacy/offline |
| **Gateway** | Local supervised process, port 8421, token auth | Installer/daemon per OS; managed/cloud option |
| **Host** | OpenClaw + standalone adapters | Document the adapter contract; SDKs for other runtimes |
| **Config** | Single-user, local paths | Multi-user/workspace; secret management |
| **Timestamps** | Some China-Standard-Time assumptions (offload) | Normalize to UTC end-to-end |

---

## Test coverage

585 tests across 86 files. Pure modules (🔬) are unit-tested in isolation; store
methods are tested against a real SQLite. 7 failures are pre-existing
Windows-environment daemon/hook mock issues, not Sinapsys logic.

> This map is the documentation foundation for the product/SaaS effort: it defines
> precisely *what* Sinapsys is before we position *who* it is for.
