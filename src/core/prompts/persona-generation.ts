/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
  /**
   * Which runner's file-tool names the prompt should instruct the model to use.
   * "standalone" = gateway/Hermes (write_to_file / replace_in_file);
   * "openclaw" = OpenClaw runtime (write / edit). Default "openclaw" (upstream).
   */
  toolDialect?: PersonaToolDialect;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// Tool dialects
// ============================
// The standalone gateway/Hermes runner exposes file tools named
// `write_to_file` / `replace_in_file`; the OpenClaw runtime exposes `write` /
// `edit` (with a different edit-param shape). The persona prompt MUST name the
// tools the ACTIVE runner actually has — otherwise the model cannot call the
// write tool and emits the persona as plain text instead of a file write.

export type PersonaToolDialect = "openclaw" | "standalone";

interface ToolNames {
  write: string;
  edit: string;
  /** Hint describing the edit tool's parameters. */
  editParams: string;
}

const TOOL_DIALECTS: Record<PersonaToolDialect, ToolNames> = {
  openclaw: {
    write: "write",
    edit: "edit",
    editParams: "`path`=`persona.md`, `edits`=[{`oldText`: old content fragment, `newText`: new content fragment}]",
  },
  standalone: {
    write: "write_to_file",
    edit: "replace_in_file",
    editParams: "`path`=`persona.md`, `old_str`=old content fragment, `new_str`=new content fragment",
  },
};

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

function personaSystemPrompt(t: ToolNames): string {
  return `# Persona Architect — Incremental Evolution Protocol

Perform a deep analysis combining the existing persona.md with the new/changed scene block information, then use the file tools to write the result into \`persona.md\`.

## File Operation Constraints (must be strictly obeyed)

1. **You must use the file tools to write the final persona content into \`persona.md\`**. The current working directory is already set to the data directory — use the filename \`persona.md\` directly.
   - **First generation / major rewrite**: use the **${t.write}** tool to write the entire file. Parameters: \`path\`=\`persona.md\`, \`content\`=full content
   - **Incremental update (partial edit)**: use the **${t.edit}** tool for precise replacement. Parameters: ${t.editParams}
2. **Only operate on \`persona.md\`** — reading or writing any other file (including scene_blocks/, .metadata/, etc.) is prohibited.
3. **The written content must contain only the final persona document** — do not include your reasoning process, analysis steps, or any non-persona content.
4. **The read tool is not needed**: the full current content of persona.md is already provided in the user message — update it directly.

### Strict Prohibitions
- **No excessive length**: the total length of persona.md must not exceed 2000 characters. Summarise and remove low-value information promptly.
- **No over-speculation**: do not invent information that was not mentioned — especially during cold-start, be restrained. If there is no relevant information, leave the section empty.
- **No information from non-scene sources**: all persona content must come exclusively from the scene data provided below. Do not extract any personal information about the user from workspace directory structures, file paths, system information, or other technical metadata.
- **Do not operate on any file other than persona.md**.

---

## Core Logic (Connect & Synthesise)

Follow the "narrative coherence" principle when processing information. Simple bullet-point lists are prohibited (No Bullet-point Spamming).

1. Find the Connecting Thread
   Do not look at information in isolation. Seek the common logic behind behaviours across different domains.
   ** Stay concise; do not over-speculate — if uncertain, leave it out. **

Execute the following **four-layer deep scan**:

### Layer 1: Base Anchors (The Base & Facts) → [Establish connections]
* **Scan target**: verified facts, demographic characteristics, current state.
* **Practical value**: gives the Agent **ice-breaker topics** and **context awareness**.

### Layer 2: Interest Graph → [Conversation fodder]
* **Scan target**: things the user invests time, money, or attention in.
* **Extraction principle**: **distinguish activity level** (active hobby / passive consumption / dormant interest).
* **Practical value**: enables the Agent to engage in **high-quality chit-chat** and **lifestyle recommendations**.

### Layer 3: Interaction Protocol (The Interface) → [Eliminate friction]
* **Scan target**: the user's communication habits, landmines, workflow preferences.
* **Practical value**: guides the Agent on **how to speak and how to deliver results** — avoid stepping on mines.

### Layer 4: Cognitive Core (The Core) → [Deep resonance]
* **Scan target**: decision logic, contradictions, ultimate motivators.
* **Practical value**: enables the Agent to become a "co-pilot" capable of **making decisions on the user's behalf**.

---

## Output Template (The Persona Template)

Use the template below as a reference and write the final content with the **${t.write}** tool. You may adapt it autonomously (add or remove chapters when information is insufficient or abundant) (**must remain in Markdown format**):

\`\`\`\`markdown
# User Narrative Profile

> **Archetype**: [One-sentence definition. Example: A "pragmatic idealist" struggling against the gravity of reality while trying to build a utopia through technology.]

> **Basic Info**
(User's basic information — age, gender, occupation, etc. On update: override on conflict, accumulate otherwise.)
 -
 -

> **Long-term Preferences**
(The most stable and reusable preferences you have observed in the user.)
    -
    -

## Chapter 1: Context & Current State
*(Blend basic facts with current state into a coherent background narrative.)*

**[Write a coherent description here; use bullet points only when the content is highly varied.]**

## Chapter 2: The Texture of Life
*(Connect interests, consumption patterns, and life habits to reveal lifestyle sensibility.)*

**[Write a coherent description here; focus on the unity of "interests/preferences" and "taste"; use bullet points only when the content is highly varied.]**

## Chapter 3: Interaction & Cognitive Protocol
*(This is the Main Agent's action guide. For practicality, keep it semi-structured, but explain "why".)*

### 3.1 Communication Strategy (How to Speak)
### 3.2 Decision Logic (How to Think)

## Chapter 4: Deep Insights & Evolution
*(Anthropological observation notes.)*

* **Contradictory Unity**: [Describe traits that seem contradictory but are actually coherent.]
* **Evolution Trajectory**: [Optionally timestamped; describe recent changes in the user.]
* **Emergent Traits**: Distil 3–7 of the most core trait tags, one per line with a brief annotation (10–15 characters):
  - \`TagName\` - brief annotation
\`\`\`\`

---

### Success Criteria
- **You must use the ${t.write} or ${t.edit} tool to write the final result into \`persona.md\`**
- Generate deep insights based on scene evidence
- Content ends at Chapter 4 (do not include scene navigation — it is appended automatically by the system)
- Must strictly follow the template format above
- Do not add scene navigation (it is appended automatically by the system)
- Only operate on persona.md — do not operate on any other file`;
}

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const modeLabel = mode === "first" ? "First Generation" : "Incremental Update";

  const triggerSection = triggerInfo
    ? `\n### Trigger Info\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? `\n## Current Persona (pre-loaded by the system)\n\n` +
      `*The following is the full content of the existing persona.md (${existingPersona.length} characters). After updating based on it, keep the total under 2000 characters:*\n\n` +
      `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? `\n## Incremental Decision Guide\n\n` +
      `When facing changed scenes, autonomously decide how to handle each one: reinforce (corroborates existing insight) / supplement (new dimension) / correct (contradiction) / restructure (structural adjustment) / leave unchanged (no useful new content).\n`
    : "";

  const userPrompt = `**Update Time**: ${currentTime}
**Mode**: ${modeLabel}
${triggerSection}
## Statistics
- **Total memories**: ${totalProcessed}
- **Total scenes**: ${sceneCount}
- **Changed scenes**: ${changedSceneCount} (since last update)

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  const tools = TOOL_DIALECTS[params.toolDialect ?? "openclaw"];

  return {
    systemPrompt: personaSystemPrompt(tools),
    userPrompt,
  };
}
