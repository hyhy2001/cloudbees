/**
 * Databricks providers for `bee ask`.
 *
 * Three auth strategies:
 *   1. Azure CLI — runs `az account get-access-token` (no config needed)
 *   2. OAuth M2M — client_id + client_secret via Databricks OIDC endpoint
 *   3. PAT — static token (CB_API_KEY)
 */
import { SYSTEM_PROMPT } from "../context";
import { CHAT_ENDPOINT } from "../config";
import type { LmAnswer } from "../answer";

// ── Shared helpers ─────────────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number;
}

const APP_ID = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d";

/**
 * Call the configured chat endpoint (CHAT_ENDPOINT = base + CB_CHAT_PATH).
 *
 * For Databricks AI Gateway this is e.g.
 *   https://adb-xxxx.azuredatabricks.net/ai-gateway/mlflow/v1/chat/completions
 * which speaks the OpenAI-compatible shape. The model is sent in the body
 * (the gateway routes by it), unlike the legacy /serving-endpoints/{model}/
 * invocations form where the model was in the path.
 */
async function chatCall(model: string, token: string, prompt: string, maxTokens = 8192): Promise<string> {
  const response = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Databricks LM error (HTTP ${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const raw = await response.text();
  let json: { choices?: Array<{ message?: { content?: string } }> };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new Error(`Databricks LM returned non-JSON response: ${raw.slice(0, 200)}`);
  }
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

// ── OAuth M2M provider ─────────────────────────────────────────────────────

export class DatabricksOAuthProvider {
  public readonly name = "databricks-oauth";

  private host: string;
  private clientId: string;
  private clientSecret: string;
  private model: string;
  private tokenEndpoint = "";
  private cache: TokenCache | null = null;

  public constructor(host: string, clientId: string, clientSecret: string, model: string) {
    this.host = host.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.model = model;
  }

  async generate(prompt: string, maxTokens = 8192): Promise<string> {
    const token = await this.getToken();
    return chatCall(this.model, token, prompt, maxTokens);
  }

  async generateJson(prompt: string): Promise<LmAnswer | null> {
    const token = await this.getToken();

    // Try with response_format first; fall back to plain generate() if unsupported (HTTP 400/422).
    let content = "";
    const response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt + "\n\nRespond with JSON only." },
        ],
        max_tokens: 2048,
        temperature: 0,
        enable_thinking: false,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 422) {
        // Model doesn't support response_format — fall back to plain generate()
        content = await this.generate(prompt + "\n\nRespond with JSON only.", 2048);
      } else {
        throw new Error(`Databricks LM error (HTTP ${response.status})`);
      }
    } else {
      const raw = (await response.text()).trim().replace(/\s*data:\s*\[DONE\]\s*$/, "").trim();
      process.stderr.write(`[bee ask] databricks raw (200): ${raw.slice(0, 300)}\n`);
      const outer = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> };
      const msg = outer.choices?.[0]?.message;
      const rawContent = msg?.content ?? msg?.reasoning_content;
      content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
    }

    content = content.replace(/<think>[\s\S]*?<\/think>\s*/i, "").trim();
    process.stderr.write(`[bee ask] databricks content after strip: ${content.slice(0, 200)}\n`);
    if (!content) return null;
    const jsonStart = content.indexOf("{");
    if (jsonStart === -1) return null;
    const parsed = JSON.parse(content.slice(jsonStart)) as LmAnswer;
    if (typeof parsed.explanation !== "string" || !Array.isArray(parsed.commands)) return null;
    return parsed;
  }

  /**
   * Streaming variant over the OpenAI-compatible SSE shape. AI Gateway supports
   * stream:true at the chat path; tokens arrive as `data: {choices:[{delta}]}`.
   */
  async *stream(prompt: string): AsyncGenerator<string, void, unknown> {
    const token = await this.getToken();
    const response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: 8192,
        temperature: 0,
        stream: true,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      throw new Error(`Databricks LM error (HTTP ${response.status})`);
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

  async validate(): Promise<boolean> {
    try {
      await this.getToken();
      return true;
    } catch (err) {
      process.stderr.write(`[docs] Databricks OAuth: ${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  }

  /**
   * Public accessor for the cached OAuth bearer. Lets other call sites (e.g.
   * embedding in vector.ts) reuse the robust token exchange + caching instead
   * of duplicating a weaker inline copy. Throws on exchange failure.
   */
  async token(): Promise<string> {
    return this.getToken();
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.token;
    return this.fetchToken();
  }

  private async fetchToken(): Promise<string> {
    if (!this.tokenEndpoint) await this.discoverTokenEndpoint();

    // Strategy 1: Direct OIDC with Basic Auth (RFC 6749 URL-encoded)
    try {
      return await this.basicAuthExchange(this.tokenEndpoint!);
    } catch { /* try Azure AD */ }

    // Strategy 2: Azure AD via redirect discovery
    const tenants = [(await this.discoverAzureTenant()), "common"].filter(Boolean);
    for (const tenant of tenants) {
      try {
        const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.clientId,
            client_secret: this.clientSecret,
            scope: `${APP_ID}/.default`,
          }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        return this.parseTokenResponse(r, `scope(${tenant})`);
      } catch { /* try next */ }

      try {
        const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.clientId,
            client_secret: this.clientSecret,
            resource: APP_ID,
          }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        return this.parseTokenResponse(r, `resource(${tenant})`);
      } catch { /* try next */ }
    }

    throw new Error("Token exchange failed (401) — check credentials");
  }

  private async discoverTokenEndpoint(): Promise<void> {
    for (const path of ["/.well-known/databricks-config", "/oidc/.well-known/oauth-authorization-server"]) {
      try {
        const r = await fetch(`${this.host}${path}`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        if (path.includes("databricks-config")) {
          const meta = (await r.json()) as { oidc_endpoint?: string };
          if (!meta.oidc_endpoint) continue;
          const ep = await fetch(meta.oidc_endpoint, { signal: AbortSignal.timeout(5000) });
          if (!ep.ok) continue;
          const oidc = (await ep.json()) as { token_endpoint?: string };
          if (oidc.token_endpoint) { this.tokenEndpoint = oidc.token_endpoint; return; }
        } else {
          const oidc = (await r.json()) as { token_endpoint?: string };
          if (oidc.token_endpoint) { this.tokenEndpoint = oidc.token_endpoint; return; }
        }
      } catch { /* try next */ }
    }
    throw new Error("OIDC discovery failed — verify workspace URL");
  }

  private async discoverAzureTenant(): Promise<string> {
    if (this.cache) return ""; // not cached means we haven't succeeded yet
    const tenant = process.env["DATABRICKS_AZURE_TENANT_ID"] ?? "";
    if (tenant) return tenant;
    for (const path of ["/aad/auth", "/oidc/v1/authorize"]) {
      try {
        const r = await fetch(`${this.host}${path}`, {
          method: "GET", redirect: "manual", signal: AbortSignal.timeout(10000),
        });
        const location = r.headers.get("location") ?? r.headers.get("Location") ?? "";
        const m = location.match(/login\.microsoftonline\.com\/([^/?]+)/);
        if (m?.[1]) return m[1];
      } catch { /* try next */ }
    }
    return "";
  }

  private async basicAuthExchange(url: string): Promise<string> {
    // Same as Python SDK's requests.HTTPBasicAuth — no URL-encoding
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "all-apis" }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    return this.parseTokenResponse(r, "basic");
  }

  private async parseTokenResponse(resp: Response, label = ""): Promise<string> {
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Databricks OAuth failed${label ? ` [${label}]` : ""} (HTTP ${resp.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };
    const token = json.access_token;
    if (!token) throw new Error("Databricks OAuth: no access_token in response");
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.cache = { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
    return token;
  }
}

export function isDatabricksHost(host: string): boolean {
  return /databricks|cloud\.databricks/i.test(host);
}
