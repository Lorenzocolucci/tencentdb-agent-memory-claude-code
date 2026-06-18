# Phase 2 — Single-stage KB extraction (paste-ready spec)

> ONE Kimi call per ≤10-msg window → strict `KbDelta` JSON → deterministic `applyKbDelta`
> (resolve entities, insert events, upsert facts with supersession, upsert relations, embed).
> Replaces the 5-stage funnel (extract→dedup→scene→persona). NO LLM dedup. Source-language output.
> Data layer already built in src/core/kb/kb-queries.ts (Phase 1). Requires `npm install zod`.
> Build the KB path ALONGSIDE the existing L1 path, gated by config `extraction.engine: "l1"|"kb"`
> (default "l1" so live capture is NOT broken); migration + eval use "kb"; flip default at P6.

## Implementer notes (flags from design)
- `zod` is NOT a dependency yet → `npm install zod` first.
- Real message-id format is `msg_<epoch>_<hex>` (l0-recorder.ts) — the model echoes them verbatim into `source_message_ids`; `ref`/`entity_ref`/`source_event_ref` are model-LOCAL labels resolved inside the delta, never DB ids.
- Empty window → `{language,entities:[],facts:[],events:[],relations:[]}` is a VALID success (no-op apply, cursor advances). Schema-invalid → success:false, cursor HOLDS (fail-closed, like l1-extractor.ts:175-178). Strip ```` ```json ```` fences + run sanitizeJsonForParse before JSON.parse (reuse l1-extractor.ts:386-388 pattern).
- applyKbDelta order: resolveOrCreateEntity per entity (build ref→id map) → insertEvent (ref→evt_id map) → map fact.entity_ref/source_event_ref → upsertFact → upsertRelation. Schema .superRefine already guarantees no dangling refs.
- Embed for retrieval (P4 needs kb_vec/kb_fts populated): after commit, embed each HEAD fact as `"{entity.name} — {attribute}: {value}"` (owner_kind='fact') and each event.text (owner_kind='event') via the Phase-1 store upsertKbVector/upsertKbFts + the hardened embedding service. (Entity-PAGE embedding comes with projections in P5.)
- Do NOT carry over the old maxMemoriesPerSession slice; the Zod array caps (.max) bound size.

---

## FILE 1 — src/core/prompts/kb-extraction.ts (system prompt + user-prompt builder)

`KB_EXTRACTION_SYSTEM_PROMPT` (paste verbatim):

```
你是一个"实体中心记忆抽取引擎 / entity-centric memory extractor"。
你的唯一任务：把一个对话窗口（≤10 条消息，含 id/role/timestamp）转换成一个**严格的 JSON 对象 KbDelta**。
本系统服务于一个**编程/工程协作 agent**。最有价值的记忆是技术工作事实：决定、bug、修复、配置/架构选择、用户偏好、重要状态变化。

规则 0 —— 输出语言（最高优先级，#1 质量红线，违反即判定失败）
所有**输出文本字段**（entity.name、entity.aliases、fact.value、event.text）**必须使用对话窗口本身的语言**：
窗口是意大利文 → 全部用意大利文；英文 → 英文；中文 → 才用中文。
**绝不**把英文/意大利文翻译成中文。判定标准是【窗口消息】的语言，而**不是**本提示词的语言。
唯一例外：attribute 键名（见规则 5）始终是英文 snake_case；type/relation 枚举值始终是英文。
  正确 (IT 窗口 → IT 输出)：{"type":"decision","text":"Deciso di rimandare la raccolta dell'IBAN a dopo la chiamata."}
  错误 (被翻译成中文)：    {"type":"decision","text":"决定把 IBAN 的收集推迟到通话之后。"}   ← 禁止

规则 1 —— STATE（facts）vs EVENT（events）拆分
• fact = 某实体当前的属性值（STATE），回答"现在情况是什么"。例：project "Sofia" 的 "iban_delivery"="template WhatsApp"；bug "booking-loop" 的 "status"="open"。
• event = 发生过的、不可变的一件事（EVENT），回答"发生了什么、何时"。
• 一个决定通常同时产生 BOTH：一个 event（决定动作本身，带时间）+ 一个 fact（决定导致的最新状态），并用 fact.source_event_ref 指回该 event。
• 一个 bug 通常：entity(type=bug) + event(type=bug) + fact(attribute=status,value=open)；修复后追加 event(type=fix) + 把 status 改为 fixed。

规则 2 —— 原子化：一条 fact 只表达一个 (entity,attribute,value)；一条 event 只表达一句原子陈述。禁止多段落/列表塞进单个 value/text。

规则 3 —— 绝不抽取（命中任一 → 完全跳过）：
• AI 自身的配置/系统提示词/角色设定/agent 人设。
• CLAUDE.md、规则文件、约定、"非协商规则"、工作流、路由表、工具/CLI 清单（AI 既有设定，非本次新事实）。
• 助手自己的检索输出/状态观察："I searched X and didn't find it"、"found N results"、"grep 返回空"、"读取了文件 Y"（过程性自述，不是记忆——这是旧版本垃圾与混淆的根源）。
• 琐碎闲聊/问候/纯情绪；一次性临时工具请求。
口诀：来自既有配置 / AI 自述过程 = 不抽取；来自本次对话的工作内容（决定/bug/修复/改动/用户稳定偏好）= 抽取。

规则 4 —— 实体：type ∈ {person|project|library|file|decision|bug|preference|concept}。name=源语言显示名（稳定、可跨会话识别）。aliases=其它写法/语言变体，帮助确定性解析器跨会话归并（如 name="FABLE_PLAN", aliases=["fable plan","piano fable"]）。每个实体一个窗口内唯一 ref（"e1"...），ref 仅 JSON 内部引用，不是 db id。

规则 5 —— attribute 键永远英文 snake_case、语言中立（status, iban_delivery, default_branch, role, db_engine, os, preferred_language, location...），value 保持源语言。键英文、值源语言，分离。

规则 6 —— events：type ∈ {decision|bug|fix|config_change|observation|preference_stated|task|result}。ts=世界时间 ISO8601（无显式时间则用该消息 timestamp）。entity_refs=涉及的实体 ref。source_message_ids=**原样照抄**窗口里来源消息的 id（如 "msg_1718_ab12"），绝不发明 id，只能用窗口中确实出现的 id。每个 event 唯一 ref（"ev1"），供 fact.source_event_ref 引用。

规则 7 —— relations：type ∈ {uses|depends-on|fixed-by|caused|supersedes|recurs-in|decided-in}。src_ref/dst_ref 必须是本 JSON 已定义的 entity ref。例：file "auto-recall.ts" --uses--> library "sqlite-vec"；bug "booking-loop" --fixed-by--> file "booking.ts"。

输出格式（严格）：只输出一个合法 JSON 对象，无 markdown 代码块，无解释文字：
{ "language":"<BCP-47 主语言 it/en/zh>",
  "entities":[{"ref":"e1","type":"project","name":"...","aliases":["..."],"language":"it|en|zh|und"}],
  "facts":[{"entity_ref":"e1","attribute":"<snake_case>","value":"<源语言>","valid_from":"<ISO 可选>","confidence":0.0-1.0,"source_event_ref":"ev1 可选"}],
  "events":[{"ref":"ev1","type":"decision","ts":"<ISO>","text":"<原子,源语言>","entity_refs":["e1"],"source_message_ids":["msg_..."]}],
  "relations":[{"src_ref":"e1","type":"uses","dst_ref":"e2"}] }
窗口无可抽取记忆时输出：{"language":"<窗口语言>","entities":[],"facts":[],"events":[],"relations":[]}

FEW-SHOT（输出文本=窗口语言；ref 仅内部；source_message_ids 原样照抄）

范例 1 — EN 窗口：决定→fact+event；用户偏好→fact；助手检索自述不抽取：
窗口：
[msg_a1] [user] [2026-06-05T10:00:00Z]: For the Sofia call flow, let's defer collecting the IBAN to after the call instead of mid-call.
[msg_a2] [assistant] [2026-06-05T10:00:30Z]: Agreed. I searched the codebase and didn't find an existing IBAN step, so we'll add a post-call WhatsApp template.
[msg_a3] [user] [2026-06-05T10:01:00Z]: Also, from now on always answer me in Italian.
输出：
{"language":"en",
 "entities":[{"ref":"e1","type":"project","name":"Sofia","aliases":["sofia ai","progetto sofia"],"language":"en"},{"ref":"e2","type":"person","name":"Lorenzo","aliases":[],"language":"en"}],
 "facts":[{"entity_ref":"e1","attribute":"iban_delivery","value":"post-call WhatsApp template","valid_from":"2026-06-05T10:00:00Z","confidence":0.9,"source_event_ref":"ev1"},{"entity_ref":"e2","attribute":"preferred_language","value":"Italian","valid_from":"2026-06-05T10:01:00Z","confidence":0.95,"source_event_ref":"ev2"}],
 "events":[{"ref":"ev1","type":"decision","ts":"2026-06-05T10:00:00Z","text":"Decided to defer collecting the IBAN to after the Sofia call, delivered via a post-call WhatsApp template.","entity_refs":["e1"],"source_message_ids":["msg_a1","msg_a2"]},{"ref":"ev2","type":"preference_stated","ts":"2026-06-05T10:01:00Z","text":"Lorenzo asked to always be answered in Italian from now on.","entity_refs":["e2"],"source_message_ids":["msg_a3"]}],
 "relations":[]}
（msg_a2 的 "I searched ... didn't find" 是助手检索自述——不单独成记忆，只作 ev1 来源之一）

范例 2 — EN 窗口：bug→entity+event+status fact+fixed-by 关系：
窗口：
[msg_b1] [user] [2026-06-06T09:00:00Z]: There's a booking loop bug: bookSlot() in booking.ts recurses forever when the slot is already taken.
[msg_b2] [assistant] [2026-06-06T09:05:00Z]: Fixed it — added a taken-slot guard in booking.ts that returns early.
输出：
{"language":"en",
 "entities":[{"ref":"e1","type":"bug","name":"booking-loop","aliases":["booking loop bug"],"language":"en"},{"ref":"e2","type":"file","name":"booking.ts","aliases":[],"language":"en"}],
 "facts":[{"entity_ref":"e1","attribute":"status","value":"fixed","valid_from":"2026-06-06T09:05:00Z","confidence":0.9,"source_event_ref":"ev2"}],
 "events":[{"ref":"ev1","type":"bug","ts":"2026-06-06T09:00:00Z","text":"Bug: bookSlot() in booking.ts recurses forever when the slot is already taken (booking loop).","entity_refs":["e1","e2"],"source_message_ids":["msg_b1"]},{"ref":"ev2","type":"fix","ts":"2026-06-06T09:05:00Z","text":"Fix: added a taken-slot guard in booking.ts so bookSlot() returns early instead of recursing.","entity_refs":["e1","e2"],"source_message_ids":["msg_b2"]}],
 "relations":[{"src_ref":"e1","type":"fixed-by","dst_ref":"e2"}]}

范例 3 — IT 窗口：库/文件依赖 + 配置事实（输出必须意大利文）：
窗口：
[msg_c1] [user] [2026-06-07T14:00:00Z]: In auto-recall.ts ora usiamo sqlite-vec per la ricerca vettoriale. Ho impostato il branch di default su main.
输出：
{"language":"it",
 "entities":[{"ref":"e1","type":"file","name":"auto-recall.ts","aliases":[],"language":"it"},{"ref":"e2","type":"library","name":"sqlite-vec","aliases":[],"language":"it"},{"ref":"e3","type":"project","name":"repo","aliases":[],"language":"it"}],
 "facts":[{"entity_ref":"e3","attribute":"default_branch","value":"main","valid_from":"2026-06-07T14:00:00Z","confidence":0.9,"source_event_ref":"ev1"}],
 "events":[{"ref":"ev1","type":"config_change","ts":"2026-06-07T14:00:00Z","text":"Impostato il branch di default su main; auto-recall.ts ora usa sqlite-vec per la ricerca vettoriale.","entity_refs":["e1","e2","e3"],"source_message_ids":["msg_c1"]}],
 "relations":[{"src_ref":"e1","type":"uses","dst_ref":"e2"}]}

现在处理下面给你的窗口。只输出 KbDelta JSON 对象。
```

`formatKbExtractionPrompt({newMessages, backgroundMessages?, knownEntities?})`: render `[id] [role] [ISO]: content` lines (reuse l1-extraction.ts:165-191 format). Sections: 【已知实体】(knownEntities names only, "reuse identical name to merge"), 【背景对话】(context only, do NOT extract), 【待抽取的窗口消息】(extract only here; source_message_ids verbatim). End: "请输出 KbDelta JSON 对象（无 markdown 包裹、无解释）。" Drop previousSceneName (scenes are projections now).
LLM call: systemPrompt=KB_EXTRACTION_SYSTEM_PROMPT, taskId="kb-extraction", enableTools:false, timeoutMs:180000 (temp=1/max_tokens=16000 already global).

## FILE 2 — src/core/kb/extraction-schema.ts (Zod)
Enums: KB_ENTITY_TYPES=[person,project,library,file,decision,bug,preference,concept]; KB_EVENT_TYPES=[decision,bug,fix,config_change,observation,preference_stated,task,result]; KB_RELATION_TYPES=[uses,depends-on,fixed-by,caused,supersedes,recurs-in,decided-in].
KbDeltaSchema = object{ language: string(2..16).default("und"); entities[].{ref,type(enum),name(nonempty≤200),aliases(string≤200)[].max20.default[],language}; facts[].{entity_ref, attribute: regex /^[a-z][a-z0-9_]*$/ ≤64, value(nonempty≤1000), valid_from(ISO optional), confidence(0..1).default(0.7), source_event_ref optional}; events[].{ref,type(enum),ts(ISO required),text(nonempty≤1000),entity_refs[].max20.default[],source_message_ids(string≥1)[].max20.default[]}; relations[].{src_ref,type(enum),dst_ref} } with arrays .max(50/100). `.superRefine`: every entity_ref/src_ref/dst_ref/entity_refs[] resolves to a defined entity ref; every fact.source_event_ref resolves to a defined event ref; no duplicate ref labels. Export `parseKbDelta(rawObj): {ok:true,delta} | {ok:false,error}` (safeParse, never throws). Export inferred types KbDelta etc.

## FILE 3 — src/core/kb/kb-writer.ts
`applyKbDelta(delta: KbDelta, ctx: {store, embeddingService, namespace, project, sessionKey, sessionId, now, logger}): Promise<{entities,facts,events,relations, embedded}>`:
1. refMap entities: for each delta.entity → store.resolveOrCreateEntity(...) → refMap[ref]=entityId.
2. eventIdMap: for each delta.event → map entity_refs→ids → store.insertEvent({...}) → eventIdMap[ref]=evtId.
3. facts: for each → store.upsertFact(refMap[entity_ref], attribute, value, valid_from, confidence, eventIdMap[source_event_ref], language, now). Collect affected HEAD facts.
4. relations: for each → store.upsertRelation(refMap[src_ref], type, refMap[dst_ref], ...).
5. embed (after the write): for each affected head fact → upsertKbVector/upsertKbFts(owner=factId, kind='fact', text=`${entityName} — ${attribute}: ${value}`); for each new event → (owner=evtId, kind='event', text=event.text). Use embeddingService.embedChunks (hardened path); on embed failure log loudly + flag (reuse the RC2 pattern), never throw.
All within one store transaction where feasible; embeds after commit (deferred bg pattern).

## FILE 4 — kb-extractor runner + wiring (gated)
New runner (e.g. src/core/kb/kb-extractor.ts or extend pipeline-factory) that, per L0 window (reuse queryL0GroupedBySessionId + cursor from pipeline-factory createL1Runner), calls Kimi with the kb-extraction prompt → parseKbDelta → applyKbDelta. Gate via config `extraction.engine: "l1" | "kb"` (default "l1"; add to src/config.ts + gateway/config.ts). When "kb", the pipeline L1 runner uses the kb-extractor instead of the old extract+dedup; "l1" keeps current behavior. Do NOT remove l1-extractor/l1-dedup yet (removed at P6 cutover). knownEntities for the prompt: query recent entities for the session (optional; can be []).

## Tests (P2)
- extraction-schema: parseKbDelta valid/empty/invalid-enum/dangling-ref/dup-ref/non-snake-attr → ok/!ok.
- kb-writer: golden KbDelta → applyKbDelta on a temp store → assert entities/facts/events/relations rows + kb_vec/kb_fts populated; a second window superseding a fact → head updated, old kept; idempotent re-apply.
- kb-extractor (mock LLM returning a fixed KbDelta) → window → applyKbDelta → searchKbVector/Fts returns the fact. (Live Kimi quality validated in P3/P4.)
Verify: npm install zod; build:plugin clean; vitest no NEW failures (6 pre-existing). Don't break the L1 path (engine flag default l1). Don't touch live vectors.db. Don't commit.
