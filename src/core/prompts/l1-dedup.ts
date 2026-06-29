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

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a memory conflict detector. Batch-compare multiple [New Memories] against existing memories in the [Unified Candidate Pool] and decide how to handle each one.

## Overriding Principle: Prefer Caution — Better to Keep Two Entries Than to Delete One by Mistake

Merging is a destructive operation: the old memory that gets merged is **physically deleted**. Therefore you may only merge when you are **certain** that two memories are literally the same atomic fact. When in doubt, always choose store or skip (keeping both). Missing a merge causes only minor redundancy; a wrong merge causes permanent memory loss — the latter is far costlier.

## Hard Prohibitions (violating any one will cause memory loss — absolute)

1. **No cross-type merging**: the three types persona / episodic / instruction can **never** be merged or updated into each other. Different type → treat as different memories; only store or skip is allowed.
2. **No many-to-one merging**: one new memory may correspond to **at most one** existing memory in the candidate pool. The target_ids array length must be 0 or 1 — never 2 or more.
3. **No priority inflation**: after a merge / update, merged_priority **must be the greater of the two memories' priorities** — never exceed that maximum. No "discretionary boosting".
4. **Episodic events are never deduplicated**: two episodic memories are **different events** if any one of date, time, task, or location differs — each must be kept (both store/skip); merge/update is forbidden.

## Decision Logic (applies only when none of the hard prohibitions above are triggered)

For each new memory, check in order:

1. **Are the types the same?** If not → only store or skip; end.
2. **Are they literally the same atomic fact?** (subsumption: one memory's information is fully contained in the other, describing the same subject, same attribute/event, same time)
   - No → store (add as new).
   - Yes → proceed to step 3.
3. **Which one is better?**
   - The old memory already fully covers the new one, and the new one adds nothing → **skip** (discard new memory; keep old memory; delete nothing).
   - The new memory is a more specific / more recent / corrected version of **that one** old memory → **update** (target_ids exactly 1; replace that one old memory).
4. **Any hesitation → store**. If you cannot be certain they are the same atomic fact, treat the new one as a new memory and store it — never merge.

## Action Definitions

- "store": treat as new information; add the current memory. **Do not delete any old memory** (target_ids empty).
- "skip": the old memory is sufficient; the new one adds nothing; discard the new memory. **Do not delete any old memory** (target_ids empty).
- "update": the new memory is a better version of **that one** old memory (same type, same atomic fact, more specific or more recent or a correction). Replace that **single** old memory with the new one; you may retain still-correct details from the old one. target_ids length exactly 1.
- "merge": use **only** when (a) same type and (b) the new memory and **exactly one** old memory in the pool are the same atomic fact with complementary information that does not contradict. Combine into one. target_ids length exactly 1. **If any doubt, use store instead.**

## timestamp handling
- update / merge: merged_timestamps = timestamps of the new memory ∪ timestamps of the one replaced old memory (deduplicated, sorted).
- store / skip: omit.

## Output Format

Output strictly a JSON array; each element corresponds to the decision for one new memory. Output nothing else:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id of the single old memory to replace (at most 1; omit or empty array for store/skip)"],
    "merged_content": "merged/updated memory content (required for merge/update)",
    "merged_type": "must match the type of both the old and new memories exactly (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["array of merged timestamps (required for merge/update)"]
  }
]

Field notes:
- target_ids: array of old memory IDs to replace. Length **must be 0 or 1**. Omit or leave empty for store/skip.
- merged_content: the final memory text for merge/update. Omit for store/skip.
- merged_type: must equal the shared type of the new and old memories (cross-type is already prohibited, so all three will have the same type).
- merged_priority: the **greater** of the two memories' priorities; must not exceed that maximum (integer 0–100; required for merge/update).
- merged_timestamps: timestamps of the new memory + the one merged old memory, deduplicated and sorted.`;

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
    poolSection = "## Unified Candidate Pool\n\n(empty — no existing memories; all new memories go directly to store)";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Unified Candidate Pool (${poolList.length} existing memories)\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[] (no similar candidates — store directly)";

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

    return `### New Memory ${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\n[Related Candidate IDs] ${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `${poolSection}

${"═".repeat(50)}

## New Memories to Evaluate (${matches.length} total)

${newMemoriesText}

Evaluate each memory in turn and output the decision JSON array. When a new memory's candidate list is empty, output action=store for that entry.`;
}
