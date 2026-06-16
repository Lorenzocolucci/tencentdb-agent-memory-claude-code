/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 */

import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

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

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## 统一候选记忆池\n\n（空，没有已有记忆，所有新记忆直接 store）";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## 统一候选记忆池（共 ${poolList.length} 条已有记忆）\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[]（无相似候选，直接 store）";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### 第 ${idx + 1} 条新记忆 (record_id: ${m.newMemory.record_id})\n${memStr}\n\n【关联候选 ID】${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `${poolSection}

${"═".repeat(50)}

## 待判断的新记忆（共 ${matches.length} 条）

${newMemoriesText}

请逐条判断并输出决策 JSON 数组。当某条新记忆的候选列表为空时，该条直接输出 action=store。`;
}
