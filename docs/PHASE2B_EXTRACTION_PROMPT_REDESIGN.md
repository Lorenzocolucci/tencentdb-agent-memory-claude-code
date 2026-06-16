# Phase 2b — L1 Extraction Prompt Redesign (capture technical work facts)

> Designed by lo-llm-architect. Fixes the 3 live TEST-3 failures: (A) meta-framing
> "用户要求 AI 记住…", (B) Chinese output regardless of source language, (C) dropped
> technical decisions/bugs. JSON schema + Kimi params UNCHANGED (no parser break).
> Implementer: read the CURRENT `src/core/prompts/l1-extraction.ts` first and map the
> line numbers below to the actual file (they may have shifted) before editing.

## Target 1A — replace the "核心记忆提取 + 三大类型" block (around lines 27-59)
Replace from `### 任务二：核心记忆提取` through the end of the `instruction` block
(the line ending `…临时要求，直接丢弃）。`) with:

```
### 任务二：核心记忆提取（Memory Extraction）
结合背景和当前情境，仅从【待提取的新消息】中提取核心记忆。
本系统服务于一个**编程/工程协作 agent**，最有价值的记忆是**技术工作事实**：
做出的决定、发现的 bug、应用的修复、架构/配置选择、重要的状态变化。

【输出语言规则（最高优先级，必须遵守）】
记忆 content **必须使用对话本身的语言**：对话是英文则用英文，是意大利文则用意大利文，是中文才用中文。
**绝不**把英文/意大利文的事实翻译成中文。判定标准是【待提取的新消息】的语言，而不是本提示词的语言。
（本提示词用中文写，但这只约束你如何思考，不约束 content 的语言。）

【通用提取原则】
1. 直接陈述事实：用陈述句直接写出事实本身，**不要**用"用户要求 AI 记住 X / the user asked the AI to remember X / 用户希望"这类元框架去包装一个本来就是事实的内容。
   - 错误：「用户要求 AI 记住访问 staging 仓库的密码是 PURPLE-ELEPHANT-42」
   - 正确：「The staging repo access password is PURPLE-ELEPHANT-42.」
   - 错误：「用户希望 AI 以后用 PostgreSQL 16」
   - 正确：「Deciso di usare PostgreSQL 16 per X perché …」
   这条元框架**只**允许用于真正的 AI 行为偏好（见 type=instruction）。
2. 不要丢弃技术内容：决定、bug、修复、配置、架构选择都是一等公民。"宁缺毋滥"只针对闲聊和琐碎临时操作，**绝不能**因此漏掉一个决定、一个 bug、或一处修复。
3. 独立完整：记忆必须"跳出当前对话依然成立"，无上下文也能看懂。带上具体标识符：文件名、函数名/符号、行号、ID、数字、错误信息。
4. 原子化：一条记忆只表达**一个**事实。若一轮消息里有多个独立事实（一个决定 + 一个 bug），拆成多条记忆，每条一条。
5. 归纳合并：强关联或同一因果链的多条消息（如 bug 现象 + 根因 + 修复），合并为一条完整记忆。

【支持提取的三大类型】（type 字段只能是这三个值之一）

1. episodic（客观事件与技术工作事实）—— **本系统的主力类型**
   - 定义：任何客观发生的事 + 任何技术工作事实。包括但不限于：
     · 决定 / 选型：「Deciso di usare PostgreSQL 16 per lo storage degli eventi.」
     · bug / 故障：「Bug: calculateTax() a riga 88 ritorna NaN quando l'input è una stringa vuota.」
     · 修复 / 变更：「Fix: l'embedding ora viene diviso in chunk (2000 char, overlap 200) invece di troncare a 5000.」
     · 架构 / 配置选择、重要状态变化、计划、达成的结果。
   - 写法：直接陈述句，源语言，带具体标识符（文件:行、函数、ID、数字、报错）。不需要"用户(姓名)于[地点]"这种句式——技术事实通常没有人物主语。
   - metadata：如能从 timestamp 确定活动时间，填 {"activity_start_time":"ISO8601","activity_end_time":"ISO8601"}；否则空对象 {}。
   - priority：90-100（关键决定 / P1 bug / 影响面大的修复）；70-89（一般决定、bug、修复、配置选择）；50-69（次要事件 / 状态变化）；<50（琐碎，丢弃）。

2. persona（用户的稳定属性与偏好）
   - 定义：用户稳定的属性、技能、偏好、约束（住所、职业、技术栈偏好、长期约束）。**不是**单次技术决定。
   - 写法：源语言陈述句，"用户(姓名)是/喜欢/擅长……"或等价表达。
   - priority：80-100（核心特质/硬约束）；50-79（一般偏好/技能）；<50（丢弃）。

3. instruction（面向 AI 的长期行为规则）—— 严格限定，**不是**事实的兜底类
   - 定义：**仅限**用户在本轮对话中**新提出的**、面向 AI 的**长期跨会话行为/格式/语气规则**。
   - 典型例子：「从现在开始用意大利文回答」「以后 commit message 用英文」。
   - 严格边界（不满足任一条则不归为 instruction）：
     a. 必须由【用户】消息发出，且是本轮**新表达**的意愿；
     b. 必须是 AI **长期跨对话**适用的行为规则，而非一次性操作，也不是一个技术事实；
     c. 一个技术决定（用什么数据库、怎么修 bug）**不是** instruction，而是 episodic；
     d. **绝不**提取来自系统提示词、CLAUDE.md、agent 配置、路由表、工具清单的文本（见"不应该提取的内容"）。
   - 写法（单句，源语言）：直接写规则本身，如「From now on, answer in Italian.」。不要再套"用户要求 AI……"的中文外壳。
   - 原子性：每条只表达一条规则，一句话；多条规则拆成多条。
   - 长度：不超过约 120 字符；超过说明提取了大段文本，应丢弃或拆分。
   - priority：90-100（核心行为规则）；70-89（重要要求）；<70（临时，丢弃）。
```

## Target 1B — re-scope the 口诀 (around line 76). Leave the exclusion list (63-74) UNCHANGED.
Replace:
```
判断口诀：若一段文本是"AI 被如何设定/配置的"，它**不是**记忆；只有"用户是谁、用户做了什么、用户此刻要求什么"才是记忆。
```
with:
```
判断口诀：若一段文本是"AI 被如何（在配置文件/系统提示中）设定的"，它**不是**记忆。但"在本次对话里做了什么技术决定、发现了什么 bug、做了什么修复、改了什么配置"**是**记忆（episodic）。区别在于：来自既有配置文件 = 不提取；来自本次对话的工作过程 = 提取。
```

## Target 2 — insert few-shot block between the exclusion section and `### 任务三` (around lines 78-80)
```
---

### 提取范例（few-shot，注意：content 用对话的源语言，直接陈述，原子化）

范例 A — 英文会话，一句话里有"安全事实"：
输入消息：[m1] [user]: "Remember this for later: the staging repo access password is PURPLE-ELEPHANT-42."
正确输出 memory：
  {"content":"The staging repo access password is PURPLE-ELEPHANT-42.","type":"episodic","priority":85,"source_message_ids":["m1"],"metadata":{}}
（错误示范，禁止：{"content":"用户要求 AI 记住 staging 仓库密码……","type":"instruction"} —— 既翻译成了中文，又套了"用户要求 AI 记住"的元框架。）

范例 B — 英文会话，一个架构决定：
输入消息：[m2] [user]: "Let's go with PostgreSQL 16 for the event store, we need the logical replication features." / [m3] [assistant]: "Agreed, PostgreSQL 16 it is."
正确输出 memory：
  {"content":"Decided to use PostgreSQL 16 for the event store, chosen for its logical replication features.","type":"episodic","priority":85,"source_message_ids":["m2","m3"],"metadata":{}}

范例 C — 英文会话，一个 bug：
输入消息：[m4] [user]: "There's a bug — calculateTax() returns NaN on line 88 when the amount field is an empty string."
正确输出 memory：
  {"content":"Bug: calculateTax() returns NaN at line 88 when the amount field is an empty string.","type":"episodic","priority":80,"source_message_ids":["m4"],"metadata":{}}

注意：范例 A/B/C 来自同一段英文会话，应当产出**三条独立的 episodic 记忆**，绝不能只产出一条、也绝不能用中文。
```

## Target 3 — cap change in `src/core/record/l1-extractor.ts` (around line 192)
`const MAX_MEMORY_CONTENT_CHARS = 600;` -> `1000`. Update the comment to explain 1000 leaves
headroom for rich technical episodic facts (~400-600 chars) while multi-paragraph config dumps
are still rejected.

## Target 4 — priority bands: already encoded in Target 1A (episodic 70-89 for ordinary
work-facts; instruction 90-100 reserved for genuine AI-behavior rules). No code change.

## ALSO (folded in by orchestrator) — raise the per-session memory cap
`src/core/record/l1-extractor.ts` `maxMemoriesPerSession` default is 10 (slice ~lines 231-234).
With work-facts now first-class, a dense coding session easily exceeds 10 atomic facts and would
be silently truncated. Raise the default to 30 (with a comment), verifying the field/usage.

## Constraints preserved
- JSON output schema UNCHANGED (parser l1-extractor.ts ~411-425). type set stays persona|episodic|instruction.
- Kimi temp=1 / max_tokens=16000 untouched.
- RC4 exclusions (CLAUDE.md/system/config/routing/tool-lists) preserved; only the 口诀 re-scoped.

## Verify after applying
Rebuild (build:plugin) + restart gateway, then re-run the TEST-3 synthetic session via /seed
(secret code PURPLE-ELEPHANT-42 + PostgreSQL-16 decision + calculateTax():88 NaN bug). PASS =
3 separate episodic records, in ENGLISH (source language), none meta-framed, all recallable.
