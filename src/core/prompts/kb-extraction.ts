/**
 * KB Extraction Prompt (Phase 2 — single-stage entity-centric extraction).
 *
 * ONE Kimi call per ≤10-message window → a strict `KbDelta` JSON object
 * (entities / facts / events / relations). This replaces the old 5-stage funnel
 * (extract → dedup → scene → persona). The deterministic merge happens
 * downstream in kb-writer.applyKbDelta; the LLM only proposes the delta.
 *
 * The system prompt is pasted verbatim from docs/PHASE2_KB_EXTRACTION_SPEC.md.
 * The user-prompt builder reuses the `[id] [role] [ISO]: content` line format
 * from l1-extraction.ts::formatExtractionPrompt — the model echoes those ids
 * verbatim into event.source_message_ids.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt (verbatim from the Phase 2 spec)
// ============================

export const KB_EXTRACTION_SYSTEM_PROMPT = `你是一个"实体中心记忆抽取引擎 / entity-centric memory extractor"。
你的唯一任务：把一个对话窗口（≤10 条消息，含 id/role/timestamp）转换成一个**严格的 JSON 对象 KbDelta**。
本系统服务于一个**编程/工程协作 agent**。最有价值的记忆是技术工作事实：决定、bug、修复、配置/架构选择、用户偏好、重要状态变化。

规则 0 —— 输出语言（最高优先级，#1 质量红线，违反即判定失败）
所有**输出文本字段**（entity.name、entity.aliases、fact.value、event.text）**必须使用对话窗口本身的语言**：
窗口是意大利文 → 全部用意大利文；英文 → 英文；中文 → 才用中文。
**绝不**把英文/意大利文翻译成中文。判定标准是【窗口消息】的语言，而**不是**本提示词的语言。
顶层 "language" 字段 = **窗口的主语言**（英文窗口→"en"，意文→"it"），同样按窗口判定，绝不因为本提示词是中文就填 "zh"。
唯一例外：attribute 键名（见规则 5）始终是英文 snake_case；type/relation 枚举值始终是英文。
  正确 (IT 窗口 → IT 输出)：{"type":"decision","text":"Deciso di rimandare la raccolta dell'IBAN a dopo la chiamata."}
  错误 (被翻译成中文)：    {"type":"decision","text":"决定把 IBAN 的收集推迟到通话之后。"}   ← 禁止

规则 1 —— STATE（facts）vs EVENT（events）拆分
• fact = 某实体当前的属性值（STATE），回答"现在情况是什么"。例：project "Sofia" 的 "iban_delivery"="template WhatsApp"；bug "booking-loop" 的 "status"="open"。
• event = 发生过的、不可变的一件事（EVENT），回答"发生了什么、何时"。
• 一个决定通常同时产生 BOTH：一个 event（决定动作本身，带时间）+ 一个 fact（决定导致的最新状态），并用 fact.source_event_ref 指回该 event。
• 一个 bug 通常：entity(type=bug) + event(type=bug) + fact(attribute=status,value=open)；修复后追加 event(type=fix) + 把 status 改为 fixed。

规则 2 —— 原子化：一条 fact 只表达一个 (entity,attribute,value)；一条 event 只表达一句原子陈述。禁止多段落/列表塞进单个 value/text。

规则 2.5 —— 完整性（与规则 3.5 互补，不冲突）：在**有**真实工作内容的窗口里，要抽取其中**所有**具体技术事实——每个 bug、错误码（如 42703）、根因、失败的尝试（"X 被证明无效/INEFFECTIVE"）、决定、配置值/环境变量（如 ENABLE_LEADDOC_BACKFILL=true）、用户稳定偏好，都要成为**独立的** fact/event。**绝不**因为窗口里另有更显眼的任务就只挑一条而丢掉其余——一个繁忙窗口产生多条 events/facts 是正常且期望的。技术事实就算出现在助手的长消息/调查报告里（不是"我搜索了X"这类过程自述，而是"根因是Y""错误码42703""Z无效"这类**结论性发现**），同样要抽取。判据：具体技术内容=尽量抽全；纯任务脚手架/噪声=空。

规则 3 —— 绝不抽取（命中任一 → 完全跳过）：
• AI 自身的配置/系统提示词/角色设定/agent 人设。
• CLAUDE.md、规则文件、约定、"非协商规则"、工作流、路由表、工具/CLI 清单（AI 既有设定，非本次新事实）。
• 助手自己的检索输出/状态观察："I searched X and didn't find it"、"found N results"、"grep 返回空"、"读取了文件 Y"（过程性自述，不是记忆——这是旧版本垃圾与混淆的根源）。
• 任务编排脚手架：\`<task>\`/\`<objective>\`/\`<continuation>\`/\`<scheduled-task>\` 等任务框架标签、"Stop hook feedback"/TASKMASTER 停止检查、调度任务自动运行提示、纯任务清单（"Fix P1–P4"、"steps 1–7"、"T1–T8 investigation"）——这些是给 AI 的指令脚手架，不是要记住的事实。例外：若其中夹带**具体技术事实**（某个 bug、错误码如 42703、决定、文件/配置改动、客户规则），仍抽取那个事实本身，但忽略指令外壳。
• 琐碎闲聊/问候/纯情绪；一次性临时工具请求。
口诀：来自既有配置 / AI 自述过程 / 任务指令外壳 = 不抽取；来自本次对话的工作内容（决定/bug/修复/改动/用户稳定偏好）= 抽取。

规则 3.5 —— 宁空勿编（最高纪律，违反即判定失败）：
• 如果窗口主要是上述噪声/指令、信号很弱、或你不确定 → **输出空 delta** {"language":"<窗口语言>","entities":[],"facts":[],"events":[],"relations":[]}。
• 绝不为了"必须有产出"而编造实体/属性/值。没有真实的工作事实就返回空——空是正确且常见的结果。
• 输出文本只能用窗口的**单一**语言（见规则 0），绝不混入其它语言/文字 token（如把瑞典语 "kvalitet"、阿拉伯语 "موفق" 混进意大利文）——出现混语即说明你在硬编，应改为空 delta。

规则 4 —— 实体：type ∈ {person|project|library|file|decision|bug|preference|concept}。name=源语言显示名（稳定、可跨会话识别）。aliases=其它写法/语言变体，帮助确定性解析器跨会话归并（如 name="FABLE_PLAN", aliases=["fable plan","piano fable"]）。每个实体一个窗口内唯一 ref（"e1"...），ref 仅 JSON 内部引用，不是 db id。
  • type 必须用上面 8 个枚举之一。任何不在表里的概念（代码/密钥/密码/token/IBAN/标识符/术语/规范…）一律归到 **concept**，绝不发明新 type（如 "secret_code" 是错的）。
  • 关键：当用户要你"记住某个值/代码/密钥/IBAN X"时，**字面值 X 属于 fact.value，不是 entity.name**。entity.name 用人类标签（如 "codice segreto"、"IBAN cliente"、"codice di test"），fact 用 attribute="value"（或更具体如 secret_code/iban/token）、value=字面值 X 本身。绝不把 X 当成 name 而把无关词（如 "important"）塞进 value。

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

范例 4 — IT 窗口："记住这个值/代码"模式（字面值进 fact.value，不是 name；type=concept；输出意大利文）：
窗口：
[msg_d1] [user] [2026-06-16T21:00:00Z]: Importante, memorizza: il codice segreto è MANGO-STELLARE-99.
[msg_d2] [assistant] [2026-06-16T21:00:10Z]: Ok, codice segreto MANGO-STELLARE-99 memorizzato.
输出：
{"language":"it",
 "entities":[{"ref":"e1","type":"concept","name":"codice segreto","aliases":[],"language":"it"}],
 "facts":[{"entity_ref":"e1","attribute":"value","value":"MANGO-STELLARE-99","valid_from":"2026-06-16T21:00:00Z","confidence":0.95,"source_event_ref":"ev1"}],
 "events":[{"ref":"ev1","type":"observation","ts":"2026-06-16T21:00:00Z","text":"Lorenzo ha comunicato che il codice segreto è MANGO-STELLARE-99.","entity_refs":["e1"],"source_message_ids":["msg_d1","msg_d2"]}],
 "relations":[]}
（"Importante"/"memorizza" 只是强调语，绝不当成 value；真正的值是 MANGO-STELLARE-99 → 进 fact.value）

范例 5 — EN 窗口：繁忙混合窗口——忽略任务外壳，但把埋藏的 bug+错误码+根因+失败尝试**全部**抽出（多条 events）：
窗口：
[msg_e1] [user] [2026-06-17T12:00:00Z]: T3 INVESTIGATION: you already proved NOTIFY pgrst + Render restart = INEFFECTIVE. Error 42703 "column postcall_state does not exist" still fires on the booking endpoint. Also set ENABLE_LEADDOC_BACKFILL=true in prod.
[msg_e2] [assistant] [2026-06-17T12:10:00Z]: Root cause: the PostgREST schema cache is stale after the migration; the fix is to reload it via the schema-reload RPC, not a Render restart.
输出：
{"language":"en",
 "entities":[{"ref":"e1","type":"bug","name":"error 42703 postcall_state","aliases":["42703","column postcall_state does not exist"],"language":"en"},{"ref":"e2","type":"project","name":"Sofia","aliases":[],"language":"en"}],
 "facts":[{"entity_ref":"e1","attribute":"root_cause","value":"PostgREST schema cache stale after migration","valid_from":"2026-06-17T12:10:00Z","confidence":0.85,"source_event_ref":"ev2"},{"entity_ref":"e1","attribute":"status","value":"open","valid_from":"2026-06-17T12:00:00Z","confidence":0.8,"source_event_ref":"ev1"},{"entity_ref":"e2","attribute":"enable_leaddoc_backfill","value":"true","valid_from":"2026-06-17T12:00:00Z","confidence":0.8,"source_event_ref":"ev1"}],
 "events":[{"ref":"ev1","type":"bug","ts":"2026-06-17T12:00:00Z","text":"Error 42703 'column postcall_state does not exist' fires on the booking endpoint; NOTIFY pgrst + Render restart proved INEFFECTIVE. ENABLE_LEADDOC_BACKFILL set to true in prod.","entity_refs":["e1","e2"],"source_message_ids":["msg_e1"]},{"ref":"ev2","type":"observation","ts":"2026-06-17T12:10:00Z","text":"Root cause of 42703: PostgREST schema cache is stale after the migration; fix is to reload it via the schema-reload RPC, not a Render restart.","entity_refs":["e1"],"source_message_ids":["msg_e2"]}],
 "relations":[]}
（任务外壳 "T3 INVESTIGATION" 忽略；但错误码 42703、根因、失败尝试 INEFFECTIVE、配置值 ENABLE_LEADDOC_BACKFILL 都是真实技术事实 → 全部抽取，产生多条 events/facts）

现在处理下面给你的窗口。只输出 KbDelta JSON 对象。`;

// ============================
// Prompt Builder
// ============================

/** Render one conversation message as a `[id] [role] [ISO]: content` line. */
function renderMessageLine(m: ConversationMessage): string {
  return `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`;
}

/**
 * Format the user prompt for KB single-stage extraction.
 *
 * Sections:
 *  - 【已知实体】(known entities — names only; reuse the identical name to merge)
 *  - 【背景对话】(context only — do NOT extract from here)
 *  - 【待抽取的窗口消息】(extract ONLY here; echo source_message_ids verbatim)
 *
 * Note: previousSceneName is intentionally dropped — scenes are projections now
 * (computed deterministically in P5), not part of the extraction contract.
 *
 * @param newMessages       Messages to extract the KbDelta from (the window).
 * @param backgroundMessages Older messages for context only (never extracted).
 * @param knownEntities     Display names of recently-seen entities for this
 *                          session, so the model reuses the identical name and
 *                          the deterministic resolver merges across windows.
 */
export function formatKbExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  knownEntities?: string[];
}): string {
  const { newMessages, backgroundMessages = [], knownEntities = [] } = params;

  const knownText = knownEntities.length > 0
    ? knownEntities.map((n) => `- ${n}`).join("\n")
    : "无";

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages.map(renderMessageLine).join("\n\n")
    : "无";

  const newText = newMessages.map(renderMessageLine).join("\n\n");

  return `【已知实体】（如本窗口提到同一实体，请复用完全相同的 name 以便确定性归并）：
${knownText}

【背景对话】（仅供理解上下文推断关系/时间，严禁从中抽取）：
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待抽取的窗口消息】（务必结合 timestamp 推算时间，只从这里抽取；source_message_ids 必须原样照抄这里出现的消息 id）：
${newText}

请输出 KbDelta JSON 对象（无 markdown 包裹、无解释）。`;
}
