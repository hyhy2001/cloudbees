/**
 * Databricks OAuth 2.0 client-credentials provider for `bee ask`.
 *
 * Databricks workspaces that require OAuth M2M (machine-to-machine) auth use
 * client_id + client_secret instead of a personal access token (PAT). This
 * provider handles the token exchange automatically:
 *
 *   1. POST /oidc/v1/token with grant_type=client_credentials, scoped to
 *      `all-apis` (covers model serving endpoints).
 *   2. Cache the returned access_token for its stated `expires_in` seconds
 *      (typically 3600 s), minus a 60 s safety margin.
 *   3. On every `generate()` call, check the cache — refresh only when expired.
 *   4. Call the model serving endpoint with `Authorization: Bearer <token>`.
 *
 * The token lives only in memory (one process, one `bee ask` invocation). There
 * is no on-disk token cache: CLI processes are short-lived and the OIDC exchange
 * adds ~100–200 ms, which is negligible relative to LLM latency.
 */
import { SYSTEM_PROMPT } from "../context";

interface TokenCache {
  token: string;
  expiresAt: number; // ms epoch
}

export class DatabricksOAuthProvider {
  public readonly name = "databricks-oauth";

  private cache: TokenCache | null = null;

  public constructor(
    /** Base URL of the Databricks workspace, e.g. https://adb-xxx.azuredatabricks.net */
    private readonly workspaceUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly model: string,
  ) {}

  /** Attempt a token exchange. Returns true on success, false on failure. */
  async validate(): Promise<boolean> {
    try {
      await this.getToken();
      return true;
    } catch {
      return false;
    }
  }

  async generate(prompt: string): Promise<string> {
    const token = await this.getToken();
    const base = this.workspaceUrl.replace(/\/$/, "");

    const response = await fetch(`${base}/serving-endpoints/${encodeURIComponent(this.model)}/invocations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 256,
      }),
        signal: AbortSignal.timeout(60000),
    }).catch(() => {
      // Fallback: try OpenAI-compatible path if serving-endpoints 404s
      return fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: 256,
        }),
        signal: AbortSignal.timeout(60000),
      });
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Databricks LM HTTP ${response.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content?.trim() ?? "";
  }

  // ── Token management ──────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.token;
    }
    return this.fetchToken();
  }

  private async fetchToken(): Promise<string> {
    const base = this.workspaceUrl.replace(/\/$/, "");
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    const resp = await fetch(`${base}/oidc/v1/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "all-apis",
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Databricks OAuth token exchange failed (HTTP ${resp.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    const json = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    const token = json.access_token;
    if (!token) throw new Error("Databricks OAuth: no access_token in response");

    // Cache with 60 s safety margin so we never send an almost-expired token
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.cache = {
      token,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
    };

    return token;
  }
}
