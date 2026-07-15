/**
 * OpenAI-compatible chat provider for `bee ask`.
 *
 * One transport covers every backend that speaks the OpenAI
 * `/v1/chat/completions` shape — a hosted gateway AND a local llama.cpp
 * `llama-server` (default :8080) both do. The only per-deployment differences
 * are the base URL, the API key (empty for an unauthenticated local server),
 * and the model name, all injected at construction. The key is sent as both
 * `Authorization: Bearer` and `X-Api-Key`.
 *
 * The prompt is split into two role messages: a hardened `system` instruction
 * (scope guard — see context.ts) and a `user` message carrying the retrieved
 * context + question. Splitting keeps the guard rails in the role the model
 * weights most heavily, rather than burying them in one concatenated string.
 */
import { SYSTEM_PROMPT } from "../context";
import type { LmAnswer, TokenUsage } from "../answer";
export class OpenAICompatProvider {
  public readonly name: string;

  public constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.name = providerLabel(endpoint);
  }

  /**
   * Request headers. The key is sent both as `Authorization: Bearer` and as
   * `X-Api-Key` for broad gateway compatibility; omitted entirely for an
   * unauthenticated local server (empty key).
   */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) {
      h["authorization"] = `Bearer ${this.apiKey}`;
      h["x-api-key"] = this.apiKey;
    }
    return h;
  }

  /**
   * `prompt` is the assembled USER content (context + question), not the system
   * instruction — the system prompt is attached here so every call is grounded
   * the same way regardless of caller.
   */
  async generate(prompt: string, maxTokens = 8192): Promise<string> {
    const headers = this.headers();

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        enable_thinking: false,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LM HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }

    const raw = await response.text();
    let json: { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      json = JSON.parse(raw.trim()) as typeof json;
    } catch {
      throw new Error(`LM returned non-JSON response: ${raw.trim().slice(0, 300)}`);
    }
    const msg = json.choices?.[0]?.message;
    return (msg?.content ?? msg?.reasoning_content ?? "").trim();
  }

  async generateWithUsage(prompt: string, maxTokens = 8192): Promise<{ text: string; usage?: TokenUsage }> {
    const headers = this.headers();
    const response = await fetch(this.endpoint, {
      method: "POST", headers,
      body: JSON.stringify({ model: this.model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens, enable_thinking: false }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`LM HTTP ${response.status}`);
    const raw = await response.text();
    const json = JSON.parse(raw.trim()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const msg = json.choices?.[0]?.message;
    return {
      text: (msg?.content ?? msg?.reasoning_content ?? "").trim(),
      usage: json.usage ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 } : undefined,
    };
  }

  async generateJson(prompt: string): Promise<{ answer: LmAnswer; usage?: TokenUsage } | null> {
    const headers = this.headers();

    let content = "";
    let usage: TokenUsage | undefined;
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt + "\n\nRespond with JSON only." },
        ],
        temperature: 0,
        max_tokens: 2048,
        enable_thinking: false,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      if (response.status === 400 || response.status === 422 || response.status === 500) {
        // Model doesn't support response_format — collect via stream() and parse JSON from text
        const chunks: string[] = [];
        for await (const chunk of this.stream(prompt + "\n\nRespond with JSON only.")) {
          chunks.push(chunk);
        }
        content = chunks.join("");
      } else {
        const body = await response.text().catch(() => "");
        throw new Error(`LM HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
      }
    } else {
      const raw = (await response.text()).trim().replace(/\s*data:\s*\[DONE\]\s*$/, "").trim();
      const outer = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const msg = outer.choices?.[0]?.message;
      content = msg?.content ?? msg?.reasoning_content ?? "";
      usage = outer.usage ? { promptTokens: outer.usage.prompt_tokens ?? 0, completionTokens: outer.usage.completion_tokens ?? 0 } : undefined;
    }

    content = content.replace(/<think>[\s\S]*?<\/think>\s*/i, "").trim();
    if (!content) return null;
    const jsonStart = content.indexOf("{");
    if (jsonStart === -1) return null;
    const parsed = JSON.parse(content.slice(jsonStart)) as LmAnswer;
    if (typeof parsed.explanation !== "string" || !Array.isArray(parsed.commands)) return null;
    return { answer: parsed, usage };
  }

  /**
   * Streaming variant: returns tokens via SSE as they arrive from the API.
   */
  async *stream(prompt: string): AsyncGenerator<string, void, unknown> {
    const headers = this.headers();
    if (process.env.BEE_DEBUG_TRACEBACK) {
      process.stderr.write(`[bee ask] stream prompt (first 300): ${prompt.slice(0, 300)}\n`);
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 8192,
        enable_thinking: false,
        stream: true,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new Error(`LM HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("LM response body is not readable");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const json = JSON.parse(trimmed.slice(6)) as {
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta;
          const content = delta?.content ?? delta?.reasoning_content;
          if (content) yield content;
        } catch {
          // skip malformed SSE line
        }
      }
    }
  }
}

/** Short backend label for `--json` output, derived from the endpoint host. */
function providerLabel(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    if (host === "localhost" || host === "127.0.0.1") return "local-lm";
    return host;
  } catch {
    return "lm";
  }
}
