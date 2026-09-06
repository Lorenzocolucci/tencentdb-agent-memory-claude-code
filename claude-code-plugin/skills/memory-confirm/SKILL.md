---
name: memory-confirm
description: Confirm a gated (grounded-trust) memory so it becomes trusted. Use ONLY when the user explicitly answers a memory prompt with "yes, confirm <id>" — never infer the answer.
disable-model-invocation: true
argument-hint: <owner_id>
---

The user has explicitly confirmed the gated memory with this id:

$ARGUMENTS

Run the confirmation via the Bash tool. The plugin reads the id from **stdin** (never argv): cc performs a literal `replaceAll` on `$ARGUMENTS`, so passing user text as an argv element would be a command-injection surface (Anthropic GH issue #16163).

Use a here-document with a long random sentinel:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/lib/hook.mjs" confirm <<'__TDAI_OWNER_EOF__'
<paste the id verbatim, exactly as shown above, on one line — it starts with fact_ or event_>
__TDAI_OWNER_EOF__
```

Report the printed line to the user verbatim. If it says the id is not recognised or the gateway is unreachable, say so plainly — do not retry with a different id. (OpenClaw hosts use the `tdai_confirm_memory` tool for the same action.)
