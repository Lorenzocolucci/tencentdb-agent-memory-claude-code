---
name: memory-search
description: Search long-term memory (TencentDB Agent Memory) for relevant past interactions, preferences, or decisions. Use when the user asks "do you remember…" or references past work in this project.
argument-hint: <query>
---

Search TencentDB Agent Memory for: $ARGUMENTS

!`node "${CLAUDE_PLUGIN_ROOT}/dist/lib/hook.mjs" search "$ARGUMENTS"`

Summarize the results above and answer the user's question. If no memories were found, say so plainly.
