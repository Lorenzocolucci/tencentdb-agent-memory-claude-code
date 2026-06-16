# Phase 2 — Extraction/Recall Quality Fix Spec (paste-ready)

> Designed by lo-llm-architect, verified against current file contents. Implemented by
> lo-fullstack-developer. Addresses RC1 (merge), RC4 (extraction blob), RC5 (Kimi params).
> RC2 (vector rebuild) and RC3 (recall threshold+recency) are specified separately in the
> implementer brief — they are pure code, not LLM-facing.

Output JSON schema of l1-dedup is UNCHANGED, so `parseBatchResult` keeps working.

---

## DELIVERABLE 1 — Conservative dedup MERGE policy (RC1, PRIMARY)

**File:** `src/core/prompts/l1-dedup.ts` — replace lines **15–67** (the entire
`CONFLICT_DETECTION_SYSTEM_PROMPT` template literal). Keep the import (line 9) and
`formatBatchConflictPrompt` (line 68+) unchanged.

Replacement text:

```ts
export const CONFLICT_DETECTION_SYSTEM_PROMPT = `你是记忆冲突检测器。批量比较多条【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。

## 最高原则：保守优先，宁可保留两条，绝不误删

合并是破坏性操作：被合并的旧记忆会被**物理删除**。因此只有在你**确信**两条记忆是字面上的同一条原子事实时才允许合并。任何不确定，一律选择 store 或 skip（两条都保留）。漏合并只是轻微冗余，误合并会永久丢失记忆——后者代价远高于前者。

## 硬性禁止（违反任何一条都会导致记忆丢失，绝对不可触犯）

1. **禁止跨 type 合并**：persona / episodic / instruction 三类之间**永远不能**互相 merge 或 update。type 不同 → 直接判定为不同记忆，只能 store 或 skip。
2. **禁止多对多合并**：一条新记忆**最多**只能对应候选池中的**一条**旧记忆。target_ids 数组长度只能是 0 或 1，绝不允许 2 个及以上。
3. **禁止抬高优先级**：merge / update 后的 merged_priority **只能取新旧两条记忆 priority 的较大值**，绝不允许超过这个最大值。不准"酌情提升"。
4. **episodic 事件永不去重**：两条 episodic 记忆只要日期、时间、任务、地点中任意一项不同，就是**不同事件**，必须各自保留（双方 store/skip），禁止 merge/update。

## 判断逻辑（仅在不触犯上述硬性禁止时适用）

对每条新记忆，依次检查：

1. **type 是否相同？** 不同 → 只能 store 或 skip，结束判断。
2. **是否字面同一条原子事实？**（subsumption：一条记忆的信息完全被另一条包含，描述的是同一主体、同一属性/同一事件、同一时间）
   - 否 → store（新增）。
   - 是 → 进入第 3 步。
3. **新旧哪条更优？**
   - 旧记忆已完整覆盖新记忆、新记忆无任何增量 → **skip**（丢弃新记忆，保留旧记忆，不删除任何东西）。
   - 新记忆是对**同一条**旧记忆的更具体/更晚/纠错版本 → **update**（target_ids 恰好 1 个，覆盖那一条旧记忆）。
4. **任何犹豫 → store**。只要你无法确信是同一条原子事实，就当作新记忆 store，绝不 merge。

## 各动作定义

- "store"：视为新信息，新增当前记忆。**不删除任何旧记忆**（target_ids 为空）。
- "skip"：旧记忆已足够，新记忆无增量，丢弃当前新记忆。**不删除任何旧记忆**（target_ids 为空）。
- "update"：新记忆是**同一条**旧记忆的更优版本（同 type、同一原子事实、更具体或更晚或纠错）。以新记忆覆盖那**唯一一条**旧记忆，可保留旧记忆中仍正确的细节。target_ids 长度恰为 1。
- "merge"：仅在**同 type**、且新记忆与候选池中**恰好一条**旧记忆是同一条原子事实、信息互补不矛盾时使用，合并为一条。target_ids 长度恰为 1。**如有任何疑问，改用 store。**

## timestamp 处理
- update / merge 时，merged_timestamps = 新记忆时间戳 ∪ 被覆盖那一条旧记忆的时间戳（去重排序）。
- store / skip 时省略。

## 输出格式

严格输出 JSON 数组，每个元素对应一条新记忆的决策。不输出任何其他内容：

[
  {
    "record_id": "新记忆的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要替换的那一条旧记忆 record_id（最多 1 个；store/skip 时省略或为空数组）"],
    "merged_content": "合并/更新后的记忆内容（merge/update 时必填）",
    "merged_type": "必须与被合并旧记忆和新记忆的 type 完全一致（merge/update 时必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合并后的时间戳数组（merge/update 时必填）"]
  }
]

字段说明：
- target_ids：要替换的旧记忆 ID 数组。长度**只能是 0 或 1**。store/skip 时省略或为空。
- merged_content：merge/update 时的最终记忆文本。store/skip 时省略。
- merged_type：必须等于新记忆与被合并旧记忆共同的 type（跨 type 已被禁止，因此三者 type 必然相同）。
- merged_priority：取新旧两条记忆 priority 的**较大值**，不得超过该最大值（0-100 整数，merge/update 时必填）。
- merged_timestamps：新记忆 + 被合并那一条旧记忆的时间戳，去重排序。`;
```

**Defense-in-depth (REQUIRED by implementer):** after reading `parseBatchResult`
(`src/core/record/l1-dedup.ts`), add a runtime guard that forces `action="store"` (clear
`target_ids`) whenever a decision has `target_ids.length > 1` OR `merged_type` != the new
memory's own type. This makes RC1 impossible even if the LLM disobeys the prompt.

---

## DELIVERABLE 2 — Tighten extraction (RC4)

**File:** `src/core/prompts/l1-extraction.ts`

### 2a. Replace `instruction` definition — lines **49–53** with:

```ts
3. 全局指令记忆 (type: "instruction")
   - 定义：**仅限用户在本次对话中新提出的**、面向 AI 的长期行为规则、格式偏好或语气控制。必须是用户主动的、对话内的请求，而**不是**系统/配置预设的规则。
   - 严格边界（不满足任一条则不提取为 instruction）：
     a. 必须由【用户】消息发出，且是用户在本轮对话中**新表达**的意愿；
     b. 必须是 AI 长期、跨对话适用的行为规则，而非一次性操作；
     c. **绝不**提取来自系统提示词、CLAUDE.md、agent 配置、路由表、工具清单等"AI 自身配置"的文本（见下方"不应该提取的内容"）。
   - 提取句式（必须为**单句**）："用户要求 AI 以后回答时……"。
   - 原子性约束：每条 instruction 只表达**一条**规则，输出必须是**一个句子**。禁止把多条规则、整段配置、列表或多段落文本塞进同一条 content。若用户一次提出多条规则，拆成多条 instruction，每条一句。
   - 长度约束：content 不得超过约 120 个汉字；超过说明你提取了大段文本，应丢弃或拆分。
   - 触发词（仅当确为用户对话内新指令时才适用）：以后都、从现在开始、记住、必须。
   - 打分 (priority)：90-100（用户明确的核心行为规则）；70-80（重要要求）；<70（临时要求，直接丢弃）。
```

NOTE: this removes the `-1`（死命令）band. IMPLEMENTER MUST grep `priority < 0` / `priority === -1`
across src/ FIRST. If a downstream consumer uses `-1` as a sentinel, keep the band and adjust
the Deliverable-4 clamp lower bound; otherwise remove as written.

### 2b. Replace "不应该提取的内容" — lines **57–62** with:

```ts
### 不应该提取的内容（命中任意一条，绝对不要提取为任何类型的记忆）
- **AI 自身的配置与系统提示词**：任何来自系统提示词（system prompt）、角色设定、agent 人设/职责描述的文本。
- **CLAUDE.md 与全局/项目配置规则**：CLAUDE.md、规则文件、约定、"非协商规则"、工作流规范等配置性文本——这些是 AI 的既有设定，不是用户在本次对话中的新请求。
- **Agent 路由表 / 团队分工表**：诸如"某类任务用某 agent / 某模型"的表格或映射。
- **工具清单与 CLI 列表**：可用工具、命令、API、CLI 的枚举或说明。
- **任何"AI 自身配置"性质的元指令**：即描述 AI 本应如何被配置/运行的文本，而非用户当下提出的具体请求。
- 琐碎闲聊、问候；临时性的纯工具性请求（如"这次帮我翻译一下"）。
- 一次性操作指令（如"这次、本单"相关）。
- 重复的内容；AI 助手自身的行为或输出。
- 不属于以上 3 类的信息。
- 纯主观感受（不带客观事件的情绪表达）。
- **大段文本 / 多段落 / 列表 / 表格**：记忆必须是单条原子陈述；遇到长文本或结构化块，不要整体提取。

判断口诀：若一段文本是"AI 被如何设定/配置的"，它**不是**记忆；只有"用户是谁、用户做了什么、用户此刻要求什么"才是记忆。
```

---

## DELIVERABLE 3 — Kimi params: temperature=1 (exact), max_tokens=16000 (RC5)

Single chokepoint = `StandaloneLLMRunner.run` → `generateText`. The AI SDK `generateText`
accepts top-level `temperature` (same level as `maxOutputTokens`). The CODE DEFAULT alone
(`temperature ?? 1`, `maxTokens ?? 16000`) satisfies the hard constraint even with zero config.

IMPLEMENTER NOTE: prefer making the new config `temperature` field OPTIONAL (`temperature?:
number`) on every interface to minimize forced edits — the runner default guarantees 1 anyway.

### 3a. `src/adapters/standalone/llm-runner.ts`
- Add `temperature?: number;` to `StandaloneLLMConfig` (after `maxTokens?`, ~line 49) with a
  comment that Kimi extraction requires exactly 1.
- In `run()` (~line 183): change `?? 4096` to `?? 16000`, and add
  `const temperature = params.temperature ?? this.config.temperature ?? 1;`
- In the `generateText({ ... })` call (~line 230): add `temperature,` after `maxOutputTokens: maxTokens,`.

### 3b. `src/core/types.ts`
- Add `temperature?: number;` to `LLMRunParams` (after `maxTokens?`, ~line 75).

### 3c. `src/gateway/config.ts`
- Line 93: `maxTokens: envInt("TDAI_LLM_MAX_TOKENS") ?? num(llmConfig, "maxTokens") ?? 16000,`
- Insert after it: `temperature: envFloat("TDAI_LLM_TEMPERATURE") ?? num(llmConfig, "temperature") ?? 1,`
- Add an `envFloat` helper next to `envInt` (~after line 185):
```ts
function envFloat(key: string): number | undefined {
  const v = env(key);
  if (!v) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}
```

### 3d. `src/config.ts`
- Interface `StandaloneLLMOverrideConfig` (~line 202): add `temperature` (prefer optional).
- Parser IIFE (~lines 543–553): `maxTokens: num(llmGroup, "maxTokens") ?? 16000,` and add
  `temperature: num(llmGroup, "temperature") ?? 1,`.

### 3e. Thread `temperature` through the three construction sites (so user YAML is honored):
- `src/gateway/server.ts:417-424` — add `temperature: this.config.llm.temperature,`
- `src/core/tdai-core.ts:437-443` — add `temperature: this.cfg.llm.temperature,`
- `src/core/seed/seed-runtime.ts:84-90` — add `temperature: cfg.llm.temperature,`
- `src/adapters/standalone/host-adapter.ts:53-56` forwards config whole — NO change.

Env summary: `TDAI_LLM_MAX_TOKENS` (existing, now default 16000), `TDAI_LLM_TEMPERATURE` (new,
default 1). Truncation link: 4096→16000 stops the silent loss at `l1-extractor.ts:370`
(truncated JSON → `No JSON array found` → returns `[]`).

---

## DELIVERABLE 4 — Per-memory length cap + priority clamp at extraction (RC4 defense-in-depth)

**File:** `src/core/record/l1-extractor.ts` — the `allExtracted.push({ ... })` (~lines 188–195).
Before the push: trim content; skip if empty or > `MAX_MEMORY_CONTENT_CHARS = 600`
(loud warn + `continue`); clamp priority to `[0,100]` (`Math.max(0, Math.min(100, Math.round(p)))`).
Use the existing logger/TAG in that file.

```ts
      const MAX_MEMORY_CONTENT_CHARS = 600;
      const rawContent = typeof mem.content === "string" ? mem.content.trim() : "";
      if (rawContent.length === 0 || rawContent.length > MAX_MEMORY_CONTENT_CHARS) {
        logger?.warn?.(
          `${TAG} Skipping memory: content length ${rawContent.length} out of [1, ${MAX_MEMORY_CONTENT_CHARS}] ` +
          `(type=${memType}, preview="${rawContent.slice(0, 80)}")`,
        );
        continue;
      }
      const rawPriority = typeof mem.priority === "number" ? mem.priority : 50;
      const clampedPriority = Math.max(0, Math.min(100, Math.round(rawPriority)));
      // ...then push with content: rawContent, priority: clampedPriority
```

If the `-1` band is KEPT (see 2a), make the clamp lower bound `-1` for instruction type only.
600 chars is above the prompt's ~120 target so legit episodic narratives survive while
multi-paragraph config dumps are rejected.

---

## NON CONFIRMED items the implementer MUST resolve
1. `parseBatchResult` internals → write the runtime guard (target_ids>1 / type-mismatch → store).
2. `priority === -1` / `priority < 0` consumers → decide keep/remove the `-1` band + clamp bound.
3. Enumerate object literals constructing `StandaloneLLMOverrideConfig` / config `llm` that need
   the new `temperature` field (typecheck will surface them; prefer optional field to avoid churn).
