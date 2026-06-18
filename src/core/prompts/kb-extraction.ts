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
