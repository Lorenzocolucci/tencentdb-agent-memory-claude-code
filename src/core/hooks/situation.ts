/**
 * Situation extraction (Track A 3+4, the "observe" half).
 *
 * A PostToolUse event tells us what the agent just did. The strongest "situation"
 * signal for proactive injection is the FILE in play: when the agent reads or
 * edits a file, that file is the handle into the associative graph (decisions,
 * lessons, past failures tied to it). This module pulls that signal out of the
 * raw hook payload. Pure + defensive; the KB match/injection is separate.
 */

/** Tools whose `tool_input.file_path` names a concrete file the agent is touching. */
const FILE_TOUCHING_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

export interface ToolEvent {
  toolName: string;
  toolInput: unknown;
  /** Whether the tool result was an error (PostToolUse `tool_output_is_error`). */
  toolOutputIsError?: boolean;
}

export interface Situation {
  /** Absolute/relative path of the file in play, when a file-touching tool ran. */
  filePath?: string;
  /** Whether this tool call errored (an error is itself a recall-worthy signal). */
  isError: boolean;
}

/** Read a string property defensively from an unknown object. */
function strProp(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Normalize a path to forward slashes WITHOUT a regex (`split`/`join`), so the
 * bundler cannot mangle a backslash regex — the built `canonicalKey` was seen
 * to mishandle raw Windows backslash paths. Downstream always gets posix slashes.
 */
function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** Extract the situation (file in play + error flag) from a tool event. */
export function extractSituation(event: ToolEvent): Situation {
  const isError = event.toolOutputIsError === true;
  if (!FILE_TOUCHING_TOOLS.has(event.toolName)) {
    return { isError };
  }
  const filePath = strProp(event.toolInput, "file_path");
  return filePath ? { filePath: toPosix(filePath), isError } : { isError };
}
