/**
 * Injected-display templates for the auto-recall hook.
 *
 * These strings are injected into the MAIN agent's context every turn (inside the
 * <memory-tools-guide> and <relevant-memories> XML sections). They are DISPLAY
 * surfaces, not extraction prompts: the agent reads them, nothing parses them by
 * content (sanitizeText strips them by XML TAG, never by these words), so their
 * wording is free to be English.
 *
 * Kept in a tiny dedicated module (instead of inline in the 1k-line auto-recall.ts)
 * so the language guard test can import and assert them directly.
 */

/**
 * Memory-tools usage guide — appended to the stable memory context so the main
 * agent knows it can actively pull deeper memory when the injected snippets are
 * not enough.
 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## Memory tools — how to pull more

When the memory snippets injected above are not enough to answer the user, you may actively call the following tools for more:

- **tdai_memory_search**: search structured memory (L1) — for recalling user preferences, past event nodes, rules, and other key facts.
- **tdai_conversation_search**: search the raw conversation log (L0) — for finding the exact wording of a message, a timeline, or context details; also useful to corroborate or cross-check memory_search results.
- **read_file** (a path from the Scene Navigation): once you have located the relevant scene and need its full picture, the sequence of events, or stage conclusions.

### ⚠️ Call limit
Per turn, tdai_memory_search and tdai_conversation_search may be called **at most 3 times combined**.
- If the first search returns nothing, you may retry with different keywords or the other tool, but do not exceed 3 calls total.
- If 3 searches still return nothing, the information is not in memory — answer the user from what you already have instead of searching further.
</memory-tools-guide>`;

/**
 * One-line header placed at the top of the <relevant-memories> block, framing the
 * recalled snippets as reference (not the current task state).
 */
export const RELEVANT_MEMORIES_HEADER = "The following are memories recalled for the current conversation; they do not represent the current task progress and are for reference only:";

/**
 * Label used by formatMemoryLine for a memory's activity time, e.g.
 * "(active: 2026-06-29)". Exported so the formatter and its inverse regex in
 * auto-recall.ts stay in lock-step (the parser strips this exact label).
 */
export const ACTIVITY_TIME_LABEL = "active";
