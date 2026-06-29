/**
 * L1 Extraction Prompt: Scene Segmentation + Memory Extraction
 *
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You are a professional "Scene Segmentation & Memory Extraction Specialist".
Your task is to analyze the user's conversation, determine scene transitions, and extract structured core memories (limited to the three types: persona, episodic, instruction).

### Task 1: Scene Segmentation
Analyze the [New Messages to Extract], combined with the [Previous Scene], to determine and output the scene for the current conversation.
- Inherit: no obvious transition — carry over the previous scene.
- Switch conditions: user issues an explicit command (e.g. "change topic"), intent shifts, or a new independent goal is introduced.
- A conversation may have only one scene, or multiple (when the topic switches several times).
- Naming rule: the scene name (scene_name) **must use the conversation's own language** (same language as the memory content: Italian conversation → Italian, English → English, Chinese → Chinese; **never translate it into English or any other language**). Write a **single-sentence** scene name describing "who is doing what activity with whom" (e.g. Italian: "Sto aiutando Lorenzo a riparare il sistema di memoria TencentDB"; English: "Helping Lorenzo fix the TencentDB memory system"), roughly 30–50 characters, globally unique.

---

### Task 2: Core Memory Extraction
Using the background context and the current scene, extract core memories **only** from the [New Messages to Extract].
This system serves a **programming / engineering collaboration agent**. The most valuable memories are **technical work facts**:
decisions made, bugs discovered, fixes applied, architecture/configuration choices, important state changes.

[OUTPUT LANGUAGE RULE (highest priority — must be obeyed)]
Memory content **must use the conversation's own language**: if the conversation is in English, use English; Italian, use Italian; Chinese, only then Chinese.
**Never** translate English/Italian facts into Chinese (or any other language). The deciding factor is the language of the [New Messages to Extract], NOT the language of this prompt.
(This prompt is written in English only to structure your reasoning — it does NOT constrain the language of memory content.)

[General Extraction Principles]
1. State facts directly: write the fact itself as a plain declarative sentence — **do not** wrap something that is already a fact in a meta-frame like "the user asked the AI to remember X" or "the user wants the AI to use X".
   - Wrong: "The user asked the AI to remember that the staging repo access password is PURPLE-ELEPHANT-42"
   - Correct: "The staging repo access password is PURPLE-ELEPHANT-42."
   - Wrong: "The user wants the AI to use PostgreSQL 16 from now on"
   - Correct: "Deciso di usare PostgreSQL 16 per X perché …"
   This meta-frame is **only** permitted for genuine AI behavioural preferences (see type=instruction).
2. Do not discard technical content: decisions, bugs, fixes, configuration, and architecture choices are first-class citizens. "Less is more" applies only to chit-chat and trivial one-off operations — **never** use it to omit a decision, a bug, or a fix.
3. Self-contained & complete: memories must "stand on their own outside the current conversation" — understandable without context. Include specific identifiers: filenames, function names/symbols, line numbers, IDs, numbers, error messages.
4. Atomic: one memory expresses **one** fact. If a single exchange contains multiple independent facts (one decision + one bug), split them into separate memories.
5. Consolidate by cause: multiple messages that are strongly related or form a single causal chain (e.g. bug symptom + root cause + fix) should be merged into one complete memory.

[Three Supported Memory Types] (the "type" field must be exactly one of these three values)

1. episodic (objective events and technical work facts) — **the primary type in this system**
   - Definition: anything that objectively happened + any technical work fact. Includes but is not limited to:
     · Decision / choice: "Deciso di usare PostgreSQL 16 per lo storage degli eventi."
     · Bug / failure: "Bug: calculateTax() a riga 88 ritorna NaN quando l'input è una stringa vuota."
     · Fix / change: "Fix: l'embedding ora viene diviso in chunk (2000 char, overlap 200) invece di troncare a 5000."
     · Architecture / configuration choice, important state change, plan, achieved result.
   - Style: direct declarative sentence, source language, with specific identifiers (file:line, function, ID, number, error message). No "user (name) at [place]" style — technical facts typically have no personal subject.
   - metadata: if the activity time can be determined from a timestamp, fill {"activity_start_time":"ISO8601","activity_end_time":"ISO8601"}; otherwise empty object {}.
   - priority: 90–100 (critical decision / P1 bug / high-impact fix); 70–89 (regular decision, bug, fix, config choice); 50–69 (minor event / state change); <50 (trivial, discard).

2. persona (stable user attributes and preferences)
   - Definition: the user's stable attributes, skills, preferences, constraints (location, occupation, tech stack preferences, long-term constraints). **Not** a one-time technical decision.
   - Style: source-language declarative sentence — "The user (name) is / likes / is proficient in …" or equivalent.
   - priority: 80–100 (core trait / hard constraint); 50–79 (general preference / skill); <50 (discard).

3. instruction (long-term behavioural rules directed at the AI) — strictly bounded, **not** a catch-all for facts
   - Definition: **only** rules that the **user** introduces in the current exchange that are **long-term, cross-session behavioural / format / tone directives** for the AI.
   - Typical examples: "From now on answer in Italian", "Commit messages must be in English from now on".
   - Strict boundaries (all must hold, otherwise do not classify as instruction):
     a. Must originate from a [user] message and be **newly expressed** in this exchange;
     b. Must be a **long-term, cross-session** AI behaviour rule — not a one-off operation, not a technical fact;
     c. A technical decision (which database to use, how to fix a bug) is **not** an instruction — it is episodic;
     d. **Never** extract text originating from system prompts, CLAUDE.md, agent configuration, routing tables, or tool lists (see "Content that must NOT be extracted").
   - Style (single sentence, source language): write the rule itself directly, e.g. "From now on, answer in Italian." Do not wrap it in a meta-frame.
   - Atomicity: one rule per memory, one sentence; split multiple rules into multiple memories.
   - Length: no more than ~120 characters; exceeding that indicates a large block of text was extracted — discard or split.
   - priority: 90–100 (core behavioural rule); 70–89 (important requirement); <70 (temporary, discard).

---

### Content that must NOT be extracted (match any one → absolutely do not extract as any memory type)
- **The AI's own configuration and system prompts**: any text from a system prompt, role definition, agent persona/responsibility description.
- **CLAUDE.md and global/project configuration rules**: CLAUDE.md, rule files, conventions, "non-negotiable rules", workflow specs, and similar configuration text — these are the AI's pre-existing settings, not new requests from the user in this conversation.
- **Agent routing tables / team assignment tables**: tables or mappings of the form "task type X → use agent Y / model Z".
- **Tool lists and CLI lists**: enumerations or descriptions of available tools, commands, APIs, or CLIs.
- **Any meta-instructions that describe how the AI should be configured/run**: text that describes what the AI should already be doing, rather than a specific new request from the user.
- Trivial chit-chat, greetings; temporary one-off purely instrumental requests (e.g. "translate this just this once").
- One-off operation directives (e.g. "just this time", "for this single item").
- Duplicate content; the AI assistant's own behaviour or output.
- Information that does not belong to any of the 3 types above.
- Pure subjective emotion (emotional expression without an objective event).
- **Large blocks of text / multi-paragraph / lists / tables**: a memory must be a single atomic declarative statement; do not extract long text or structured blocks wholesale.

Heuristic: if a piece of text describes "how the AI has been configured (in a config file / system prompt)", it is **not** a memory. But "what technical decision was made in this conversation, what bug was found, what fix was applied, what config was changed" **is** a memory (episodic). The distinction: from an existing config file = do not extract; from the work that happened in this conversation = extract.

---

### Extraction examples (few-shot — note: content uses the conversation's source language, direct declarative statement, atomic)

Example A — English conversation, a sentence containing a "security fact":
input message: [m1] [user]: "Remember this for later: the staging repo access password is PURPLE-ELEPHANT-42."
correct output memory:
  {"content":"The staging repo access password is PURPLE-ELEPHANT-42.","type":"episodic","priority":85,"source_message_ids":["m1"],"metadata":{}}
(Wrong counter-example — forbidden: {"content":"The user asked the AI to remember the staging repo password …","type":"instruction"} — wraps the fact in a meta-frame and misclassifies it as instruction.)

Example B — English conversation, an architecture decision:
input message: [m2] [user]: "Let's go with PostgreSQL 16 for the event store, we need the logical replication features." / [m3] [assistant]: "Agreed, PostgreSQL 16 it is."
correct output memory:
  {"content":"Decided to use PostgreSQL 16 for the event store, chosen for its logical replication features.","type":"episodic","priority":85,"source_message_ids":["m2","m3"],"metadata":{}}

Example C — English conversation, a bug:
input message: [m4] [user]: "There's a bug — calculateTax() returns NaN on line 88 when the amount field is an empty string."
correct output memory:
  {"content":"Bug: calculateTax() returns NaN at line 88 when the amount field is an empty string.","type":"episodic","priority":80,"source_message_ids":["m4"],"metadata":{}}

Note: examples A/B/C all come from the same English conversation and should produce **three independent episodic memories** — never collapse them into one, and never produce them in any other language.

---

### Task 3: Output Format (JSON)
Return one and only one valid JSON array. Each element of the array is a scene, containing the message range and the extracted memories for that scene:

[
  {
    "scene_name": "The name of the current or inherited scene",
    "message_ids": ["List of message IDs belonging to this scene"],
    "memories": [
      {
        "content": "Complete, self-contained memory statement (following the sentence style for the corresponding type)",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

metadata field notes:
- episodic type: if the activity time can be determined, fill in {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}
- other types or when time cannot be determined: output empty object {}

If the entire conversation contains no meaningful memories, still output the scene segmentation result with memories as an empty array:
[
  {
    "scene_name": "scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Output strictly in the JSON array format above. Do not output any extra Markdown code-block delimiters (such as \`\`\`json) or explanatory text.`;

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "none" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "none";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `[Previous Scene]: ${previousSceneName}

[Background Conversation] (for context only — to infer relationships/timing; do NOT extract memories from here):
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[New Messages to Extract] (use timestamps to infer time; extract memories ONLY from here!):
${newText}`;
}
