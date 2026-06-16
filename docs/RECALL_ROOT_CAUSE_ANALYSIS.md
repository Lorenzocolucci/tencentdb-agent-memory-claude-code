# Recall Quality — Root Cause Analysis (2026-06-16)

> Phase 1 deliverable. Produced from two independent investigations (data/recall-path
> forensics + pipeline-architecture audit), every claim backed by file:line or a query result.

## Symptom
Semantic recall returns 0/4 on specific-fact queries (FABLE_PLAN, IBAN template, booking
loop, embedding chunking). All four queries return the same generic `instruction` blob at
cosine similarity ~0.19.

## Verified root causes (ranked)

### RC1 — Destructive LLM merge collapses the searchable store (PRIMARY)
`src/core/record/l1-writer.ts:205-220` executes `vectorStore.deleteL1Batch(decision.target_ids)`
whenever the dedup LLM returns `action:"merge"`. The merge prompt
`src/core/prompts/l1-dedup.ts:19-20` explicitly authorizes **cross-type** and
**many-to-many** merges. The LLM judges unrelated facts as duplicates and they are
physically deleted.
- Evidence: `gateway.out.log` shows successive merges deleting distinct episodic facts
  (lines 161-176, 329-330, 468-469).
- DB forensics: `l1_records` = **5 rows, all `type=instruction`**, while `records/*.jsonl`
  on disk holds **193 records (149 instruction, 34 episodic, 10 persona)**. The real facts
  were extracted to disk but deleted from the searchable table.

### RC2 — Merge churn leaves survivors without vectors (PRIMARY)
DB forensics: `l1_vec` holds **1** vector row vs `l0_vec` 692. Only 1 of the 5 surviving
L1 records is vectorized (delete-then-insert churn never rebuilt the others). Every embedding
query therefore returns that single blob regardless of content.
- Live proof: 3 unrelated queries all returned the same record `b8de484d` at ~0.19.

### RC3 — Hybrid recall never applies a score threshold (SECONDARY)
`src/core/hooks/auto-recall.ts:512-516` receives `_threshold` but never uses it; ranking is
pure RRF (`:600-635`) with no recency, no priority weighting, no minimum-score gate.
(The single-strategy `searchByEmbedding` path filters at `:486`, but the default hybrid path
does not.)

### RC4 — CLAUDE.md / system context becomes priority-95 instruction memories (CONTRIBUTING)
The L1 prompt instruction band `src/core/prompts/l1-extraction.ts:49-53`
("以后都/从现在开始/记住/必须" → priority 90-100) is a near-perfect trigger for CLAUDE.md
rules text. Filtering is insufficient: `sanitize.ts` only strips plugin-injected tags, not
host SessionStart context / CLAUDE.md. The length guard (`sanitize.ts:140-143`) and the
prompt-injection guard (`:153`, `looksLikePromptInjection`) are commented out / dead. Priority
is never clamped (`l1-extractor.ts:191`, `l1-writer.ts:174`); there is no per-memory
content-length cap.

### RC5 — Kimi params cause silent truncation / memory loss (CONTRIBUTING)
`src/adapters/standalone/llm-runner.ts:216-236` never sets `temperature` (uses provider
default ~0.3, not the known-good 1). `max_tokens` defaults to **4096** (`config.ts:93`),
not 16000. Long L1 JSON gets truncated → `parseExtractionResult` returns `[]` (silent loss)
at `l1-extractor.ts:370`. Base URL is configurable and NOT CONFIRMED to point at Moonshot —
to verify against the live gateway env.

## NOT the cause (prompt hypotheses corrected)
- **Chunking fix is live and working.** `embedChunks`/`splitIntoChunks` are wired
  (`l1-writer.ts:241`, `embedding.ts:563-592`) and run in the active dist (built Jun 1,
  after the May 31 fix). Live log: `embedChunks: split 2804 chars into 2 chunk(s)`. The
  prompt's hypothesis that chunking was never deployed is FALSE.
- **Stale `tdai-mkt/plugin/` copy** (May 29) contains only the hook/daemon-client, not the
  engine; the engine runs from the repo dist. Irrelevant to recall quality (maintenance trap).

## Architecture clarification
- `src/core/` = the real memory pipeline. Only **L0** (raw conversation) and **L1** (atomic
  memories) become searchable rows in `vectors.db`. **L2** (`scene_blocks/*.md`) and **L3**
  (`persona.md`) are narrative FILES by design, not searchable rows.
- `src/offload/` = a SEPARATE context-offload pipeline (MMD diagrams), gated behind
  `offload.enabled=false`. Its L1/L1.5/L2 prompts are irrelevant to memory quality.

## Fix plan (→ phases 2-4)
1. Make merge CONSERVATIVE — prompt `l1-dedup.ts` + execution `l1-writer.ts`: never cross-type,
   never many-to-many, never delete distinct facts; prefer skip on uncertainty. (RC1)
2. Rebuild vectors for every survivor after any merge/update. (RC2)
3. Apply score threshold (0.3) + recency factor in the hybrid recall path. (RC3)
4. Filter CLAUDE.md/system context before L1; re-enable length + injection guards; cap
   per-memory length; clamp priority. (RC4)
5. Set Kimi temperature=1, max_tokens=16000; confirm base URL = Moonshot. (RC5)
6. Reprocess `records/*.jsonl` (193 facts) + lost June 9-16 transcripts through the FIXED
   pipeline to restore the deleted facts. (phase 4)
