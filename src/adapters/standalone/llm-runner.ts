/**
 * StandaloneLLMRunner — powered by Vercel AI SDK (`ai` + `@ai-sdk/openai`).
 *
 * This runner does NOT depend on OpenClaw's `runEmbeddedPiAgent`. It is designed
 * for the Hermes Gateway scenario where TDAI runs as an independent Node.js sidecar
 * without the OpenClaw host.
 *
 * Capabilities:
 * - `enableTools: false`: pure text output (L1 extraction, L1 dedup)
 * - `enableTools: true`: automatic tool-call loop with local file operations
 *   (L2 scene, L3 persona) via AI SDK's `maxSteps`
 *
 * Tool sandbox:
 *   When tools are enabled, three basic file operations are exposed:
 *   `read_file`, `write_to_file`, `replace_in_file`.
 *   All file paths are resolved relative to `workspaceDir`, enforcing sandbox boundaries.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";
import { generateText, tool, stepCountIs, hasToolCall, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { report } from "../../core/report/reporter.js";
import {
  createThinkingFetch,
  resolveTemperature,
  resolveThinking,
  type ThinkingMode,
} from "./llm-provider.js";
import type {
  LLMRunner,
  LLMRunParams,
  LLMRunnerFactory,
  LLMRunnerCreateOptions,
  Logger,
} from "../../core/types.js";

const TAG = "[memory-tdai] [standalone-runner]";

// Max iterations in the tool-call loop to prevent infinite loops
const MAX_TOOL_ITERATIONS = 20;

// ============================
// Configuration
// ============================

export interface StandaloneLLMConfig {
  /** OpenAI-compatible API base URL (e.g. "https://api.openai.com/v1"). */
  baseUrl: string;
  /** API key for authentication. */
  apiKey: string;
  /** Default model name (e.g. "gpt-4o"). */
  model: string;
  /** Default max output tokens. */
  maxTokens?: number;
  /**
   * Sampling temperature. Kimi/Moonshot extraction requires EXACTLY 1 for
   * stable structured output; the runner defaults to 1 when this is omitted.
   */
  temperature?: number;
  /**
   * When true, send NO temperature parameter to the API. Required for OpenAI
   * "reasoning" models (e.g. gpt-5.4-mini), which reject/ignore temperature and
   * emit an AI-SDK warning on every call if it is passed. Takes precedence over
   * `temperature`.
   */
  omitTemperature?: boolean;
  /** Request timeout in milliseconds (default: 120_000). */
  timeoutMs?: number;
  /**
   * Reasoning control for Kimi/Moonshot models: injects
   * `{"thinking":{"type":...}}` into the chat/completions body. Default:
   * "disabled" when the base URL host contains "moonshot" or "kimi", otherwise
   * nothing is sent. (Measured 2026-09-05: with thinking on, kimi-k2.6 spends up
   * to 1,500 reasoning tokens / 30 s on a 70-token prompt and returns EMPTY
   * content under a small max_tokens.)
   */
  thinking?: ThinkingMode;
  /**
   * Second provider tried INSIDE run() when the primary call throws (dead model,
   * refusal, network). Same prompt, tools, toolChoice, stopWhen and token budget;
   * a fresh abort signal. Without this, every distillation pass silently read a
   * dead primary model as "nothing to learn" (measured 2026-09-05: 17/17 calls
   * failed on `moonshot-v1-auto`, 0 lessons/principles/usage distilled).
   */
  fallback?: StandaloneLLMFallbackConfig;
}

/** The fallback provider: a plain config that can never carry its own fallback. */
export interface StandaloneLLMFallbackConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Send NO temperature (reasoning models such as gpt-5.4-mini reject it). */
  omitTemperature?: boolean;
  /** Overrides the primary's max output tokens for the fallback call. */
  maxTokens?: number;
  /** Overrides the primary's timeout for the fallback call. */
  timeoutMs?: number;
  thinking?: ThinkingMode;
}

/** What one generateText attempt needs to know about its provider. */
interface ProviderTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  thinking?: ThinkingMode;
}

function buildProvider(target: ProviderTarget) {
  // "compatible" mode calls /chat/completions (not the Responses API), which
  // works with every OpenAI-compatible backend (Moonshot, DeepSeek, Qwen, ...).
  const thinking = resolveThinking(target.thinking, target.baseUrl);
  return createOpenAI({
    baseURL: target.baseUrl,
    apiKey: target.apiKey,
    compatibility: "compatible",
    ...(thinking ? { fetch: createThinkingFetch(thinking) } : {}),
  });
}

/** Error thrown when the primary AND the fallback provider both fail. */
export class LLMFallbackExhaustedError extends Error {
  constructor(
    readonly primaryModel: string,
    readonly primaryError: unknown,
    readonly fallbackModel: string,
    readonly fallbackError: unknown,
  ) {
    super(
      `primary ${primaryModel} failed: ${errorMessage(primaryError)}; ` +
        `fallback ${fallbackModel} failed: ${errorMessage(fallbackError)}`,
    );
    this.name = "LLMFallbackExhaustedError";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================
// Sandboxed tool execution helpers
// ============================

function resolveSandboxedPath(workspaceDir: string, relativePath: string): string | null {
  const resolved = path.resolve(workspaceDir, relativePath);
  if (!resolved.startsWith(path.resolve(workspaceDir))) {
    return null;
  }
  return resolved;
}

// ============================
// Tool definitions (Vercel AI SDK `tool()` format)
// ============================

function createSandboxedTools(workspaceDir: string, logger?: Logger) {
  return {
    read_file: tool({
      description: "Read the contents of a file at the given relative path.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to read." },
        },
        required: ["path"],
      }),
      execute: (async (args: { path: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          return await fsPromises.readFile(resolved, "utf-8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} read_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    write_to_file: tool({
      description: "Write content to a file at the given relative path. Creates or overwrites.",
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to write." },
          content: { type: "string", description: "Content to write." },
        },
        required: ["path", "content"],
      }),
      execute: (async (args: { path: string; content: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
          await fsPromises.writeFile(resolved, args.content, "utf-8");
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} write_to_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    replace_in_file: tool({
      description: "Replace an exact substring in a file with new content.",
      inputSchema: jsonSchema<{ path: string; old_str: string; new_str: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path." },
          old_str: { type: "string", description: "Exact string to find and replace." },
          new_str: { type: "string", description: "Replacement string." },
        },
        required: ["path", "old_str", "new_str"],
      }),
      execute: (async (args: { path: string; old_str: string; new_str: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        if (!args.old_str) return JSON.stringify({ error: "old_str cannot be empty." });
        try {
          const existing = await fsPromises.readFile(resolved, "utf-8");
          if (!existing.includes(args.old_str)) {
            return JSON.stringify({ error: `old_str not found in file "${args.path}".` });
          }
          const updated = existing.replace(args.old_str, args.new_str);
          await fsPromises.writeFile(resolved, updated, "utf-8");
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} replace_in_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),
  };
}

/** Read-only tool subset — used when enableTools=false to avoid empty tools rejection. */
function createReadOnlyTools(workspaceDir: string, logger?: Logger) {
  const all = createSandboxedTools(workspaceDir, logger);
  return { read_file: all.read_file };
}

// ============================
// StandaloneLLMRunner
// ============================

export class StandaloneLLMRunner implements LLMRunner {
  private config: StandaloneLLMConfig;
  private model: string;
  private enableTools: boolean;
  private logger?: Logger;

  constructor(opts: {
    config: StandaloneLLMConfig;
    model?: string;
    enableTools?: boolean;
    logger?: Logger;
  }) {
    this.config = opts.config;
    this.model = opts.model ?? opts.config.model;
    this.enableTools = opts.enableTools ?? false;
    this.logger = opts.logger;
  }

  async run(params: LLMRunParams): Promise<string> {
    const runStartMs = Date.now();
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs ?? 120_000;
    // RC5: default max_tokens 16000 (was 4096). 4096 silently truncated long L1
    // extraction JSON, which then failed to parse and dropped all memories.
    const maxTokens = params.maxTokens ?? this.config.maxTokens ?? 16000;
    // RC5: Kimi/Moonshot is only stable at temperature=1 (and rejects any other
    // value). Reasoning models (omitTemperature) send NO temperature at all.
    const temperature = resolveTemperature({
      omitTemperature: this.config.omitTemperature,
      baseUrl: this.config.baseUrl,
      requested: params.temperature,
      configured: this.config.temperature,
    });
    const workspaceDir = params.workspaceDir ?? process.cwd();

    this.logger?.debug?.(
      `${TAG} run() start: taskId=${params.taskId}, model=${this.model}, ` +
      `tools=${this.enableTools}, timeout=${timeoutMs}ms`,
    );

    // Select tools based on mode — built ONCE and reused by the fallback attempt.
    const tools = this.enableTools
      ? createSandboxedTools(workspaceDir, this.logger)
      : createReadOnlyTools(workspaceDir, this.logger);

    // Optionally force the model to write via the write_to_file tool (L3
    // persona). toolChoice pins the first step to that tool, and stopWhen
    // halts as soon as it is called — so there is no risk of a forced-tool
    // loop. Only applies to tool-enabled runs that expose write_to_file.
    const forceWrite =
      this.enableTools && params.forceWriteTool === true && "write_to_file" in tools;
    if (forceWrite) {
      this.logger?.debug?.(`${TAG} Forcing write_to_file tool call (toolChoice + hasToolCall stop).`);
    }

    // Everything both attempts share. Only the provider/model, the temperature
    // policy, the token budget and the abort signal differ per attempt.
    const shared = {
      system: params.systemPrompt,
      prompt: params.prompt,
      tools,
      // "required" (force any tool) is honoured far more reliably by Moonshot
      // for large prompts than a specific {type:"tool"} choice (measured: 3/3
      // clean tool calls vs intermittent). The persona prompt only offers
      // write-style tools and instructs write_to_file, so the model picks it;
      // hasToolCall then stops the loop as soon as the write happens.
      toolChoice: forceWrite ? ("required" as const) : undefined,
      stopWhen: forceWrite
        ? [stepCountIs(MAX_TOOL_ITERATIONS), hasToolCall("write_to_file")]
        : stepCountIs(this.enableTools ? MAX_TOOL_ITERATIONS : 1),
      // Survive transient network blips (e.g. flaky DNS: getaddrinfo ENOTFOUND)
      // with extra retry headroom. The AI SDK retries with exponential backoff;
      // the abortSignal still caps total wall-clock per attempt.
      maxRetries: 4,
    };

    const attempt = async (target: ProviderTarget, opts: {
      temperature: number | undefined;
      maxOutputTokens: number;
      timeoutMs: number;
    }) => {
      const provider = buildProvider(target);
      return generateText({
        ...shared,
        model: provider.chat(target.model),
        maxOutputTokens: opts.maxOutputTokens,
        temperature: opts.temperature,
        abortSignal: AbortSignal.timeout(opts.timeoutMs),
      });
    };

    let modelUsed = this.model;
    try {
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await attempt(
          { baseUrl: this.config.baseUrl, apiKey: this.config.apiKey, model: this.model, thinking: this.config.thinking },
          { temperature, maxOutputTokens: maxTokens, timeoutMs },
        );
      } catch (primaryErr) {
        const fb = this.config.fallback;
        if (!fb) throw primaryErr;
        const primaryMs = Date.now() - runStartMs;
        this.logger?.warn(
          `${TAG} run() primary ${this.model} failed after ${primaryMs}ms (taskId=${params.taskId}): ` +
            `${errorMessage(primaryErr)} — retrying on fallback ${fb.model}`,
        );
        try {
          modelUsed = fb.model;
          result = await attempt(
            { baseUrl: fb.baseUrl, apiKey: fb.apiKey, model: fb.model, thinking: fb.thinking },
            {
              temperature: resolveTemperature({
                omitTemperature: fb.omitTemperature,
                baseUrl: fb.baseUrl,
                requested: params.temperature,
                configured: this.config.temperature,
              }),
              maxOutputTokens: fb.maxTokens ?? maxTokens,
              timeoutMs: fb.timeoutMs ?? timeoutMs,
            },
          );
        } catch (fallbackErr) {
          throw new LLMFallbackExhaustedError(this.model, primaryErr, fb.model, fallbackErr);
        }
      }

      const text = result.text.trim();
      const totalMs = Date.now() - runStartMs;

      this.logger?.debug?.(
        `${TAG} run() completed: ${totalMs}ms, model=${modelUsed}, steps=${result.steps.length}, output=${text.length} chars`,
      );

      // Log tool usage if any. Do NOT gate on steps.length > 1: a forced tool
      // call (forceWrite) stops the loop at step 1 via hasToolCall, so the call
      // would otherwise go unlogged.
      const toolCalls = result.steps.flatMap((s) => s.toolCalls ?? []);
      if (toolCalls.length > 0) {
        this.logger?.debug?.(
          `${TAG} Tool calls: ${toolCalls.map((tc) => tc.toolName).join(", ")}`,
        );
      }

      // Metric
      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone",
          model: modelUsed,
          inputLength: params.prompt.length,
          outputLength: text.length,
          totalDurationMs: totalMs,
          success: true,
          error: null,
        });
      }

      return text;
    } catch (err) {
      const totalMs = Date.now() - runStartMs;
      const errMsg = errorMessage(err);
      this.logger?.error(
        `${TAG} run() failed after ${totalMs}ms (taskId=${params.taskId}, model=${modelUsed}): ${errMsg}`,
      );

      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone",
          model: modelUsed,
          inputLength: params.prompt.length,
          outputLength: 0,
          totalDurationMs: totalMs,
          success: false,
          error: errMsg,
        });
      }

      throw err;
    }
  }
}

// ============================
// StandaloneLLMRunnerFactory
// ============================

export interface StandaloneLLMRunnerFactoryOptions {
  /** LLM API configuration. */
  config: StandaloneLLMConfig;
  /** Logger instance. */
  logger?: Logger;
}

/**
 * Factory that creates StandaloneLLMRunner instances.
 *
 * Used by the Gateway and Hermes host adapters.
 */
export class StandaloneLLMRunnerFactory implements LLMRunnerFactory {
  private config: StandaloneLLMConfig;
  private logger?: Logger;

  constructor(opts: StandaloneLLMRunnerFactoryOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
  }

  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner {
    const enableTools = opts?.enableTools ?? false;
    const modelRef = opts?.modelRef;

    // Parse "provider/model" → just use the model part for OpenAI-compatible API
    let model = this.config.model;
    if (modelRef) {
      const slashIdx = modelRef.indexOf("/");
      model = slashIdx > 0 ? modelRef.slice(slashIdx + 1) : modelRef;
    }

    this.logger?.debug?.(
      `${TAG} Creating StandaloneLLMRunner: model=${model}, tools=${enableTools}`,
    );

    return new StandaloneLLMRunner({
      config: this.config,
      model,
      enableTools,
      logger: this.logger,
    });
  }

  /**
   * A runner whose PRIMARY is the configured fallback provider (and which has
   * no fallback of its own). Used by callers that keep a second-layer retry
   * for failures the transport cannot see (e.g. the kb-extractor's JSON/schema
   * parse failures). Returns undefined when no fallback is configured.
   */
  createFallbackRunner(opts?: LLMRunnerCreateOptions): LLMRunner | undefined {
    const fb = this.config.fallback;
    if (!fb) return undefined;
    return new StandaloneLLMRunner({
      config: {
        baseUrl: fb.baseUrl,
        apiKey: fb.apiKey,
        model: fb.model,
        omitTemperature: fb.omitTemperature,
        maxTokens: fb.maxTokens ?? this.config.maxTokens,
        timeoutMs: fb.timeoutMs ?? this.config.timeoutMs,
        thinking: fb.thinking,
      },
      model: fb.model,
      enableTools: opts?.enableTools ?? false,
      logger: this.logger,
    });
  }

  /** The configured fallback model name, for log lines; undefined when none. */
  get fallbackModel(): string | undefined {
    return this.config.fallback?.model;
  }
}
