# TencentDB Memory — Entity-Centric Core Redesign (Blueprint)

> Goal: make the memory EXCELLENT (llm-wiki style), evolving in place on the existing stack
> (Windows/ARM64, Claude Code gateway, SQLite+vec0+FTS5, OpenAI 3-small embeddings, Kimi extraction).
> Eliminates the 3 structural failure causes: 5 serial LLM stages, LLM-destructive dedup, flat-fact store.
> Approved direction: entity-centric, evolutionary. Track A #1 (embedding resilience) already shipped (commit b96590e).

## Owner decisions on open questions (decided to keep momentum)
1. **Namespace**: v1 single global store; `project` stored as a column/tag on entities+events (derived from session cwd/session_key). Cross-project recall is the DEFAULT; project filtering optional later.
2. **Rerank**: implement behind config flag `recall.rerank`, DEFAULT OFF in Phase 4. Baseline = calibrated RRF + recency/importance reweight. Enable Kimi list-rerank (fail-open, tight timeout) only if eval shows material gain. Local cross-encoder = Phase 7 upgrade behind the same interface.
3. **Persona allow-list** (attributes that project into persona.md): identity/role, languages, OS+stack+tooling preferences, process/working-style rules, active projects, credential-LOCATIONS (never secret values).
4. **L1 retire**: keep l1_records/l1_vec/l1_fts READ-ONLY for one release (rollback), then physical drop.
5. **L0 completeness**: check empirically in Phase 3 migration; if a session's L0 was pruned, use the `l1_records → observation events` fallback for that session.
6. **Provenance**: persist source_message_ids (events.source_message_ids_json).

## Data model (new tables in the SAME vectors.db; L0 tables untouched; L1 tables read-only then retired)

```sql
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,                 -- "ent_"+sha1(namespace|type|canonical_key)[:16]
  type TEXT NOT NULL,                  -- person|project|library|file|decision|bug|preference|concept
  name TEXT NOT NULL,                  -- display name, source language
  canonical_key TEXT NOT NULL,         -- normalized dedup key (NFKC, lowercased, type-normalized)
  namespace TEXT NOT NULL DEFAULT 'default',
  project TEXT NOT NULL DEFAULT '',     -- tag (cross-project recall by default)
  language TEXT NOT NULL DEFAULT 'und',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 50,
  created_time TEXT NOT NULL, updated_time TEXT NOT NULL,
  UNIQUE(namespace, type, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_ent_ns_type ON entities(namespace, type);
CREATE INDEX IF NOT EXISTS idx_ent_canonical ON entities(namespace, canonical_key);
CREATE INDEX IF NOT EXISTS idx_ent_updated ON entities(updated_time);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,                 -- "fact_"+ulid
  entity_id TEXT NOT NULL,
  attribute TEXT NOT NULL,             -- snake_case, language-neutral key
  value TEXT NOT NULL,                 -- source-language value
  language TEXT NOT NULL DEFAULT 'und',
  valid_from TEXT NOT NULL,            -- world-time true-from
  valid_to TEXT,                       -- world-time true-until; NULL = current
  learned_at TEXT NOT NULL,            -- learn-time recorded
  superseded_by TEXT,                  -- newer fact id; NULL = head
  superseded_at TEXT,
  source_event_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  support INTEGER NOT NULL DEFAULT 1,
  namespace TEXT NOT NULL DEFAULT 'default',
  created_time TEXT NOT NULL
);
-- HEAD fact = (entity_id, attribute) WHERE superseded_by IS NULL AND valid_to IS NULL.
CREATE INDEX IF NOT EXISTS idx_facts_head ON facts(entity_id, attribute, superseded_by);
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_ns_attr ON facts(namespace, attribute);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,                 -- "evt_"+ulid (time-sortable)
  ts TEXT NOT NULL, recorded_at TEXT NOT NULL,
  session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
  namespace TEXT NOT NULL DEFAULT 'default', project TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,                  -- decision|bug|fix|config_change|observation|preference_stated|...
  text TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'und',
  entities_json TEXT NOT NULL DEFAULT '[]',
  source_message_ids_json TEXT NOT NULL DEFAULT '[]'
);                                     -- APPEND-ONLY, never updated/deleted
CREATE INDEX IF NOT EXISTS idx_evt_session ON events(session_key, ts);
CREATE INDEX IF NOT EXISTS idx_evt_ns_ts ON events(namespace, ts);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,                 -- "rel_"+sha1(ns|src|type|dst)[:16]
  src_entity_id TEXT NOT NULL, type TEXT NOT NULL, dst_entity_id TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  valid_from TEXT NOT NULL, valid_to TEXT,
  support INTEGER NOT NULL DEFAULT 1, source_event_id TEXT, created_time TEXT NOT NULL,
  UNIQUE(namespace, src_entity_id, type, dst_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_src ON relations(src_entity_id, type);
CREATE INDEX IF NOT EXISTS idx_rel_dst ON relations(dst_entity_id, type);

-- recall surfaces (replace l1_vec/l1_fts); chunked like the existing l1_vec pattern
CREATE VIRTUAL TABLE IF NOT EXISTS kb_vec USING vec0(
  chunk_id TEXT PRIMARY KEY, owner_id TEXT partition key, owner_kind TEXT,
  embedding float[1536] distance_metric=cosine, updated_time TEXT DEFAULT '');
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  content, content_original UNINDEXED, owner_id UNINDEXED, owner_kind UNINDEXED,
  entity_type UNINDEXED, namespace UNINDEXED, attribute UNINDEXED, updated_time UNINDEXED);
```
Embedded for recall: one vector per entity-page (chunked), one per HEAD fact ("{name} — {attribute}: {value}"), one per event text. Reuse Float32Array→Buffer, tokenizeForFts, buildFtsQuery, bm25RankToScore.

## Single extraction stage (replaces extract+dedup+scene+persona)
One Kimi call per ≤10-msg window (keep the MemoryPipelineManager cadence) → JSON `KbDelta`:
`{language, entities:[{ref,type,name,aliases,language}], facts:[{entity_ref,attribute,value,valid_from?,confidence,source_event_ref?}], events:[{ref,type,ts,text,entity_refs,source_message_ids}], relations:[{src_ref,type,dst_ref}]}`
Validate with Zod (`src/core/kb/extraction-schema.ts`); on schema failure return success:false (cursor holds — existing fail-closed contract). Prompt text = lo-llm-architect later.

### Entity resolution (deterministic, no LLM)
canonical_key = `${type}:${NFKC-lower-trim(name)}` with type-specific norm (file=posix path; library=strip version; person=as-is). resolve: exact (ns,type,canonical_key) → else alias match → else create (id=sha1). Near-dup reconciliation = lint job (never destructive at write).

### Deterministic upsert (replaces batchDedup + deleteL1Batch — NO LLM, NO delete)
Per window, in one TX: insert events (append-only); resolve/create entities; for each fact, find HEAD (entity,attribute): none→insert; same value→support++, max confidence; different value→ if newer world-time supersede head (set valid_to+superseded_by, insert new head), if older insert as closed historical row. Relations upsert by UNIQUE. Recompute entity.importance (support+recency). Embeds after commit (existing deferred bgTask pattern).

## Projections (deterministic, no tool-calling LLM) — src/core/kb/projections.ts
- `renderEntityPage(entityId, locale)` → markdown (Facts current / History / Related [[links]] / Timeline), cached under kb/<id>.md, regenerated when applyKbDelta touches the entity. Index = kb/index.md.
- L2 scene = `projectScenes()` grouping recent events by dominant entity/community → feeds scene_index + generateSceneNavigation (renderers kept, input is now the projection). REMOVE scene-extractor + prompt + L2 tool runner.
- L3 persona = `projectPersona()` over person/preference entities + allow-list attributes → persona.md (escapeXmlTags). REMOVE persona-generator + prompt + L3 tool runner.
Facts keep source language; projections render in active locale.

## Retrieval — src/core/kb/retrieval.ts (called by auto-recall.ts + tools/memory-search.ts)
Parallel: FTS(kb_fts)+vector(kb_vec)+entity-name-match → RRF(k=60, reuse formula) collapse by owner → recency+importance reweight → rerank(fail-open, flag-gated) → calibrate to 0-1 (NEVER show raw RRF) → progressive disclosure (compact index injected; full page via read_file/tdai_memory_search on demand). Behind `recall.source: "kb"|"l1"` flag (default l1 until eval gate passes).

## Migration (Phase 3) — re-extract from L0 (intact, immutable)
Backup vectors.db first. Create new tables (additive). Page ALL l0_conversations by (session_key, recorded_at ASC) in windows of 10 → new extractor → applyKbDelta (reuse queryL0GroupedBySessionId + cursor). Embed during apply. Project scenes+persona once. Verify via eval harness (gate: 4 original targets recall ≥ expected). Cut recall to kb_*; keep l1_* read-only. Idempotent (deterministic ids). Rollback = flag flip + .bak restore.

## Phased roadmap (each shippable + TDD + eval-gated)
- **P0** eval harness FIRST: fixed fact-set (FABLE_PLAN/IBAN/booking/chunking + supersession/contradiction/multilingual/relation canaries), metrics (precision@k, recall@k, MRR, gold cosine, supersession-correctness), JSON scorecard + pass/fail gate. Runs red until kb exists.
- **P1** schema + store methods (additive, no behavior change) — sqlite.ts initSchema + kb-queries.ts + types.ts; supersession invariant tests.
- **P2** single extraction + deterministic merge — rewrite l1-extractor to emit KbDelta + kb-writer.applyKbDelta; remove batchDedup/deleteL1Batch from write path; deprecate l1-dedup.
- **P3** migration tool (re-extract from L0) + extend reindexAll to kb tables.
- **P4** retrieval (RRF+reweight+rerank+calibration) behind recall.source flag; eval must meet/beat l1 baseline.
- **P5** deterministic L2/L3 projections; remove scene-extractor + persona-generator + their prompts + tool wiring.
- **P6** cutover (recall.source=kb default) + retire L1 + maintenance (lint/decay/caps, non-destructive) .
- **P7** (opt) local cross-encoder rerank + eval-as-CI + per-namespace metrics.

## Files (per phase): src/core/store/sqlite.ts, store/types.ts, new src/core/kb/{kb-queries,kb-writer,extraction-schema,resolution,projections,retrieval,rerank,maintenance}.ts, src/core/record/l1-extractor.ts (rewrite), src/core/hooks/auto-recall.ts, src/core/tools/memory-search.ts, src/gateway/server.ts, src/utils/pipeline-factory.ts, src/core/tdai-core.ts; REMOVE src/core/scene/scene-extractor.ts, src/core/persona/persona-generator.ts, src/core/prompts/{scene-extraction,persona-generation,l1-dedup}.ts.
