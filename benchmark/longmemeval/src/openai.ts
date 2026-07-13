/**
 * Minimal OpenAI chat helper for the benchmark's reader + judge stages.
 * Uses OPENAI_API_KEY from the environment. No secret is ever logged.
 */
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Single chat completion. Retries once on transient (5xx / network) errors.
 * Throws on persistent failure so the caller can mark the question as errored
 * rather than silently scoring it wrong.
 */
export async function chatComplete(
  systemPrompt: string,
  userPrompt: string,
  opts: ChatOptions = {},
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const body = {
    model: opts.model ?? "gpt-4o",
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 512,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text();
        // 4xx (except 429) is not worth retrying.
        if (resp.status < 500 && resp.status !== 429) {
          throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 200)}`);
        }
        throw new Error(`OpenAI transient ${resp.status}: ${text.slice(0, 120)}`);
      }
      const json = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("OpenAI: no content in response");
      return content.trim();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
