/**
 * OpenAI-compatible chat provider for `bee ask`.
 *
 * One transport covers every backend that speaks the OpenAI
 * `/v1/chat/completions` shape — Databricks model-serving endpoints AND a local
 * llama.cpp `llama-server` (default :8080) both do. The only per-deployment
 * differences are the base URL, the bearer token (empty for an unauthenticated
 * local server), and the model name, all injected at construction.
 *
 * The prompt is split into two role messages: a hardened `system` instruction
 * (scope guard — see context.ts) and a `user` message carrying the retrieved
 * context + question. Splitting keeps the guard rails in the role the model
 * weights most heavily, rather than burying them in one concatenated string.
 */
import { SYSTEM_PROMPT } from "../context";

export class OpenAICompatProvider {
  public readonly name: string;

  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.name = providerLabel(baseUrl);
  }

  /**
   * `prompt` is the assembled USER content (context + question), not the system
   * instruction — the system prompt is attached here so every call is grounded
   * the same way regardless of caller.
   */
  async generate(prompt: string): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    // A local llama-server needs no auth; only send the header when we have a key.
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`LM HTTP ${response.status}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content?.trim() ?? "";
  }
}

/** Short backend label for `--json` output, derived from the endpoint host. */
function providerLabel(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    if (host === "localhost" || host === "127.0.0.1") return "local-lm";
    if (host.includes("databricks")) return "databricks";
    return host;
  } catch {
    return "lm";
  }
}
